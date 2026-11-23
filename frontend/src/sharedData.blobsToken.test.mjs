import { describe, expect, it, vi } from "vitest";

// Regression test: the Blobs store must be opened per request. A store created once at start-up
// keeps Netlify's first short-lived token, and a warm function then fails every read with
// "Failed to decode token: Token expired" (seen on cedarbite.me, 24 Nov 2026).
const getStore = vi.hoisted(() => vi.fn(() => ({
  get: vi.fn(async () => null),
  setJSON: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
  list: vi.fn(async () => ({ blobs: [] })),
})));
vi.mock("@netlify/blobs", () => ({ getStore }));
vi.mock("../shared/order-store.mjs", () => import("./testing/fakeOrderStore.mjs"));

import sharedData from "../netlify/functions/shared-data.mjs";

describe("Netlify Blobs access token", () => {
  it("opens a fresh store for every request", async () => {
    getStore.mockClear();
    for (let i = 0; i < 3; i += 1) {
      const response = await sharedData(new Request("https://cedarbite.test/.netlify/functions/shared-data?scope=item-of-day"));
      expect(response.status).toBe(200);
    }
    expect(getStore).toHaveBeenCalledTimes(3);
  });
});
