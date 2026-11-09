// shared/menu-store.mjs talks to Supabase over HTTP. These tests use a fake fetch,
// so they never touch the real database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as menuStore from "../shared/menu-store.mjs";

const URL_BASE = "https://example.supabase.co";
const reply = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });

const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY, vite: process.env.VITE_SUPABASE_URL };
beforeEach(() => {
  process.env.SUPABASE_URL = `${URL_BASE}/rest/v1/`; // a pasted /rest/v1 must not break anything
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  delete process.env.VITE_SUPABASE_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_SECRET_KEY", saved.key], ["VITE_SUPABASE_URL", saved.vite]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe("menu store", () => {
  it("explains clearly when the secret key is missing", async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    await expect(menuStore.readCatalog()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("SUPABASE_SECRET_KEY") });
  });

  it("reads active items in staff order and shapes them like the website menu", async () => {
    const fetchMock = vi.fn(async () => reply(200, [{ id: 4, name: "Fries", sort_order: 1, menu_items: [
      { id: 9, category_id: 4, name: "Masala fries", description: "", price_paisa: 25000, addon_name: null, addon_price_paisa: 0, is_available: false, quick_allowed: true, scheduled_allowed: true, prep_minutes: 5, image_path: "items/fries.jpg", sort_order: 1 },
    ] }]));
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await menuStore.readCatalog();
    const [requestUrl, options] = fetchMock.mock.calls[0];
    expect(requestUrl).toContain(`${URL_BASE}/rest/v1/menu_categories?`);
    expect(requestUrl).toContain("menu_items.is_active=eq.true");
    expect(requestUrl).toContain("menu_items.order=sort_order.asc,id.asc");
    expect(options.headers.apikey).toBe("sb_secret_test");
    expect(catalog.categories[0].items[0]).toMatchObject({
      id: 9, available: false, price_paisa: 25000, price_display: "Rs 250",
      image_data: `${URL_BASE}/storage/v1/object/public/menu-images/items/fries.jpg`,
    });
  });

  it("only changes items that are still on the menu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, [])));
    await expect(menuStore.setAvailability(1, false)).rejects.toMatchObject({ status: 409 });
  });

  it("turns a stale-menu database refusal into a friendly message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(400, { code: "P0001", message: "MENU_STALE: The items changed on another screen." })));
    await expect(menuStore.reorderMenu([{ id: 1, items: [{ id: 1 }] }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Refresh") });
  });

  it("sends only category and item numbers when reordering", async () => {
    const fetchMock = vi.fn(async () => reply(204));
    vi.stubGlobal("fetch", fetchMock);
    await menuStore.reorderMenu([{ id: 2, name: "x", items: [{ id: 5, price_paisa: 1 }, { id: 3 }] }]);
    const [requestUrl, options] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe(`${URL_BASE}/rest/v1/rpc/staff_reorder_menu`);
    expect(JSON.parse(options.body)).toEqual({ p_categories: [{ id: 2, item_ids: [5, 3] }] });
  });

  it("keeps the photo when the edit form sends back the current link", async () => {
    const current = { id: 1, category_id: 1, name: "Samosa", description: "", price_paisa: 15000, addon_name: null, addon_price_paisa: 0, is_available: true, quick_allowed: true, scheduled_allowed: true, prep_minutes: null, image_path: "items/samosa.jpg", sort_order: 1 };
    const fetchMock = vi.fn(async (requestUrl, options = {}) => {
      if (options.method === "PATCH") return reply(200, [{ ...current, ...JSON.parse(options.body) }]);
      if (requestUrl.includes("menu_categories")) return reply(200, [{ id: 1, name: "Snacks", menu_items: [current] }]);
      return reply(200, [current]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const updated = await menuStore.updateItem({ ...current, name: "Samosa (2 pcs)", image_data: `${URL_BASE}/storage/v1/object/public/menu-images/items/samosa.jpg` });
    const patch = JSON.parse(fetchMock.mock.calls.find(([, options]) => options?.method === "PATCH")[1].body);
    expect(patch.image_path).toBe("items/samosa.jpg");
    expect(patch.name).toBe("Samosa (2 pcs)");
    expect(updated.name).toBe("Samosa (2 pcs)");
    expect(fetchMock.mock.calls.some(([requestUrl]) => requestUrl.includes("/storage/"))).toBe(false);
  });
});
