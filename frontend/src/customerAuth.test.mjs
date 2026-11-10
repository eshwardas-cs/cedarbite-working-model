// The server-side sign-in check for online orders (shared/customer-auth.mjs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerAuthError, customerFromRequest } from "../shared/customer-auth.mjs";

const withToken = (token) => new Request("https://cedarbite.test/x", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co/rest/v1/");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("customerFromRequest", () => {
  it("refuses a request with no sign-in token", async () => {
    await expect(customerFromRequest(withToken(null))).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a token Supabase does not accept", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "invalid JWT" }, 401)));
    await expect(customerFromRequest(withToken("bad"))).rejects.toBeInstanceOf(CustomerAuthError);
  });

  it("refuses a signed-in account that has no Cedar profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("/auth/v1/user") ? json({ id: "u1" }) : json([])));
    await expect(customerFromRequest(withToken("t"))).rejects.toMatchObject({ status: 403 });
  });

  it("returns the student ID from the profile email, using the base Supabase address", async () => {
    const fetchMock = vi.fn(async (url) => String(url).includes("/auth/v1/user") ? json({ id: "u1" }) : json([{ email: "1234567@cedar.edu.pk", role: "student" }]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(customerFromRequest(withToken("t"))).resolves.toEqual({ user_id: "u1", email: "1234567@cedar.edu.pk", role: "student", student_id: "1234567" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://example.supabase.co/auth/v1/user");
  });

  it("gives teachers no student ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("/auth/v1/user") ? json({ id: "u2" }) : json([{ email: "a.teacher@cedar.edu.pk", role: "teacher" }])));
    await expect(customerFromRequest(withToken("t"))).resolves.toMatchObject({ role: "teacher", student_id: null });
  });
});
