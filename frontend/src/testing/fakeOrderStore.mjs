// Test stand-in for shared/order-store.mjs: an in-memory orders table with the same behaviour.
import { vi } from "vitest";

export class OrderStoreError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}

export const rows = new Map();
const copy = (value) => structuredClone(value);
const byCreated = (a, b) => String(a.created_at).localeCompare(String(b.created_at));

export const getOrder = vi.fn(async (id) => (rows.has(String(id)) ? copy(rows.get(String(id))) : null));
const finished = (o) => o.status === "COLLECTED" || o.status === "CANCELLED";
const voided = (o) => o.status === "VOIDED";
export const listActive = vi.fn(async () => [...rows.values()].filter((o) => !finished(o) && !voided(o)).sort(byCreated).map(copy));
export const listHistory = vi.fn(async (limit = 100) => [...rows.values()].filter((o) => finished(o) && !voided(o))
  .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? ""))).slice(0, limit).map(copy));
export const listAll = vi.fn(async () => [...rows.values()].sort(byCreated).map(copy));
export const listForCustomer = vi.fn(async (userId, email, limit = 100) => [...rows.values()].filter((o) => o.customer_user_id === userId || String(o.customer_email ?? "").toLowerCase() === String(email ?? "").toLowerCase())
  .sort((a, b) => byCreated(b, a)).slice(0, limit).map(copy));
export const insertOrder = vi.fn(async (order) => {
  if (rows.has(String(order.id))) return false;
  rows.set(String(order.id), copy(order));
  return true;
});
export const createOrderAtomic = vi.fn(async (order) => {
  if (rows.has(String(order.id))) return { order: copy(rows.get(String(order.id))), duplicate: true };
  const saved = order.payment_method === "wallet" ? { ...order, payment_status: "PAID" } : order;
  rows.set(String(saved.id), copy(saved));
  return { order: copy(saved), duplicate: false };
});
export const updateOrder = vi.fn(async (order, { expectedStatus } = {}) => {
  const current = rows.get(String(order.id));
  if (!current || (expectedStatus && current.status !== expectedStatus)) return null;
  rows.set(String(order.id), copy(order));
  return copy(order);
});
export const deleteOrder = vi.fn(async (id) => rows.delete(String(id)));
export const voidOrder = vi.fn(async (id, actor, reason, allowedStatuses) => {
  const current = rows.get(String(id));
  if (!current || !allowedStatuses.includes(current.status)) return null;
  const updated = { ...current, status: "VOIDED", completed_at: new Date().toISOString(), voided_at: new Date().toISOString(), voided_by: actor, void_reason: reason, voided_previous_status: current.status };
  rows.set(String(id), updated);
  return copy(updated);
});
export const restoreOrder = vi.fn(async (id) => {
  const current = rows.get(String(id));
  if (!current || current.status !== "VOIDED") return null;
  const updated = { ...current, status: current.voided_previous_status };
  delete updated.voided_at;
  delete updated.voided_by;
  delete updated.void_reason;
  delete updated.voided_previous_status;
  rows.set(String(id), updated);
  return copy(updated);
});
export const importOrders = vi.fn(async (list) => {
  for (const order of list) if (order?.id != null && !rows.has(String(order.id))) rows.set(String(order.id), copy(order));
  return list.length;
});

export function reset() {
  rows.clear();
  for (const fn of [getOrder, listActive, listHistory, listAll, listForCustomer, insertOrder, createOrderAtomic, updateOrder, deleteOrder, voidOrder, restoreOrder, importOrders]) fn.mockClear();
}
