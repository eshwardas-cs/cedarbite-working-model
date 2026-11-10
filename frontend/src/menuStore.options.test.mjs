// shared/menu-store.mjs: saving and reading an item's options in Supabase.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCatalog, updateItem } from "../shared/menu-store.mjs";

const json = (body, status = 200) => new Response(body === null ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const row = { id: 3, category_id: 1, name: "Cold drink", description: "", price_paisa: 10000, addon_name: null, addon_price_paisa: 0, is_available: true, quick_allowed: true, scheduled_allowed: true, prep_minutes: null, image_path: null, sort_order: 1 };
let fetchMock;
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("menu options in the menu store", () => {
  it("reads options in order with their stock", async () => {
    fetchMock = vi.fn(async () => json([{ id: 1, name: "Drinks", sort_order: 1, menu_items: [{ ...row, menu_item_options: [
      { id: "b", name: "Mango", is_available: false, sort_order: 2 }, { id: "a", name: "Cola", is_available: true, sort_order: 1 },
    ] }] }]));
    vi.stubGlobal("fetch", fetchMock);
    const catalog = await readCatalog();
    expect(catalog.categories[0].items[0].options).toEqual([{ id: "a", name: "Cola", available: true }, { id: "b", name: "Mango", available: false }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("menu_item_options(id,name,is_available,sort_order)");
  });

  const item = (options) => ({ id: 3, category_id: 1, name: "Cold drink", description: "", price_paisa: 10000, quick_allowed: true, scheduled_allowed: true, prep_minutes: null, image_data: null, addon_name: null, addon_price_paisa: 0, options });

  it("refuses duplicate, empty or too many option names before saving anything", async () => {
    fetchMock = vi.fn(async () => json([]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(updateItem(item([{ name: "Cola" }, { name: " cola " }]))).rejects.toMatchObject({ status: 400 });
    await expect(updateItem(item([{ name: "  " }]))).rejects.toMatchObject({ status: 400 });
    await expect(updateItem(item(Array.from({ length: 26 }, (_, i) => ({ name: `Flavour ${i}` }))))).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps existing option IDs, adds new ones and removes the rest", async () => {
    const calls = [];
    fetchMock = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
      const u = String(url);
      if (u.includes("menu_item_options?select=id")) return json([{ id: "keep-me" }, { id: "drop-me" }]);
      if (u.includes("menu_categories")) return json([{ id: 1, name: "Drinks", sort_order: 1, menu_items: [] }]);
      if ((init.method ?? "GET") === "GET" && u.includes("menu_items?select=")) return json([row]);
      if (init.method === "PATCH") return json([{ ...row, menu_item_options: [] }]);
      return json(null, 201);
    });
    vi.stubGlobal("fetch", fetchMock);
    await updateItem(item([{ id: "keep-me", name: "Cola" }, { id: "someone-elses", name: "Mango", available: false }]));
    const upsert = calls.find((c) => c.method === "POST" && c.url.includes("menu_item_options"));
    expect(upsert.body[0]).toMatchObject({ id: "keep-me", menu_item_id: 3, name: "Cola", is_available: true, sort_order: 0 });
    expect(upsert.body[1]).toMatchObject({ menu_item_id: 3, name: "Mango", is_available: false, sort_order: 1 });
    expect(upsert.body[1].id).not.toBe("someone-elses");
    const removal = calls.find((c) => c.method === "DELETE");
    expect(removal.url).toContain(`menu_item_options?menu_item_id=eq.3&id=not.in.(keep-me,${upsert.body[1].id})`);
  });

  it("leaves options alone when an older screen doesn't send them", async () => {
    fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      if (u.includes("menu_categories")) return json([{ id: 1, name: "Drinks", sort_order: 1, menu_items: [] }]);
      if ((init.method ?? "GET") === "GET") return json([row]);
      return json([{ ...row, menu_item_options: [{ id: "a", name: "Cola", is_available: true, sort_order: 0 }] }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const saved = await updateItem(item(undefined));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("menu_item_options?"))).toBe(false);
    expect(saved.options).toEqual([{ id: "a", name: "Cola", available: true }]);
  });
});
