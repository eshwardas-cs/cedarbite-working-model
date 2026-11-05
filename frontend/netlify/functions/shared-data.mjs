import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { listPickupWindows, validScheduledPickupWindow } from "../../shared/pickup-window-validation.mjs";

const store = getStore({
  name: "cedarbite-shared-pilot",
  region: "ap-southeast-1",
  consistency: "strong",
});

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0, must-revalidate" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const transitions = { SUBMITTED: "PREPARING", ACCEPTED: "READY", PREPARING: "READY", READY: "COLLECTED" };
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
    return expected.length === actual.length && timingSafeEqual(actual, expected);
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

async function readAvailabilityOverrides() {
  const { blobs } = await listBlobs("availability/");
  const pairs = await Promise.all(blobs.map(async ({ key }) => [
    key.slice("availability/".length),
    await readJSON(key),
  ]));
  return Object.fromEntries(pairs.filter(([, value]) => typeof value === "boolean"));
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
  try {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.searchParams.get("scope") === "availability") {
        return reply({ availability: await readAvailabilityOverrides() });
      }
      if (url.searchParams.get("scope") === "menu") {
        const menu = await readJSON("menu/catalog");
        if (!Array.isArray(menu?.categories)) return reply({ categories: null });
        const availability = await readAvailabilityOverrides();
        const categories = menu.categories.map((category) => ({ ...category, items: category.items.map((item) => ({ ...item, available: availability[String(item.id)] ?? item.available })) }));
        return reply({ categories });
      }
      if (url.searchParams.get("scope") === "pickup-windows") {
        const orders = await readByPrefix("queue/");
        return reply({ windows: listPickupWindows(orders) });
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
    if (raw.length > 64_000) return reply({ error: "Request is too large." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return reply({ error: "Invalid JSON." }, 400); }

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
      if (order.mode !== "QUICK" && order.mode !== "SCHEDULED") return reply({ error: "Order type is invalid." }, 400);
      if (order.mode === "SCHEDULED" && !validScheduledPickupWindow(order.pickup_window)) return reply({ error: "Choose a valid 10-minute pickup slot at least 10 minutes ahead, between 8:00 AM and 4:00 PM Pakistan time." }, 400);
      if (order.mode === "QUICK" && order.pickup_window != null) return reply({ error: "Quick Orders do not use a scheduled pickup slot." }, 400);
      if (order.student_id != null && !/^\d{7}$/.test(String(order.student_id))) return reply({ error: "Student ID must contain seven digits." }, 400);
      if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 30 || order.items.some((item) => typeof item.name !== "string" || item.name.length > 120 || !Number.isSafeInteger(item.item_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20)) return reply({ error: "Order items are invalid." }, 400);
      const availability = await readAvailabilityOverrides();
      const unavailableItem = order.items.find((item) => availability[String(item.item_id)] === false);
      if (unavailableItem) return reply({ error: `${unavailableItem.name} is currently unavailable. Remove it from your bucket and try again.` }, 409);
      if (order.mode === "SCHEDULED") {
        const activeOrders = await readByPrefix("queue/");
        const slotAvailable = listPickupWindows(activeOrders).some((window) => Date.parse(window.start_at) === Date.parse(order.pickup_window.start_at));
        if (!slotAvailable) return reply({ error: "That pickup slot is full or no longer available. Choose another 10-minute slot." }, 409);
      }
      const saved = {
        id: order.id,
        status: "SUBMITTED",
        mode: order.mode === "SCHEDULED" ? "SCHEDULED" : "QUICK",
        total_display: typeof order.total_display === "string" ? order.total_display.slice(0, 40) : "",
        pickup_code: order.pickup_code,
        created_at: new Date().toISOString(),
        pickup_window: order.pickup_window && typeof order.pickup_window === "object" ? order.pickup_window : null,
        items: order.items.map(({ item_id, ...item }) => ({ ...item, item_id })),
        waiting_minutes: 0,
        student_id: order.student_id == null ? null : String(order.student_id),
        source: "ONLINE",
        payment_method: ["cash", "wallet", "easypaisa", "jazzcash", "bank", "card"].includes(order.payment_method) ? order.payment_method : "cash",
        payment_status: order.payment_method === "cash" ? "UNPAID" : "PENDING",
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
      if (order.mode !== "QUICK" && order.mode !== "SCHEDULED") return reply({ error: "Order type is invalid." }, 400);
      if (order.mode === "SCHEDULED" && !validScheduledPickupWindow(order.pickup_window)) return reply({ error: "Choose a valid 10-minute pickup slot at least 10 minutes ahead." }, 400);
      if (order.mode === "QUICK" && order.pickup_window != null) return reply({ error: "Quick Orders do not use a scheduled pickup slot." }, 400);
      if (order.student_id != null && !/^\d{7}$/.test(String(order.student_id))) return reply({ error: "Student ID must contain seven digits." }, 400);
      if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 30 || order.items.some((item) => typeof item.name !== "string" || item.name.length > 120 || !Number.isSafeInteger(item.item_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20)) return reply({ error: "Order items are invalid." }, 400);
      const method = order.payment_method === "wallet" ? "wallet" : "cash";
      const saved = { id: order.id, status: "SUBMITTED", mode: order.mode, source: "COUNTER", total_display: typeof order.total_display === "string" ? order.total_display.slice(0, 40) : "", pickup_code: order.pickup_code, created_at: new Date().toISOString(), pickup_window: order.pickup_window ?? null, items: order.items.map(({ item_id, ...item }) => ({ ...item, item_id })), waiting_minutes: 0, student_id: order.student_id == null ? null : String(order.student_id), payment_method: method, payment_status: method === "cash" ? "UNPAID" : "PENDING" };
      await store.setJSON(`queue/${saved.id}`, saved);
      return reply({ order: saved }, 201);
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

    if (body.action === "set-menu") {
      const categories = body.categories;
      if (!Array.isArray(categories) || categories.length < 1 || categories.length > 30 || categories.some((category) => !Number.isSafeInteger(category.id) || typeof category.name !== "string" || !category.name.trim() || category.name.length > 80 || !Array.isArray(category.items))) return reply({ error: "Menu categories are invalid." }, 400);
      const categoryIds = new Set(categories.map((category) => category.id));
      const items = categories.flatMap((category) => category.items);
      const itemIds = new Set();
      if (items.length > 200 || items.some((item) => {
        if (!Number.isSafeInteger(item.id) || itemIds.has(item.id) || !categoryIds.has(item.category_id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 120 || typeof item.description !== "string" || item.description.length > 500 || !Number.isSafeInteger(item.price_paisa) || item.price_paisa < 0 || typeof item.available !== "boolean" || typeof item.quick_allowed !== "boolean" || typeof item.scheduled_allowed !== "boolean" || (!item.quick_allowed && !item.scheduled_allowed) || (item.prep_minutes != null && (!Number.isInteger(item.prep_minutes) || item.prep_minutes < 0 || item.prep_minutes > 240))) return true;
        itemIds.add(item.id);
        return false;
      })) return reply({ error: "Menu items are invalid." }, 400);
      await store.setJSON("menu/catalog", { categories });
      return reply({ categories });
    }

    if (body.action === "set-availability") {
      if (!Number.isSafeInteger(body.item_id) || typeof body.available !== "boolean") return reply({ error: "Availability details are invalid." }, 400);
      await store.setJSON(`availability/${body.item_id}`, body.available);
      return reply({ item_id: body.item_id, available: body.available });
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
    console.error("CedarBite shared data request failed", error);
    return reply({ error: "Shared orders are temporarily unavailable. Please retry." }, 500);
  }
};
