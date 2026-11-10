// Staff menu changes and order prices go through Supabase (via shared/menu-store.mjs),
// never Netlify storage, and only a signed-in order manager can change the menu.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const menu = vi.hoisted(() => {
  class MenuStoreError extends Error { constructor(message, status = 500) { super(message); this.status = status; } }
  const catalog = {
    categories: [{ id: 1, name: "Snacks", items: [
      { id: 1, category_id: 1, name: "Samosa", price_paisa: 15000, available: true, quick_allowed: true, scheduled_allowed: true, addon_name: null, addon_price_paisa: 0 },
      { id: 2, category_id: 1, name: "Wonton", price_paisa: 20000, available: false, quick_allowed: true, scheduled_allowed: true, addon_name: null, addon_price_paisa: 0 },
    ] }],
  };
  return {
    MenuStoreError,
    catalog,
    readCatalog: vi.fn(async () => catalog),
    setAvailability: vi.fn(async (id, available) => ({ id, available })),
    setPrice: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
    addItem: vi.fn(async (item) => ({ id: 99, ...item })),
    updateItem: vi.fn(async (item) => item),
    addCategory: vi.fn(async () => undefined),
    removeCategory: vi.fn(async () => undefined),
    reorderMenu: vi.fn(async () => undefined),
  };
});
vi.mock("../shared/menu-store.mjs", () => menu);

// Who is ordering: by default a signed-in student. Tests can make the sign-in check fail.
const customer = vi.hoisted(() => {
  class CustomerAuthError extends Error { constructor(message, status = 401) { super(message); this.status = status; } }
  const student = { user_id: "6b1f3c1e-0000-4000-8000-000000000001", email: "1234567@cedar.edu.pk", role: "student", student_id: "1234567" };
  return { CustomerAuthError, student, customerFromRequest: vi.fn(async () => student) };
});
vi.mock("../shared/customer-auth.mjs", () => customer);

import sharedData from "../netlify/functions/shared-data.mjs";

const ENDPOINT = "https://cedarbite.test/.netlify/functions/shared-data";
const MANAGER = { "x-canteen-role": "order_manager", "x-canteen-username": "manager", "x-canteen-password": "manager-test-password" };
const post = (body, headers = {}) => sharedData(new Request(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
const get = (scope) => sharedData(new Request(`${ENDPOINT}?scope=${scope}`));
const studentOrder = (items) => ({ action: "create-order", order: { id: "2f8e0942-21a1-49db-8134-26b6fc73e008", pickup_code: "CB12AB34", mode: "QUICK", payment_method: "cash", items } });

const savedPassword = process.env.CANTEEN_DASHBOARD_PASSWORD;
afterAll(() => { process.env.CANTEEN_DASHBOARD_PASSWORD = savedPassword; });

beforeEach(() => {
  process.env.CANTEEN_DASHBOARD_PASSWORD = "manager-test-password";
  mockStore.values.clear();
  mockStore.setJSON.mockClear();
  customer.customerFromRequest.mockClear();
  for (const fn of ["readCatalog", "setAvailability", "setPrice", "removeItem", "addItem", "updateItem", "addCategory", "removeCategory", "reorderMenu"]) menu[fn].mockClear();
});

describe("staff menu changes", () => {
  it("refuses menu changes without the order manager login", async () => {
    const response = await post({ action: "set-availability", item_id: 1, available: false });
    expect(response.status).toBe(401);
    expect(menu.setAvailability).not.toHaveBeenCalled();
  });

  it("saves a sold-out switch to Supabase, not Netlify storage", async () => {
    const response = await post({ action: "set-availability", item_id: 1, available: false }, MANAGER);
    expect(response.status).toBe(200);
    expect(menu.setAvailability).toHaveBeenCalledWith(1, false);
    expect([...mockStore.values.keys()].some((key) => key.startsWith("availability/") || key.startsWith("menu/"))).toBe(false);
  });

  it("changes one price only", async () => {
    const response = await post({ action: "set-price", item_id: 1, price_paisa: 17500 }, MANAGER);
    expect(response.status).toBe(200);
    expect(menu.setPrice).toHaveBeenCalledWith(1, 17500);
    expect(await post({ action: "set-price", item_id: 1, price_paisa: -5 }, MANAGER).then((r) => r.status)).toBe(400);
  });

  it("removes one item, adds and removes categories, and saves the order", async () => {
    expect((await post({ action: "remove-menu-item", item_id: 2 }, MANAGER)).status).toBe(200);
    expect(menu.removeItem).toHaveBeenCalledWith(2);
    expect((await post({ action: "add-category", name: "  Hot drinks " }, MANAGER)).status).toBe(201);
    expect(menu.addCategory).toHaveBeenCalledWith("  Hot drinks ");
    expect((await post({ action: "remove-category", category_id: 3, target_category_id: 1 }, MANAGER)).status).toBe(200);
    expect(menu.removeCategory).toHaveBeenCalledWith(3, 1);
    expect((await post({ action: "set-menu", categories: [{ id: 1, items: [{ id: 2 }, { id: 1 }] }] }, MANAGER)).status).toBe(200);
    expect(menu.reorderMenu).toHaveBeenCalledOnce();
  });

  it("accepts an unchanged photo link when editing an item", async () => {
    const item = { id: 1, category_id: 1, name: "Samosa", description: "", price_paisa: 15000, quick_allowed: true, scheduled_allowed: true, prep_minutes: null, image_data: "https://example.supabase.co/storage/v1/object/public/menu-images/items/samosa.jpg", addon_name: null, addon_price_paisa: 0 };
    const response = await post({ action: "update-menu-item", item }, MANAGER);
    expect(response.status).toBe(200);
    expect(menu.updateItem).toHaveBeenCalledWith(item);
  });

  it("passes database messages (like a stale menu) back to the screen", async () => {
    menu.reorderMenu.mockRejectedValueOnce(new menu.MenuStoreError("The menu was changed on another screen. Refresh the menu and try again.", 409));
    const response = await post({ action: "set-menu", categories: [{ id: 1, items: [{ id: 1 }] }] }, MANAGER);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "The menu was changed on another screen. Refresh the menu and try again." });
  });
});

describe("menu reads and order prices come from Supabase", () => {
  it("serves the Supabase menu and sold-out list", async () => {
    await expect((await get("menu")).json()).resolves.toEqual({ categories: menu.catalog.categories });
    await expect((await get("availability")).json()).resolves.toEqual({ availability: { 1: true, 2: false } });
  });

  it("prices an order with Supabase item numbers and ignores the browser's price", async () => {
    const response = await post(studentOrder([{ item_id: 1, name: "Samosa", quantity: 2, unit_price_paisa: 1 }]));
    expect(response.status).toBe(201);
    const { order } = await response.json();
    expect(order.total_paisa).toBe(30000);
    expect(order.items[0]).toMatchObject({ item_id: 1, unit_price_paisa: 15000 });
  });

  it("refuses an order for a sold-out item", async () => {
    const response = await post(studentOrder([{ item_id: 2, name: "Wonton", quantity: 1 }]));
    expect(response.status).toBe(409);
    expect(mockStore.setJSON).not.toHaveBeenCalled();
  });
});

describe("online orders need a Cedar sign-in", () => {
  it("refuses an order when the sign-in check fails, and saves nothing", async () => {
    customer.customerFromRequest.mockRejectedValueOnce(new customer.CustomerAuthError("Sign in with your Cedar Google account to place an order."));
    const response = await post(studentOrder([{ item_id: 1, name: "Samosa", quantity: 1 }]));
    expect(response.status).toBe(401);
    expect(mockStore.setJSON).not.toHaveBeenCalled();
  });

  it("takes the student ID from the sign-in, not from the browser", async () => {
    const body = studentOrder([{ item_id: 1, name: "Samosa", quantity: 1 }]);
    body.order.student_id = "7654321";
    const response = await post(body);
    expect(response.status).toBe(201);
    const saved = mockStore.values.get(`queue/${body.order.id}`);
    expect(saved).toMatchObject({ student_id: "1234567", customer_user_id: customer.student.user_id, customer_email: "1234567@cedar.edu.pk" });
    const { order } = await response.json();
    expect(order).not.toHaveProperty("student_id");
    expect(order).not.toHaveProperty("customer_email");
  });

  it("refuses the wallet (nothing can check a balance yet) instead of marking the order paid", async () => {
    const body = studentOrder([{ item_id: 1, name: "Samosa", quantity: 1 }]);
    body.order.payment_method = "wallet";
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mockStore.setJSON).not.toHaveBeenCalled();
  });

  it("does not let another account reuse someone else's order reference", async () => {
    const body = studentOrder([{ item_id: 1, name: "Samosa", quantity: 1 }]);
    expect((await post(body)).status).toBe(201);
    customer.customerFromRequest.mockResolvedValueOnce({ ...customer.student, user_id: "6b1f3c1e-0000-4000-8000-000000000002" });
    expect((await post(body)).status).toBe(409);
  });
});

describe("My orders for Google users", () => {
  const myOrders = () => sharedData(new Request(`${ENDPOINT}?scope=my-orders`, { headers: { Authorization: "Bearer t" } }));
  const order = (id, code) => ({ action: "create-order", order: { id, pickup_code: code, mode: "QUICK", payment_method: "cash", items: [{ item_id: 1, name: "Samosa", quantity: 1 }] } });
  const OTHER = { ...customer.student, user_id: "6b1f3c1e-0000-4000-8000-000000000002", email: "7654321@cedar.edu.pk", student_id: "7654321" };

  it("refuses without a sign-in", async () => {
    customer.customerFromRequest.mockRejectedValueOnce(new customer.CustomerAuthError("Sign in with your Cedar Google account to place an order."));
    expect((await myOrders()).status).toBe(401);
  });

  it("shows each person only their own orders, newest first, without private fields", async () => {
    expect((await post(order("11111111-1111-4111-8111-111111111111", "CB111111"))).status).toBe(201);
    customer.customerFromRequest.mockResolvedValueOnce(OTHER);
    expect((await post(order("22222222-2222-4222-8222-222222222222", "CB222222"))).status).toBe(201);
    expect((await post(order("33333333-3333-4333-8333-333333333333", "CB333333"))).status).toBe(201);

    const { orders } = await (await myOrders()).json();
    expect(orders.map((o) => o.pickup_code).sort()).toEqual(["CB111111", "CB333333"]);
    for (const o of orders) {
      expect(o).not.toHaveProperty("student_id");
      expect(o).not.toHaveProperty("customer_email");
      expect(o).not.toHaveProperty("customer_user_id");
    }

    customer.customerFromRequest.mockResolvedValueOnce(OTHER);
    const other = await (await myOrders()).json();
    expect(other.orders.map((o) => o.pickup_code)).toEqual(["CB222222"]);
  });

  it("still finds an order after the canteen moves it to history", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    await post(order(id, "CB444444"));
    const saved = mockStore.values.get(`queue/${id}`);
    mockStore.values.delete(`queue/${id}`);
    mockStore.values.set(`history/${id}`, { ...saved, status: "COLLECTED" });
    const { orders } = await (await myOrders()).json();
    expect(orders).toEqual([expect.objectContaining({ pickup_code: "CB444444", status: "COLLECTED" })]);
  });
});
