// The one-time copy of orders from Netlify storage into Supabase, the first time the new code runs.
import { describe, expect, it, vi } from "vitest";

const mockStore = vi.hoisted(() => {
  const values = new Map([
    ["queue/a", { id: "a", status: "PREPARING", pickup_code: "CB000001", created_at: "2026-11-01T08:00:00.000Z" }],
    ["history/b", { id: "b", status: "COLLECTED", pickup_code: "CB000002", created_at: "2026-10-30T08:00:00.000Z", completed_at: "2026-10-30T08:20:00.000Z" }],
  ]);
  return {
    values,
    get: vi.fn(async (key) => values.get(key) ?? null),
    setJSON: vi.fn(async (key, value) => { values.set(key, value); }),
    delete: vi.fn(async (key) => { values.delete(key); }),
    list: vi.fn(async ({ prefix }) => ({ blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) })),
  };
});
vi.mock("@netlify/blobs", () => ({ getStore: () => mockStore }));
vi.mock("../shared/order-store.mjs", () => import("./testing/fakeOrderStore.mjs"));
import * as orderDb from "./testing/fakeOrderStore.mjs";
import sharedData from "../netlify/functions/shared-data.mjs";

const lookup = (id, code) => sharedData(new Request(`https://cedarbite.test/.netlify/functions/shared-data?scope=student-order&id=${id}&pickup_code=${code}`));

describe("moving existing orders into Supabase", () => {
  it("copies queue and history orders once, keeps the Netlify copies, and records that it is done", async () => {
    await lookup("2f8e0942-21a1-49db-8134-26b6fc73e008", "CB12AB34");
    expect(orderDb.importOrders).toHaveBeenCalledOnce();
    expect([...orderDb.rows.keys()].sort()).toEqual(["a", "b"]);
    expect(mockStore.values.get("meta/orders-in-supabase-v1")).toMatchObject({ orders: 2 });
    expect(mockStore.values.has("queue/a")).toBe(true);

    await lookup("2f8e0942-21a1-49db-8134-26b6fc73e008", "CB12AB34");
    expect(orderDb.importOrders).toHaveBeenCalledOnce();
  });
});
