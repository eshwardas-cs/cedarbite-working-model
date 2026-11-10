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
export const listActive = vi.fn(async () => [...rows.values()].filter((o) => !finished(o)).sort(byCreated).map(copy));
export const listHistory = vi.fn(async (limit = 100) => [...rows.values()].filter(finished)
  .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? ""))).slice(0, limit).map(copy));
export const listAll = vi.fn(async () => [...rows.values()].sort(byCreated).map(copy));
export const listForCustomer = vi.fn(async (userId, limit = 100) => [...rows.values()].filter((o) => o.customer_user_id === userId)
  .sort((a, b) => byCreated(b, a)).slice(0, limit).map(copy));
export const insertOrder = vi.fn(async (order) => {
  if (rows.has(String(order.id))) return false;
  rows.set(String(order.id), copy(order));
  return true;
});
export const updateOrder = vi.fn(async (order, { expectedStatus } = {}) => {
  const current = rows.get(String(order.id));
  if (!current || (expectedStatus && current.status !== expectedStatus)) return null;
  rows.set(String(order.id), copy(order));
  return copy(order);
});
export const deleteOrder = vi.fn(async (id) => rows.delete(String(id)));
export const importOrders = vi.fn(async (list) => {
  for (const order of list) if (order?.id != null && !rows.has(String(order.id))) rows.set(String(order.id), copy(order));
  return list.length;
});

export function reset() {
  rows.clear();
  for (const fn of [getOrder, listActive, listHistory, listAll, listForCustomer, insertOrder, updateOrder, deleteOrder, importOrders]) fn.mockClear();
}
