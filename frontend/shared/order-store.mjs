// SERVER ONLY. The Netlify function uses this to read and save orders in Supabase (table public.orders,
// see supabase/migrations/0004_orders.sql). It uses the Supabase SECRET key, so it must never be
// imported by browser code (anything under src/).
//
// Each row keeps the whole order in `data`, in exactly the shape the app already uses, plus copies of
// the fields we search and sort by. Who may do what is checked in shared-data.mjs BEFORE calling this.

export class OrderStoreError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "OrderStoreError";
    this.status = status;
  }
}

function connection() {
  const url = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "")
    .trim()
    .replace(/\/rest\/v1\/?$/, "")
    .replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key) throw new OrderStoreError("The order database is not connected yet. Add SUPABASE_SECRET_KEY in Netlify, then redeploy.", 503);
  return { url, key };
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = connection();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) {
    if (data?.code === "23505") throw new OrderStoreError("DUPLICATE", 409);
    console.error("CedarBite order database request failed", { path: path.split("?")[0], status: response.status, data });
    throw new OrderStoreError("The order database could not complete that request. Please try again.", 502);
  }
  return data;
}

const validTime = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);

// The searchable copies are always taken from the order itself, so they can never disagree with it.
export function rowFromOrder(order) {
  const total = Number(order.total_paisa);
  return {
    id: String(order.id),
    pickup_code: String(order.pickup_code ?? ""),
    status: String(order.status ?? "SUBMITTED"),
    source: String(order.source ?? "ONLINE"),
    mode: String(order.mode ?? "QUICK"),
    customer_user_id: typeof order.customer_user_id === "string" ? order.customer_user_id : null,
    student_id: order.student_id == null ? null : String(order.student_id),
    total_paisa: Number.isSafeInteger(total) && total >= 0 ? total : 0,
    payment_method: order.payment_method == null ? null : String(order.payment_method),
    payment_status: order.payment_status == null ? null : String(order.payment_status),
    pickup_start_at: validTime(order.pickup_window?.start_at),
    created_at: validTime(order.created_at) ?? new Date().toISOString(),
    // Collected and cancelled orders both leave the queue; this is when they did.
    completed_at: validTime(order.completed_at) ?? validTime(order.cancelled_at),
    data: order,
  };
}

const orders = (rows) => (Array.isArray(rows) ? rows.map((row) => row.data) : []);
const idFilter = (id) => `id=eq.${encodeURIComponent(String(id))}`;

export async function getOrder(id) {
  const rows = await rest(`orders?select=data&${idFilter(id)}`);
  return rows?.[0]?.data ?? null;
}

// Orders still in the canteen queue (not collected or cancelled), oldest first.
export async function listActive() {
  return orders(await rest("orders?select=data&is_active=eq.true&order=created_at.asc"));
}

// Collected and cancelled orders, most recent first.
export async function listHistory(limit = 100) {
  return orders(await rest(`orders?select=data&is_active=eq.false&order=completed_at.desc.nullslast,created_at.desc&limit=${Number(limit)}`));
}

// Every order (for sales summaries).
export async function listAll() {
  return orders(await rest("orders?select=data&order=created_at.asc"));
}

// One signed-in person's own orders, newest first.
export async function listForCustomer(userId, limit = 100) {
  return orders(await rest(`orders?select=data&customer_user_id=eq.${encodeURIComponent(String(userId))}&order=created_at.desc&limit=${Number(limit)}`));
}

// Saves a NEW order. Returns false (and changes nothing) if that order ID already exists.
export async function insertOrder(order) {
  try {
    await rest("orders", { method: "POST", body: rowFromOrder(order), prefer: "return=minimal" });
    return true;
  } catch (error) {
    if (error instanceof OrderStoreError && error.message === "DUPLICATE") return false;
    throw error;
  }
}

// Saves changes to an existing order. With expectedStatus, it only saves if nobody changed the
// status in the meantime (two screens pressing the same button); returns the saved order or null.
export async function updateOrder(order, { expectedStatus } = {}) {
  const statusFilter = expectedStatus ? `&status=eq.${encodeURIComponent(expectedStatus)}` : "";
  const { id, ...changes } = rowFromOrder(order);
  const rows = await rest(`orders?${idFilter(id)}${statusFilter}`, { method: "PATCH", body: changes, prefer: "return=representation" });
  return rows?.[0]?.data ?? null;
}

export async function deleteOrder(id) {
  const rows = await rest(`orders?${idFilter(id)}`, { method: "DELETE", prefer: "return=representation" });
  return Array.isArray(rows) && rows.length > 0;
}

// One-time copy of orders saved before the move. Orders already in Supabase are left untouched.
export async function importOrders(list) {
  const rows = list.filter((order) => order && order.id != null).map(rowFromOrder);
  for (let start = 0; start < rows.length; start += 200) {
    await rest("orders?on_conflict=id", { method: "POST", body: rows.slice(start, start + 200), prefer: "resolution=ignore-duplicates,return=minimal" });
  }
  return rows.length;
}
