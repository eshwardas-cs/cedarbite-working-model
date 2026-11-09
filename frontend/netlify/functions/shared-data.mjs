import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import * as menuStore from "../../shared/menu-store.mjs";
import { listPickupWindows, validScheduledPickupWindow } from "../../shared/pickup-window-validation.mjs";

const store = getStore({
  name: "cedarbite-shared-pilot",
  region: "ap-southeast-1",
  consistency: "strong",
});

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0, must-revalidate" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const transitions = { SUBMITTED: "PREPARING", ACCEPTED: "READY", PREPARING: "READY", READY: "COLLECTED" };
const reportDayKey = (value) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
const reportHour = (value) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", hourCycle: "h23" }).format(value));
const orderDay = (value) => Number.isFinite(Date.parse(value)) ? reportDayKey(new Date(value)) : "";
function validReportDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function orderTotalPaisa(order) {
  if (Number.isSafeInteger(order.total_paisa) && order.total_paisa >= 0) return order.total_paisa;
  const match = String(order.total_display ?? "").match(/([\d,]+)(?:\.([\d]{1,2}))?/);
  if (!match) return 0;
  return Number(match[1].replaceAll(",", "")) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
function dailySalesSummary(date, orders) {
  const unique = [...new Map(orders.filter((order) => order?.id != null).map((order) => [String(order.id), order])).values()];
  const placed = unique.filter((order) => orderDay(order.created_at) === date);
  const paid = unique.filter((order) => order.payment_status === "PAID" && orderDay(order.cash_received_at || order.paid_at || order.created_at) === date);
  const itemCounts = new Map();
  const methods = new Map();
  const hourly = new Map();
  let paidSalesPaisa = 0;
  let paidUnits = 0;
  for (const order of paid) {
    const timestamp = order.cash_received_at || order.paid_at || order.created_at;
    const amount = orderTotalPaisa(order);
    paidSalesPaisa += amount;
    const method = String(order.payment_method || "unknown").toLowerCase();
    const methodStats = methods.get(method) || { method, count: 0, amount_paisa: 0 };
    methodStats.count += 1;
    methodStats.amount_paisa += amount;
    methods.set(method, methodStats);
    const hour = reportHour(new Date(timestamp));
    hourly.set(hour, (hourly.get(hour) || 0) + amount);
    for (const line of Array.isArray(order.items) ? order.items : []) {
      if (typeof line.name !== "string" || !Number.isInteger(line.quantity) || line.quantity < 1) continue;
      const entry = itemCounts.get(line.name) || { name: line.name, quantity: 0 };
      entry.quantity += line.quantity;
      paidUnits += line.quantity;
      itemCounts.set(line.name, entry);
    }
  }
  return {
    date,
    generated_at: new Date().toISOString(),
    orders_placed: placed.length,
    placed_order_value_paisa: placed.reduce((sum, order) => sum + orderTotalPaisa(order), 0),
    pending_payment_orders: placed.filter((order) => order.payment_status !== "PAID").length,
    paid_orders: paid.length,
    paid_sales_paisa: paidSalesPaisa,
    units_sold: paidUnits,
    items_sold: [...itemCounts.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)),
    payment_methods: [...methods.values()].sort((a, b) => b.amount_paisa - a.amount_paisa),
    hourly_sales: [...hourly.entries()].map(([hour, amount_paisa]) => ({ hour, amount_paisa })).sort((a, b) => a.hour - b.hour),
  };
}
function safeEqual(left, right) {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function retryRead(operation) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
  throw lastError;
}

const readJSON = (key) => retryRead(() => store.get(key, { type: "json", consistency: "strong" }));
const listBlobs = (prefix) => retryRead(() => store.list({ prefix }));

const staffSettings = {
  order_manager: { username: () => process.env.CANTEEN_DASHBOARD_USERNAME || "manager", password: () => process.env.CANTEEN_DASHBOARD_PASSWORD },
  order_taker: { username: () => process.env.CANTEEN_COUNTER_USERNAME || "counter", password: () => process.env.CANTEEN_COUNTER_PASSWORD },
  cashier: { username: () => process.env.CANTEEN_CASHIER_USERNAME || "cashdesk", password: () => process.env.CANTEEN_CASHIER_PASSWORD },
  kitchen: { username: () => process.env.CANTEEN_KITCHEN_USERNAME || "kitchenmonitor", password: () => process.env.CANTEEN_KITCHEN_PASSWORD },
};

async function stationPassword(station) {
  try { return await readJSON(`staff-passwords/${station}`); }
  catch (error) {
    console.error("CedarBite station password override could not be read; using the configured environment password if available.", { station, error });
    return null;
  }
}

async function staffConfigured(station) {
  return Boolean(staffSettings[station]?.password()?.trim() || await stationPassword(station));
}

async function passwordMatches(station, candidate) {
  const config = staffSettings[station];
  if (!config) return false;
  const saved = await stationPassword(station);
  if (saved?.salt && saved?.hash) {
    const actual = scryptSync(candidate, Buffer.from(saved.salt, "base64"), 64);
    const expected = Buffer.from(saved.hash, "base64");
    if (expected.length === actual.length && timingSafeEqual(actual, expected)) return true;

    // Netlify environment values are the recovery source when a station's
    // saved reset password is stale. Clear that override after a successful
    // recovery so the old saved password stops working.
    const environmentPassword = config.password();
    if (environmentPassword && safeEqual(candidate, environmentPassword)) {
      try { await store.delete(`staff-passwords/${station}`); }
      catch (error) { console.error("CedarBite could not clear a recovered station password override.", { station, error }); }
      return true;
    }
    return false;
  }
  return Boolean(config.password()?.trim() && safeEqual(candidate, config.password()));
}

function passwordRecord(password) {
  const salt = randomBytes(16);
  return { salt: salt.toString("base64"), hash: scryptSync(password, salt, 64).toString("base64"), updated_at: new Date().toISOString() };
}

function validNewPassword(value) {
  return typeof value === "string" && value.length >= 12 && value.length <= 128;
}

async function isStaff(request, station) {
  const config = staffSettings[station];
  return Boolean(config && await staffConfigured(station) && request.headers.get("x-canteen-role") === station &&
    safeEqual(request.headers.get("x-canteen-username"), config.username()) &&
    await passwordMatches(station, request.headers.get("x-canteen-password") ?? ""));
}

const managerConfigured = async () => staffConfigured("order_manager");
const isManager = async (request) => isStaff(request, "order_manager");
const stationLabel = { order_manager: "order control", order_taker: "counter orders", cashier: "cash desk", kitchen: "kitchen monitor" };

async function readByPrefix(prefix) {
  const { blobs } = await listBlobs(prefix);
  const records = await Promise.all(blobs.map(({ key }) => readJSON(key).catch((error) => {
    console.error("CedarBite skipped an unreadable shared record.", { key, error });
    return null;
  })));
  return records.filter(Boolean);
}

function priceSharedOrderLines(catalog, lines, mode) {
  if (!Array.isArray(catalog?.categories)) return { error: "The canteen menu is not ready. Refresh the menu and try again." };
  const menuItems = new Map(catalog.categories.flatMap((category) => category.items ?? []).map((item) => [String(item.id), item]));
  let total_paisa = 0;
  const priced = [];
  for (const line of lines) {
    const item = menuItems.get(String(line.item_id));
    if (!item || item.available === false) return { error: `${line.name} is no longer available. Refresh the menu and try again.` };
    if (mode === "QUICK" && !item.quick_allowed || mode === "SCHEDULED" && !item.scheduled_allowed && !item.quick_allowed) return { error: `${item.name} is not available for this order type.` };
    const addon_selected = line.addon_selected === true;
    if (addon_selected && !item.addon_name) return { error: `The optional extra for ${item.name} is no longer available. Refresh your bucket.` };
    const addonPrice = addon_selected ? Number(item.addon_price_paisa ?? 0) : 0;
    if (!Number.isSafeInteger(addonPrice) || addonPrice < 0) return { error: `The optional extra price for ${item.name} is invalid.` };
    const unit_price_paisa = Number(item.price_paisa) + addonPrice;
    if (!Number.isSafeInteger(unit_price_paisa) || unit_price_paisa < 0) return { error: `The price for ${item.name} is invalid.` };
    const name = `${item.name}${addon_selected ? ` + ${item.addon_name}` : ""}`;
    total_paisa += unit_price_paisa * line.quantity;
    priced.push({ item_id: item.id, name, quantity: line.quantity, unit_price_paisa, addon_selected });
  }
  return { items: priced, total_paisa, total_display: `Rs ${Math.round(total_paisa / 100).toLocaleString("en-PK")}` };
}

async function migrateLegacyQueue() {
  const marker = "meta/active-queue-v1";
  if (await readJSON(marker)) return;
  const legacyOrders = await readByPrefix("orders/");
  await Promise.all(legacyOrders
    .filter((order) => order.status !== "COLLECTED")
    .map((order) => store.setJSON(`queue/${order.id}`, order)));
  await store.setJSON(marker, true);
}

export default async (request) => {
  let operation = request.method === "GET" ? "load shared canteen data" : "save shared canteen data";
  try {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.searchParams.get("scope") === "student-order") {
        const id = String(url.searchParams.get("id") ?? "");
        const pickupCode = String(url.searchParams.get("pickup_code") ?? "");
        if (!/^[a-f0-9-]{36}$/i.test(id) || !/^CB[A-F0-9]{6}$/.test(pickupCode)) return reply({ error: "Order details are invalid." }, 400);
        const order = await readJSON(`queue/${id}`) || await readJSON(`history/${id}`);
        if (!order || order.pickup_code !== pickupCode) return reply({ order: null });
        const studentOrder = { ...order };
        delete studentOrder.student_id;
        return reply({ order: studentOrder });
      }
      if (url.searchParams.get("scope") === "ordering-status") {
        const settings = await readJSON("settings/ordering") || { paused: false };
        return reply({ paused: settings.paused === true });
      }
      if (url.searchParams.get("scope") === "deals") {
        const deals = await readJSON("menu/deals");
        return reply({ deals: Array.isArray(deals) ? deals : null });
      }
      if (url.searchParams.get("scope") === "student-wallet") {
        const studentId = String(url.searchParams.get("student_id") ?? "");
        if (!/^\d{7}$/.test(studentId)) return reply({ error: "Enter a valid Cedar student ID." }, 400);
        const wallet = await readJSON(`wallets/${studentId}`) || { entries: [] };
        const entries = (Array.isArray(wallet.entries) ? wallet.entries : []).filter((entry) => entry?.kind === "credit").slice(0, 200);
        return reply({ entries });
      }
      if (url.searchParams.get("scope") === "availability") {
        const catalog = await menuStore.readCatalog();
        return reply({ availability: Object.fromEntries(catalog.categories.flatMap((category) => category.items).map((item) => [String(item.id), item.available])) });
      }
      if (url.searchParams.get("scope") === "menu") {
        return reply({ categories: (await menuStore.readCatalog()).categories });
      }
      if (url.searchParams.get("scope") === "pickup-windows") {
        const orders = await readByPrefix("queue/");
        return reply({ windows: listPickupWindows(orders) });
      }
      if (url.searchParams.get("scope") === "counter-order") {
        if (!await staffConfigured("order_taker")) return reply({ error: "The counter orders login is not configured yet." }, 503);
        if (!await isStaff(request, "order_taker")) return reply({ error: "Sign in to the counter orders station to check this order." }, 401);
        const id = String(url.searchParams.get("id") ?? "");
        if (!id || id.length > 80) return reply({ error: "Order ID is invalid." }, 400);
        const order = await readJSON(`queue/${id}`) || await readJSON(`history/${id}`);
        return reply({ order: order ?? null });
      }
      if (["sales-dates", "sales-summary"].includes(url.searchParams.get("scope"))) {
        if (!await staffConfigured("order_manager")) return reply({ error: "The order manager login is not configured yet." }, 503);
        if (!await isStaff(request, "order_manager")) return reply({ error: "Sign in to the order manager station to view sales summaries." }, 401);
        await migrateLegacyQueue();
        const today = reportDayKey(new Date());
        const [queue, history] = await Promise.all([readByPrefix("queue/"), readByPrefix("history/")]);
        const allOrders = [...queue, ...history];
        if (url.searchParams.get("scope") === "sales-dates") {
          const reports = await readByPrefix("sales/daily/");
          const removedReports = await readByPrefix("sales/removed/");
          const removedDates = new Set(removedReports.map((report) => report.date));
          const dates = new Set([today, ...reports.map((report) => report.date)]);
          for (const order of allOrders) {
            const createdDate = orderDay(order.created_at);
            if (createdDate) dates.add(createdDate);
            if (order.payment_status === "PAID") {
              const paidDate = orderDay(order.cash_received_at || order.paid_at || order.created_at);
              if (paidDate) dates.add(paidDate);
            }
          }
          return reply({ dates: [...dates].filter((date) => validReportDay(date) && date <= today && !removedDates.has(date)).sort((a, b) => b.localeCompare(a)) });
        }
        const date = url.searchParams.get("date");
        if (!validReportDay(date) || date > today) return reply({ error: "Choose a valid report date up to today." }, 400);
        if (await readJSON(`sales/removed/${date}`)) return reply({ error: "This daily summary has been removed." }, 404);
        const reportKey = `sales/daily/${date}`;
        const savedReport = await readJSON(reportKey);
        if (date !== today && savedReport) return reply({ report: savedReport });
        const report = dailySalesSummary(date, allOrders);
        await store.setJSON(reportKey, report);
        return reply({ report });
      }
      if (["queue", "cash-desk", "kitchen", "history", "wallet-history"].includes(url.searchParams.get("scope"))) {
        const scope = url.searchParams.get("scope");
        const station = scope === "cash-desk" || scope === "wallet-history" ? "cashier" : scope === "kitchen" ? "kitchen" : "order_manager";
        if (!await staffConfigured(station)) return reply({ error: `The ${stationLabel[station]} login is not configured yet.` }, 503);
        if (!await isStaff(request, station)) return reply({ error: `Sign in to the ${stationLabel[station]} station to view this information.` }, 401);
        await migrateLegacyQueue();
        if (scope === "wallet-history") {
          const entries = await readByPrefix("wallet-topups/");
          entries.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          return reply({ entries: entries.slice(0, 200) });
        }
        let orders = await readByPrefix(scope === "history" ? "history/" : "queue/");
        if (scope === "cash-desk") orders = orders.filter((order) => order.payment_method === "cash" && order.payment_status !== "PAID" && order.status !== "COLLECTED");
        if (scope === "kitchen") orders = orders.filter((order) => order.status === "PREPARING").map(({ student_id, payment_method, payment_status, ...order }) => order);
        if (scope === "history") orders.sort((a, b) => Date.parse(b.completed_at ?? b.created_at) - Date.parse(a.completed_at ?? a.created_at));
        else orders.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        return reply({ orders: orders.slice(0, 100) });
      }
      return reply({ error: "Unknown request." }, 404);
    }

    if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
    const raw = await request.text();
    if (raw.length > 4_000_000) return reply({ error: "Request is too large." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return reply({ error: "Invalid JSON." }, 400); }
    if (typeof body.action === "string") operation = body.action;

    if (body.action === "login") {
      const station = typeof body.station === "string" ? body.station : "order_manager";
      const config = staffSettings[station];
      if (!config) return reply({ error: "Choose a valid canteen station." }, 400);
      if (!await staffConfigured(station)) return reply({ error: `The ${stationLabel[station]} login is not configured yet. Add its password in Netlify environment variables.` }, 503);
      if (!safeEqual(String(body.username ?? "").trim(), config.username()) || !await passwordMatches(station, String(body.password ?? ""))) return reply({ error: "That station username or password is incorrect." }, 401);
      return reply({ ok: true, station, username: config.username() });
    }

    if (body.action === "change-password") {
      const station = String(body.station ?? "");
      if (!staffSettings[station]) return reply({ error: "Choose a valid staff station." }, 400);
      if (station === "order_manager") return reply({ error: "Change the order manager password in Netlify environment variables so the manager account retains its recovery path." }, 400);
      if (!validNewPassword(body.new_password)) return reply({ error: "Use a new password between 12 and 128 characters." }, 400);
      if (!await isStaff(request, station)) return reply({ error: "Your station session could not be verified. Sign in again and retry." }, 401);
      await store.setJSON(`staff-passwords/${station}`, passwordRecord(body.new_password));
      return reply({ ok: true, station });
    }

    if (body.action === "reset-station-password") {
      const station = String(body.station ?? "");
      if (!["order_taker", "cashier", "kitchen"].includes(station)) return reply({ error: "Choose a staff station that the order manager can reset." }, 400);
      if (!validNewPassword(body.new_password)) return reply({ error: "Use a new password between 12 and 128 characters." }, 400);
      if (!await isManager(request)) return reply({ error: "Only the order manager can reset another station password." }, 401);
      await store.setJSON(`staff-passwords/${station}`, passwordRecord(body.new_password));
      return reply({ ok: true, station });
    }

    if (body.action === "create-order") {
      const order = body.order;
      if (!order || typeof order !== "object" || typeof order.id !== "string" || order.id.length > 80 || !/^CB[A-F0-9]{6}$/.test(order.pickup_code ?? "")) return reply({ error: "Order details are invalid." }, 400);
      const existingOrder = await readJSON(`queue/${order.id}`) || await readJSON(`history/${order.id}`);
      if (existingOrder) {
        if (existingOrder.pickup_code !== order.pickup_code || String(existingOrder.student_id ?? "") !== String(order.student_id ?? "")) return reply({ error: "This order reference is already in use." }, 409);
        const studentOrder = { ...existingOrder };
        delete studentOrder.student_id;
        return reply({ order: studentOrder, duplicate: true });
      }
      const orderingSettings = await readJSON("settings/ordering");
      if (orderingSettings?.paused === true) return reply({ error: "We are currently not accepting orders." }, 409);
      if (order.mode !== "QUICK" && order.mode !== "SCHEDULED") return reply({ error: "Order type is invalid." }, 400);
      if (order.mode === "SCHEDULED" && !validScheduledPickupWindow(order.pickup_window)) return reply({ error: "Choose a valid 10-minute pickup slot at least 10 minutes ahead, between 8:00 AM and 4:00 PM Pakistan time." }, 400);
      if (order.mode === "QUICK" && order.pickup_window != null) return reply({ error: "Quick Orders do not use a scheduled pickup slot." }, 400);
      if (order.student_id != null && !/^\d{7}$/.test(String(order.student_id))) return reply({ error: "Student ID must contain seven digits." }, 400);
      if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 30 || order.items.some((item) => typeof item.name !== "string" || item.name.length > 120 || !Number.isSafeInteger(item.item_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 || (item.unit_price_paisa != null && (!Number.isSafeInteger(item.unit_price_paisa) || item.unit_price_paisa < 0)) || (item.addon_selected != null && typeof item.addon_selected !== "boolean"))) return reply({ error: "Order items are invalid." }, 400);
      const catalog = await menuStore.readCatalog();
      const menuItemsById = new Map(catalog.categories.flatMap((category) => category.items).map((item) => [String(item.id), item]));
      const unavailableItem = order.items.find((item) => menuItemsById.get(String(item.item_id))?.available === false);
      if (unavailableItem) return reply({ error: `${unavailableItem.name} is currently unavailable. Remove it from your bucket and try again.` }, 409);
      if (order.mode === "SCHEDULED") {
        const activeOrders = await readByPrefix("queue/");
        const slotAvailable = listPickupWindows(activeOrders).some((window) => Date.parse(window.start_at) === Date.parse(order.pickup_window.start_at));
        if (!slotAvailable) return reply({ error: "That pickup slot is full or no longer available. Choose another 10-minute slot." }, 409);
      }
      const dealIds = order.deal_ids ?? [];
      if (!Array.isArray(dealIds) || dealIds.length > 20 || dealIds.some((id) => typeof id !== "string" || id.length > 80)) return reply({ error: "Deal details are invalid." }, 400);
      const savedDeals = await readJSON("menu/deals") || [];
      const remainingQuantities = new Map();
      for (const line of order.items) remainingQuantities.set(line.item_id, (remainingQuantities.get(line.item_id) || 0) + line.quantity);
      let dealDiscountPaisa = 0;
      for (const dealId of dealIds) {
        const deal = savedDeals.find((entry) => entry.id === dealId && entry.active === true);
        if (!deal || !Array.isArray(deal.item_ids) || !deal.item_ids.length) return reply({ error: "This deal is no longer available. Refresh the menu and try again." }, 409);
        let regularDealTotal = 0;
        for (const itemId of deal.item_ids) {
          const item = catalog?.categories?.flatMap((category) => category.items ?? []).find((entry) => entry.id === itemId);
          if (!item || item.available === false || (remainingQuantities.get(itemId) || 0) < 1) return reply({ error: "Add every item in the deal to your bucket before placing the order." }, 409);
          remainingQuantities.set(itemId, remainingQuantities.get(itemId) - 1);
          regularDealTotal += item.price_paisa;
        }
        if (deal.price_paisa != null) {
          if (!Number.isSafeInteger(deal.price_paisa) || deal.price_paisa < 0) return reply({ error: "The deal price is invalid. Ask the canteen manager to update it." }, 409);
          dealDiscountPaisa += Math.max(0, regularDealTotal - deal.price_paisa);
        }
      }
      const pricedOrder = priceSharedOrderLines(catalog, order.items, order.mode);
      if (pricedOrder.error) return reply({ error: pricedOrder.error }, 409);
      if (dealDiscountPaisa > pricedOrder.total_paisa) return reply({ error: "The deal price could not be applied. Refresh the menu and try again." }, 409);
      const saved = {
        id: order.id,
        status: "SUBMITTED",
        mode: order.mode === "SCHEDULED" ? "SCHEDULED" : "QUICK",
        total_paisa: pricedOrder.total_paisa - dealDiscountPaisa,
        total_display: `Rs ${Math.round((pricedOrder.total_paisa - dealDiscountPaisa) / 100).toLocaleString("en-PK")}`,
        deal_discount_paisa: dealDiscountPaisa,
        deal_ids: dealIds,
        pickup_code: order.pickup_code,
        created_at: new Date().toISOString(),
        pickup_window: order.pickup_window && typeof order.pickup_window === "object" ? order.pickup_window : null,
        items: pricedOrder.items,
        waiting_minutes: 0,
        student_id: order.student_id == null ? null : String(order.student_id),
        source: "ONLINE",
        payment_method: ["cash", "wallet", "easypaisa", "jazzcash", "bank", "card"].includes(order.payment_method) ? order.payment_method : "cash",
        payment_status: order.payment_method === "wallet" ? "PAID" : order.payment_method === "cash" ? "UNPAID" : "PENDING",
      };
      await store.setJSON(`queue/${saved.id}`, saved);
      const studentOrder = { ...saved };
      delete studentOrder.student_id;
      return reply({ order: studentOrder }, 201);
    }

    if (body.action === "create-counter-order") {
      if (!await staffConfigured("order_taker")) return reply({ error: "The counter orders login is not configured yet." }, 503);
      if (!await isStaff(request, "order_taker")) return reply({ error: "Sign in to the counter orders station to place an in-person order." }, 401);
      const order = body.order;
      if (!order || typeof order !== "object" || typeof order.id !== "string" || order.id.length > 80 || !/^CB[A-F0-9]{6}$/.test(order.pickup_code ?? "")) return reply({ error: "Order details are invalid." }, 400);
      const existingOrder = await readJSON(`queue/${order.id}`) || await readJSON(`history/${order.id}`);
      if (existingOrder) return reply({ order: existingOrder, duplicate: true });
      if (order.mode !== "QUICK" && order.mode !== "SCHEDULED") return reply({ error: "Order type is invalid." }, 400);
      if (order.mode === "SCHEDULED" && !validScheduledPickupWindow(order.pickup_window)) return reply({ error: "Choose a valid 10-minute pickup slot at least 10 minutes ahead." }, 400);
      if (order.mode === "QUICK" && order.pickup_window != null) return reply({ error: "Quick Orders do not use a scheduled pickup slot." }, 400);
      const customerType = order.customer_type ?? "STUDENT";
      const studentId = order.student_id == null ? null : String(order.student_id);
      const customerName = typeof order.customer_name === "string" ? order.customer_name.trim() : "";
      if (customerType !== "STUDENT" && customerType !== "TEACHER") return reply({ error: "Choose whether the order is for a student or teacher." }, 400);
      if (customerType === "STUDENT" && !/^\d{7}$/.test(studentId ?? "")) return reply({ error: "Student ID must contain seven digits." }, 400);
      if (customerType === "TEACHER" && (!customerName || customerName.length > 100)) return reply({ error: "Enter the teacher’s name (up to 100 characters)." }, 400);
      if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 30 || order.items.some((item) => typeof item.name !== "string" || item.name.length > 120 || !Number.isSafeInteger(item.item_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 || (item.unit_price_paisa != null && (!Number.isSafeInteger(item.unit_price_paisa) || item.unit_price_paisa < 0)) || (item.addon_selected != null && typeof item.addon_selected !== "boolean"))) return reply({ error: "Order items are invalid." }, 400);
      const method = order.payment_method === "wallet" ? "wallet" : "cash";
      const pricedOrder = priceSharedOrderLines(await menuStore.readCatalog(), order.items, order.mode);
      if (pricedOrder.error) return reply({ error: pricedOrder.error }, 409);
      const saved = { id: order.id, status: "SUBMITTED", mode: order.mode, source: "COUNTER", total_paisa: pricedOrder.total_paisa, total_display: pricedOrder.total_display, pickup_code: order.pickup_code, created_at: new Date().toISOString(), pickup_window: order.pickup_window ?? null, items: pricedOrder.items, waiting_minutes: 0, customer_type: customerType, customer_name: customerType === "TEACHER" ? customerName : null, student_id: customerType === "STUDENT" ? studentId : null, payment_method: method, payment_status: method === "cash" ? "UNPAID" : "PENDING" };
      await store.setJSON(`queue/${saved.id}`, saved);
      return reply({ order: saved }, 201);
    }

    if (body.action === "student-topup-request") {
      const id = String(body.id ?? "");
      const student_id = String(body.student_id ?? "");
      const amount_paisa = Number(body.amount_paisa);
      const method = String(body.method ?? "").toLowerCase();
      if (!/^[a-f0-9-]{36}$/i.test(id) || !/^\d{7}$/.test(student_id) || !Number.isSafeInteger(amount_paisa) || amount_paisa < 10000 || amount_paisa > 500000 || !["easypaisa", "jazzcash", "bank", "card"].includes(method)) {
        return reply({ error: "Enter a valid student ID, top-up amount, and payment method." }, 400);
      }
      const key = `wallet-topups/${id}`;
      const existing = await readJSON(key);
      if (existing) return reply({ entry: existing, duplicate: true });
      const entry = {
        id,
        student_id,
        amount_paisa,
        kind: "credit",
        method,
        status: "PAYMENT_NOT_RECEIVED",
        label: "Student top-up request · payment not received",
        created_at: new Date().toISOString(),
        recorded_by: "student dashboard",
      };
      await store.setJSON(key, entry);
      return reply({ entry, duplicate: false }, 201);
    }

    if (body.action === "cash-topup") {
      if (!await staffConfigured("cashier")) return reply({ error: "The cash desk login is not configured yet." }, 503);
      if (!await isStaff(request, "cashier")) return reply({ error: "Sign in to the cash desk to record a top-up." }, 401);
      const student_id = String(body.student_id ?? "");
      const amount_paisa = Number(body.amount_paisa);
      if (!/^\d{7}$/.test(student_id) || !Number.isSafeInteger(amount_paisa) || amount_paisa < 5000 || amount_paisa > 500000) return reply({ error: "Enter a 7-digit student ID and a cash amount from Rs 50 to Rs 5,000." }, 400);
      const reference = String(body.idempotency_key ?? "");
      if (!/^[a-f0-9-]{20,80}$/i.test(reference)) return reply({ error: "A valid transaction reference is required." }, 400);
      const referenceKey = `wallet-topups/${reference}`;
      const duplicate = await readJSON(referenceKey);
      const walletKey = `wallets/${student_id}`;
      const wallet = await readJSON(walletKey) || { balance_paisa: 0, entries: [] };
      if (duplicate) return reply({ student_id, balance_paisa: wallet.balance_paisa, entry: duplicate, duplicate: true });
      const entry = { id: reference, student_id, kind: "credit", amount_paisa, method: "cash_at_counter", label: String(body.note ?? "Cash wallet top-up").slice(0, 160), created_at: new Date().toISOString(), recorded_by: request.headers.get("x-canteen-username") || "cashier" };
      const updated = { balance_paisa: wallet.balance_paisa + amount_paisa, entries: [entry, ...(Array.isArray(wallet.entries) ? wallet.entries : [])].slice(0, 200) };
      await store.setJSON(walletKey, updated);
      await store.setJSON(referenceKey, entry);
      return reply({ student_id, balance_paisa: updated.balance_paisa, entry, duplicate: false }, 201);
    }

    if (body.action === "mark-cash-paid") {
      if (!await staffConfigured("cashier")) return reply({ error: "The cash desk login is not configured yet." }, 503);
      if (!await isStaff(request, "cashier")) return reply({ error: "Sign in to the cash desk to record cash received." }, 401);
      const orderId = String(body.order_id ?? "");
      const key = `queue/${orderId}`;
      const order = await readJSON(key);
      if (!order) return reply({ error: "Order not found." }, 404);
      if (order.payment_method !== "cash") return reply({ error: "This order is not marked for cash payment." }, 409);
      if (order.payment_status === "PAID") return reply({ order, duplicate: true });
      const updated = { ...order, payment_status: "PAID", cash_received_at: new Date().toISOString(), cash_received_by: request.headers.get("x-canteen-username") || "cashier" };
      await store.setJSON(key, updated);
      return reply({ order: updated });
    }

    if (!await managerConfigured()) return reply({ error: "Canteen access has not been configured yet." }, 503);
    if (!await isManager(request)) return reply({ error: "Sign in to the order control station to change shared data." }, 401);

    if (body.action === "set-ordering") {
      if (typeof body.paused !== "boolean") return reply({ error: "Choose whether online ordering is paused." }, 400);
      await store.setJSON("settings/ordering", { paused: body.paused, updated_at: new Date().toISOString(), updated_by: request.headers.get("x-canteen-username") || "order_manager" });
      return reply({ paused: body.paused });
    }

    if (body.action === "set-deals") {
      if (!Array.isArray(body.deals) || body.deals.length > 50) return reply({ error: "Deal list is invalid." }, 400);
      const catalog = await menuStore.readCatalog();
      const catalogItems = new Map(catalog.categories.flatMap((category) => category.items ?? []).map((item) => [item.id, item]));
      const ids = new Set();
      for (const deal of body.deals) {
        if (!deal || typeof deal.id !== "string" || !deal.id || deal.id.length > 80 || ids.has(deal.id) || typeof deal.title !== "string" || !deal.title.trim() || deal.title.length > 80 || typeof deal.description !== "string" || deal.description.length > 220 || typeof deal.active !== "boolean" || !Array.isArray(deal.item_ids) || deal.item_ids.length < 1 || deal.item_ids.length > 30 || new Set(deal.item_ids).size !== deal.item_ids.length) return reply({ error: "Check the deal title, description, and selected items." }, 400);
        ids.add(deal.id);
        let regularTotal = 0;
        for (const itemId of deal.item_ids) {
          const item = catalogItems.get(itemId);
          if (!Number.isSafeInteger(itemId) || !item || item.available === false) return reply({ error: "A selected deal item is no longer available. Refresh the menu." }, 409);
          regularTotal += item.price_paisa;
        }
        if (deal.price_paisa != null && (!Number.isSafeInteger(deal.price_paisa) || deal.price_paisa < 0 || deal.price_paisa > regularTotal)) return reply({ error: "Deal price must be a valid amount no higher than the regular item total." }, 400);
      }
      await store.setJSON("menu/deals", body.deals);
      return reply({ deals: body.deals });
    }

    if (body.action === "add-menu-item") {
      const item = body.item;
      if (!item || typeof item !== "object" || !Number.isSafeInteger(item.category_id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 120 || typeof item.description !== "string" || item.description.length > 500 || !Number.isSafeInteger(item.price_paisa) || item.price_paisa < 0 || item.price_paisa > 10_000_000 || typeof item.quick_allowed !== "boolean" || typeof item.scheduled_allowed !== "boolean" || (!item.quick_allowed && !item.scheduled_allowed) || (item.prep_minutes != null && (!Number.isInteger(item.prep_minutes) || item.prep_minutes < 0 || item.prep_minutes > 240)) || (item.image_data != null && (typeof item.image_data !== "string" || item.image_data.length > 180_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image_data))) || (item.addon_name != null && (typeof item.addon_name !== "string" || !item.addon_name.trim() || item.addon_name.length > 80)) || (item.addon_price_paisa != null && (!Number.isSafeInteger(item.addon_price_paisa) || item.addon_price_paisa < 0 || item.addon_price_paisa > 10_000_000))) return reply({ error: "Menu item details are invalid. Check the name, description, price, optional add-on, image, and pickup type." }, 400);
      const addedItem = await menuStore.addItem(item);
      return reply({ categories: (await menuStore.readCatalog()).categories, item: addedItem }, 201);
    }

    if (body.action === "update-menu-item") {
      const item = body.item;
      if (!item || typeof item !== "object" || !Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.category_id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 120 || typeof item.description !== "string" || item.description.length > 500 || !Number.isSafeInteger(item.price_paisa) || item.price_paisa < 0 || item.price_paisa > 10_000_000 || typeof item.quick_allowed !== "boolean" || typeof item.scheduled_allowed !== "boolean" || (!item.quick_allowed && !item.scheduled_allowed) || (item.prep_minutes != null && (!Number.isInteger(item.prep_minutes) || item.prep_minutes < 0 || item.prep_minutes > 240)) || (item.image_data != null && (typeof item.image_data !== "string" || item.image_data.length > 180_000 || !(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image_data) || /^https:\/\/[^\s]{1,500}$/.test(item.image_data)))) || (item.addon_name != null && (typeof item.addon_name !== "string" || !item.addon_name.trim() || item.addon_name.length > 80)) || (item.addon_price_paisa != null && (!Number.isSafeInteger(item.addon_price_paisa) || item.addon_price_paisa < 0 || item.addon_price_paisa > 10_000_000))) return reply({ error: "Menu item details are invalid. Check the name, description, price, optional add-on, image, and pickup type." }, 400);
      const updatedItem = await menuStore.updateItem(item);
      return reply({ categories: (await menuStore.readCatalog()).categories, item: updatedItem });
    }

    if (body.action === "delete-sales-summary") {
      const date = String(body.date ?? "");
      const today = reportDayKey(new Date());
      if (!validReportDay(date) || date >= today) return reply({ error: "Only a previous day summary can be removed." }, 400);
      await store.setJSON(`sales/removed/${date}`, { date, removed_at: new Date().toISOString() });
      await store.delete(`sales/daily/${date}`);
      return reply({ deleted: true, date });
    }

    if (body.action === "set-menu") {
      // Only the ORDER of categories and items is saved here. Prices, removals and
      // categories have their own actions below, so one stale screen cannot undo another's change.
      const categories = body.categories;
      if (!Array.isArray(categories) || categories.length < 1 || categories.length > 30 || categories.some((category) => !Number.isSafeInteger(category?.id) || !Array.isArray(category.items) || category.items.length > 200 || category.items.some((item) => !Number.isSafeInteger(item?.id)))) return reply({ error: "Menu categories are invalid." }, 400);
      const itemIds = categories.flatMap((category) => category.items.map((item) => item.id));
      if (new Set(itemIds).size !== itemIds.length || new Set(categories.map((category) => category.id)).size !== categories.length) return reply({ error: "Menu categories are invalid." }, 400);
      await menuStore.reorderMenu(categories);
      return reply({ categories: (await menuStore.readCatalog()).categories });
    }

    if (body.action === "set-availability") {
      if (!Number.isSafeInteger(body.item_id) || typeof body.available !== "boolean") return reply({ error: "Availability details are invalid." }, 400);
      const item = await menuStore.setAvailability(body.item_id, body.available);
      return reply({ item_id: item.id, available: item.available });
    }

    if (body.action === "set-price") {
      if (!Number.isSafeInteger(body.item_id) || !Number.isSafeInteger(body.price_paisa) || body.price_paisa < 0 || body.price_paisa > 10_000_000) return reply({ error: "Enter a valid price." }, 400);
      await menuStore.setPrice(body.item_id, body.price_paisa);
      return reply({ categories: (await menuStore.readCatalog()).categories });
    }

    if (body.action === "remove-menu-item") {
      if (!Number.isSafeInteger(body.item_id)) return reply({ error: "Menu item details are invalid." }, 400);
      await menuStore.removeItem(body.item_id);
      return reply({ categories: (await menuStore.readCatalog()).categories });
    }

    if (body.action === "add-category") {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return reply({ error: "Enter a category name (up to 80 characters)." }, 400);
      if ((await menuStore.readCatalog()).categories.length >= 30) return reply({ error: "The menu has reached its 30-category limit." }, 409);
      await menuStore.addCategory(body.name);
      return reply({ categories: (await menuStore.readCatalog()).categories }, 201);
    }

    if (body.action === "remove-category") {
      if (!Number.isSafeInteger(body.category_id) || (body.target_category_id != null && !Number.isSafeInteger(body.target_category_id))) return reply({ error: "Category details are invalid." }, 400);
      await menuStore.removeCategory(body.category_id, body.target_category_id ?? null);
      return reply({ categories: (await menuStore.readCatalog()).categories });
    }

    if (body.action === "delete-order") {
      if (!await staffConfigured("order_manager")) return reply({ error: "The order control login is not configured yet." }, 503);
      if (!await isStaff(request, "order_manager")) return reply({ error: "Sign in to order control to delete a new order." }, 401);
      if (typeof body.order_id !== "string" || body.order_id.length > 80) return reply({ error: "Order details are invalid." }, 400);
      const key = `queue/${body.order_id}`;
      const order = await readJSON(key);
      if (!order) return reply({ error: "Order is no longer in the active queue." }, 404);
      if (order.status !== "SUBMITTED") return reply({ error: "Only new, unaccepted orders can be deleted." }, 409);
      await store.delete(key);
      return reply({ deleted: true, order_id: body.order_id });
    }

    if (body.action === "delete-history-order") {
      if (!await staffConfigured("order_manager")) return reply({ error: "The order control login is not configured yet." }, 503);
      if (!await isStaff(request, "order_manager")) return reply({ error: "Sign in to order control to delete an order from history." }, 401);
      if (typeof body.order_id !== "string" || body.order_id.length > 80) return reply({ error: "Order details are invalid." }, 400);
      const key = `history/${body.order_id}`;
      const order = await readJSON(key);
      if (!order) return reply({ error: "This order is no longer in order history." }, 404);
      await store.delete(key);
      return reply({ deleted: true, order_id: body.order_id });
    }

    if (body.action === "refund-order") {
      if (!await staffConfigured("order_manager")) return reply({ error: "The order control login is not configured yet." }, 503);
      if (!await isStaff(request, "order_manager")) return reply({ error: "Sign in to order control to refund an order." }, 401);
      if (typeof body.order_id !== "string" || body.order_id.length > 80) return reply({ error: "Order details are invalid." }, 400);
      const key = `history/${body.order_id}`;
      const order = await readJSON(key);
      if (!order) return reply({ error: "This completed order is no longer in order history." }, 404);
      if (order.refund_status === "REFUNDED") return reply({ order, duplicate: true });
      const method = String(order.payment_method ?? "cash").trim().toLowerCase();
      const amount = orderTotalPaisa(order);
      if (!Number.isSafeInteger(amount) || amount <= 0) return reply({ error: "This order does not have a refundable total." }, 409);
      if (method === "wallet") {
        if (!/^\d{7}$/.test(String(order.student_id ?? ""))) return reply({ error: "This wallet order is missing its student ID, so the refund cannot be credited safely." }, 409);
        const studentId = String(order.student_id);
        const refundId = `refund-${String(order.id)}`;
        const refundKey = `wallet-refunds/${String(order.id)}`;
        const walletKey = `wallets/${studentId}`;
        const wallet = await readJSON(walletKey) || { balance_paisa: 0, entries: [] };
        const walletEntries = Array.isArray(wallet.entries) ? wallet.entries : [];
        const entry = walletEntries.find((saved) => String(saved.id) === refundId) || { id: refundId, student_id: studentId, kind: "credit", amount_paisa: amount, method: "wallet_refund", label: `Refund for order ${order.pickup_code}`, created_at: new Date().toISOString(), recorded_by: request.headers.get("x-canteen-username") || "manager", status: "REFUNDED" };
        if (!walletEntries.some((saved) => String(saved.id) === refundId)) await store.setJSON(walletKey, { balance_paisa: (Number(wallet.balance_paisa) || 0) + amount, entries: [entry, ...walletEntries].slice(0, 200) });
        await store.setJSON(`wallet-topups/${refundId}`, entry);
        await store.setJSON(refundKey, entry);
      } else if (String(order.payment_status ?? "").trim().toUpperCase() !== "PAID") {
        return reply({ error: "No payment has been recorded for this order. Unpaid orders cannot be refunded." }, 409);
      }
      const updated = { ...order, refund_status: "REFUNDED", refund_method: method === "wallet" ? "wallet" : "manual", refunded_at: new Date().toISOString(), refunded_by: request.headers.get("x-canteen-username") || "manager", refund_amount_paisa: amount };
      await store.setJSON(key, updated);
      return reply({ order: updated });
    }

    if (body.action === "set-status") {
      if (typeof body.order_id !== "string" || typeof body.status !== "string") return reply({ error: "Order status details are invalid." }, 400);
      const key = `queue/${body.order_id}`;
      const order = await readJSON(key);
      if (!order) {
        const completed = await readJSON(`history/${body.order_id}`);
        if (completed && body.status === "COLLECTED") return reply({ order: completed, duplicate: true });
        return reply({ error: "Order not found." }, 404);
      }
      if (order.status === body.status) return reply({ order, duplicate: true });
      if (transitions[order.status] !== body.status) return reply({ error: "That order status change is not allowed." }, 409);
      const updated = { ...order, status: body.status };
      if (body.status === "COLLECTED") {
        const completed = { ...updated, completed_at: new Date().toISOString() };
        await store.setJSON(`history/${order.id}`, completed);
        await store.delete(key);
        return reply({ order: completed });
      }
      else await store.setJSON(key, updated);
      return reply({ order: updated });
    }

    return reply({ error: "Unknown action." }, 400);
  } catch (error) {
    if (error instanceof menuStore.MenuStoreError) return reply({ error: error.message }, error.status);
    console.error("CedarBite shared data request failed", { operation, error });
    const message = operation === "add-menu-item"
      ? "The menu item could not be saved. Refresh the menu and try again."
      : operation === "create-order"
        ? "The order could not be sent to the canteen. Your bucket is still here; please try again."
        : "CedarBite could not complete that request. Refresh and try again.";
    return reply({ error: message }, 500);
  }
};
