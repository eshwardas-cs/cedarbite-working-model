// shared/order-store.mjs talks to the Supabase orders table with the secret key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertOrder, listForCustomer, rowFromOrder, updateOrder } from "../shared/order-store.mjs";

const json = (body, status = 200) => new Response(body === null ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock;
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co/rest/v1/");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  fetchMock = vi.fn(async () => json([]));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("order store", () => {
  it("copies the searchable fields from the order itself", () => {
    const order = { id: "x1", pickup_code: "CB123456", status: "SUBMITTED", source: "ONLINE", mode: "SCHEDULED", customer_user_id: "u1", student_id: 1234567, total_paisa: 30000, payment_method: "cash", payment_status: "UNPAID", created_at: "2026-11-10T08:00:00.000Z", pickup_window: { start_at: "2026-11-10T09:00:00.000Z" } };
    expect(rowFromOrder(order)).toMatchObject({ id: "x1", status: "SUBMITTED", customer_user_id: "u1", student_id: "1234567", total_paisa: 30000, pickup_start_at: "2026-11-10T09:00:00.000Z", completed_at: null, data: order });
  });

  it("uses the base Supabase address and the secret key", async () => {
    await listForCustomer("u1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/example\.supabase\.co\/rest\/v1\/orders\?select=data&customer_user_id=eq\.u1&/);
    expect(init.headers.Authorization).toBe("Bearer sb_secret_test");
  });

  it("reports a duplicate order ID instead of overwriting it", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: "23505", message: "duplicate key" }, 409));
    await expect(insertOrder({ id: "x1", status: "SUBMITTED" })).resolves.toBe(false);
  });

  it("only updates when the status is still the one we expect", async () => {
    await expect(updateOrder({ id: "x1", status: "PREPARING" }, { expectedStatus: "SUBMITTED" })).resolves.toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("orders?id=eq.x1&status=eq.SUBMITTED");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).not.toHaveProperty("id");
  });
});
