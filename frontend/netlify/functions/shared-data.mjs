import { timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const store = getStore({
  name: "cedarbite-shared-pilot",
  region: "ap-southeast-1",
  consistency: "strong",
});

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0, must-revalidate" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const transitions = { SUBMITTED: "ACCEPTED", ACCEPTED: "PREPARING", PREPARING: "READY", READY: "COLLECTED" };

function safeEqual(left, right) {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function managerConfigured() {
  return Boolean(process.env.CANTEEN_DASHBOARD_PASSWORD?.trim());
}

function isManager(request) {
  return managerConfigured() && safeEqual(
    request.headers.get("x-canteen-password"),
    process.env.CANTEEN_DASHBOARD_PASSWORD,
  );
}

async function readByPrefix(prefix) {
  const { blobs } = await store.list({ prefix });
  const records = await Promise.all(blobs.map(({ key }) => store.get(key, { type: "json", consistency: "strong" })));
  return records.filter(Boolean);
}

async function migrateLegacyQueue() {
  const marker = "meta/active-queue-v1";
  if (await store.get(marker, { type: "json", consistency: "strong" })) return;
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
        const { blobs } = await store.list({ prefix: "availability/" });
        const pairs = await Promise.all(blobs.map(async ({ key }) => [key.slice("availability/".length), await store.get(key, { type: "json", consistency: "strong" })]));
        return reply({ availability: Object.fromEntries(pairs.filter(([, value]) => typeof value === "boolean")) });
      }
      if (url.searchParams.get("scope") === "menu") {
        const menu = await store.get("menu/catalog", { type: "json", consistency: "strong" });
        return reply({ categories: Array.isArray(menu?.categories) ? menu.categories : null });
      }
      if (url.searchParams.get("scope") === "queue") {
        if (!managerConfigured()) return reply({ error: "Canteen access has not been configured yet." }, 503);
        if (!isManager(request)) return reply({ error: "Canteen sign-in is required to view orders." }, 401);
        await migrateLegacyQueue();
        const orders = await readByPrefix("queue/");
        orders.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
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
      if (!managerConfigured()) return reply({ error: "Canteen access has not been configured yet." }, 503);
      const expectedUser = process.env.CANTEEN_DASHBOARD_USERNAME || "manager";
      if (!safeEqual(String(body.username ?? ""), expectedUser) || !safeEqual(String(body.password ?? ""), process.env.CANTEEN_DASHBOARD_PASSWORD)) {
        return reply({ error: "The canteen username or password is incorrect." }, 401);
      }
      return reply({ ok: true });
    }

    if (body.action === "create-order") {
      const order = body.order;
      if (!order || typeof order !== "object" || typeof order.id !== "string" || order.id.length > 80 || !/^CB[A-F0-9]{6}$/.test(order.pickup_code ?? "")) return reply({ error: "Order details are invalid." }, 400);
      if (order.student_id != null && !/^\d{7}$/.test(String(order.student_id))) return reply({ error: "Student ID must contain seven digits." }, 400);
      if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 30 || order.items.some((item) => typeof item.name !== "string" || item.name.length > 120 || !Number.isSafeInteger(item.item_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20)) return reply({ error: "Order items are invalid." }, 400);
      for (const item of order.items) {
        const available = await store.get(`availability/${item.item_id}`, { type: "json", consistency: "strong" });
        if (available === false) return reply({ error: `${item.name} is currently unavailable. Remove it from your bucket and try again.` }, 409);
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
      };
      await store.setJSON(`queue/${saved.id}`, saved);
      const studentOrder = { ...saved };
      delete studentOrder.student_id;
      return reply({ order: studentOrder }, 201);
    }

    if (!managerConfigured()) return reply({ error: "Canteen access has not been configured yet." }, 503);
    if (!isManager(request)) return reply({ error: "Canteen sign-in is required to change shared data." }, 401);

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
      const order = await store.get(key, { type: "json", consistency: "strong" });
      if (!order) return reply({ error: "Order not found." }, 404);
      if (transitions[order.status] !== body.status) return reply({ error: "That order status change is not allowed." }, 409);
      const updated = { ...order, status: body.status };
      if (body.status === "COLLECTED") await store.delete(key);
      else await store.setJSON(key, updated);
      return reply({ order: updated });
    }

    return reply({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error("CedarBite shared data request failed", error);
    return reply({ error: "Shared orders are temporarily unavailable. Please retry." }, 500);
  }
};
