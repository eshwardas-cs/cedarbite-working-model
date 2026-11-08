import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStore = vi.hoisted(() => {
  const values = new Map();
  return {
    values,
    get: vi.fn(async (key) => values.get(key) ?? null),
    setJSON: vi.fn(async (key, value) => { values.set(key, value); }),
    delete: vi.fn(async (key) => { values.delete(key); }),
    list: vi.fn(async ({ prefix }) => ({ blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) })),
  };
});

vi.mock("@netlify/blobs", () => ({ getStore: () => mockStore }));

import sharedData from "../netlify/functions/shared-data.mjs";

const orderId = "2f8e0942-21a1-49db-8134-26b6fc73e008";
const pickupCode = "CB12AB34";

function lookup(id = orderId, code = pickupCode) {
  const params = new URLSearchParams({ scope: "student-order", id, pickup_code: code });
  return sharedData(new Request(`https://cedarbite.test/.netlify/functions/shared-data?${params}`));
}

describe("student order confirmation lookup", () => {
  beforeEach(() => {
    mockStore.values.clear();
    mockStore.get.mockClear();
  });

  it("returns only a matching order and omits its student ID", async () => {
    mockStore.values.set(`queue/${orderId}`, { id: orderId, pickup_code: pickupCode, student_id: "2526245", status: "SUBMITTED" });

    const response = await lookup();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ order: { id: orderId, pickup_code: pickupCode, status: "SUBMITTED" } });
  });

  it("does not reveal an order when its pickup code does not match", async () => {
    mockStore.values.set(`queue/${orderId}`, { id: orderId, pickup_code: pickupCode, student_id: "2526245" });

    const response = await lookup(orderId, "CBFFFFFF");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ order: null });
  });

  it("rejects malformed order references", async () => {
    const response = await lookup("short", pickupCode);
    expect(response.status).toBe(400);
    expect(mockStore.get).not.toHaveBeenCalled();
  });
});
