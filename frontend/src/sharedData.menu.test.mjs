// Staff menu changes and order prices go through Supabase (via shared/menu-store.mjs),
// never Netlify storage, and only a signed-in order manager can change the menu.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      { id: 3, category_id: 1, name: "Cold drink", price_paisa: 10000, available: true, quick_allowed: true, scheduled_allowed: true, addon_name: null, addon_price_paisa: 0,
        options: [{ id: "opt-cola", name: "Cola", available: true }, { id: "opt-mango", name: "Mango", available: false }] },
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
  return {
    CustomerAuthError,
    student,
    customerFromRequest: vi.fn(async () => student),
    studentProfileFromId: vi.fn(async (student_id) => ({ student_id, full_name: null, source: "missing", profile_exists: false, user_id: null, email: `${student_id}@cedar.edu.pk` })),
    saveCounterStudentName: vi.fn(async (student_id, full_name) => ({ student_id, full_name, source: "counter", profile_exists: false, user_id: null, email: `${student_id}@cedar.edu.pk` })),
    teacherIdentityFromName: vi.fn(async (full_name) => ({ full_name, email: "adam.asif@cedar.edu.pk", user_id: null, profile_exists: false })),
  };
});
vi.mock("../shared/customer-auth.mjs", () => customer);
vi.mock("../shared/order-store.mjs", () => import("./testing/fakeOrderStore.mjs"));
import * as orderDb from "./testing/fakeOrderStore.mjs";

import sharedData from "../netlify/functions/shared-data.mjs";

const ENDPOINT = "https://cedarbite.test/.netlify/functions/shared-data";
const MANAGER = { "x-canteen-role": "order_manager", "x-canteen-username": "manager", "x-canteen-password": "manager-test-password" };
const DEVELOPER = { "x-canteen-role": "developer", "x-canteen-username": "developer", "x-canteen-password": "developer-test-password" };
const post = (body, headers = {}) => sharedData(new Request(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
const get = (scope) => sharedData(new Request(`${ENDPOINT}?scope=${scope}`));
const getDeveloperExport = (from = "2026-11-19", to = "2026-11-19", headers = {}) => sharedData(new Request(`${ENDPOINT}?scope=developer-export&from=${from}&to=${to}`, { headers }));
const studentOrder = (items) => ({ action: "create-order", order: { id: "2f8e0942-21a1-49db-8134-26b6fc73e008", pickup_code: "CB12AB34", mode: "QUICK", payment_method: "cash", items } });

const savedPassword = process.env.CANTEEN_DASHBOARD_PASSWORD;
const savedCounterPassword = process.env.CANTEEN_COUNTER_PASSWORD;
const savedCashierPassword = process.env.CANTEEN_CASHIER_PASSWORD;
const savedDeveloperPassword = process.env.CANTEEN_DEVELOPER_PASSWORD;
afterAll(() => { process.env.CANTEEN_DASHBOARD_PASSWORD = savedPassword; });
afterAll(() => { if (savedCounterPassword === undefined) delete process.env.CANTEEN_COUNTER_PASSWORD; else process.env.CANTEEN_COUNTER_PASSWORD = savedCounterPassword; });
afterAll(() => { if (savedCashierPassword === undefined) delete process.env.CANTEEN_CASHIER_PASSWORD; else process.env.CANTEEN_CASHIER_PASSWORD = savedCashierPassword; });
afterAll(() => { if (savedDeveloperPassword === undefined) delete process.env.CANTEEN_DEVELOPER_PASSWORD; else process.env.CANTEEN_DEVELOPER_PASSWORD = savedDeveloperPassword; });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T03:00:00.000Z"));
  process.env.CANTEEN_DASHBOARD_PASSWORD = "manager-test-password";
  process.env.CANTEEN_COUNTER_PASSWORD = "counter-test-password";
  process.env.CANTEEN_DEVELOPER_PASSWORD = "developer-test-password";
  mockStore.values.clear();
  mockStore.setJSON.mockClear();
  customer.customerFromRequest.mockClear();
  orderDb.reset();
  for (const fn of ["readCatalog", "setAvailability", "setPrice", "removeItem", "addItem", "updateItem", "addCategory", "removeCategory", "reorderMenu"]) menu[fn].mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe("developer data export access", () => {
  it("keeps the export private to the developer station", async () => {
    const response = await getDeveloperExport();
    expect(response.status).toBe(401);
  });

  it("rejects an invalid export date range before reading records", async () => {
    const response = await getDeveloperExport("2026-11-20", "2026-11-19", DEVELOPER);
    expect(response.status).toBe(400);
    expect(mockStore.list).not.toHaveBeenCalled();
  });
});

describe("temporary canteen opening", () => {
  it("allows only developer access to change temporary hours", async () => {
    const response = await post({ action: "set-temporary-opening", enabled: true }, MANAGER);
    expect(response.status).toBe(401);
    expect(mockStore.values.has("settings/temporary-opening")).toBe(false);
  });

  it("does not replace the regular schedule while it is already open", async () => {
    const response = await post({ action: "set-temporary-opening", enabled: true }, DEVELOPER);
    expect(response.status).toBe(409);
    expect(mockStore.values.has("settings/temporary-opening")).toBe(false);
  });

  it("opens all interfaces while the temporary opening is active", async () => {
    vi.setSystemTime(new Date("2026-11-21T03:00:00.000Z"));
    const response = await post({ action: "set-temporary-opening", enabled: true }, DEVELOPER);
    expect(response.status).toBe(200);
    expect(mockStore.values.get("settings/temporary-opening").expires_at).toBe("2026-11-21T19:00:00.000Z");
    const status = await (await get("ordering-status")).json();
    expect(status.temporary_open).toBe(true);
    expect(status.counter_open).toBe(true);
    expect(status.kitchen_open).toBe(true);
    expect(status.manager_open).toBe(true);
    expect(status.cashier_open).toBe(true);
    expect(status.student_orders_open).toBe(true);
  });

  it("treats an expired temporary opening as closed", async () => {
    mockStore.values.set("settings/temporary-opening", { enabled: true, expires_at: "2026-11-19T02:59:59.000Z" });
    const status = await (await get("ordering-status")).json();
    expect(status.temporary_open).toBe(false);
    expect(status.counter_open).toBe(true);
    expect(status.kitchen_open).toBe(true);
    expect(status.cashier_open).toBe(true);
  });
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
    await expect((await get("availability")).json()).resolves.toEqual({ availability: { 1: true, 2: false, 3: true } });
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
    expect(orderDb.createOrderAtomic).not.toHaveBeenCalled();
  });
});

describe("online orders need a Cedar sign-in", () => {
  it("refuses an order when the sign-in check fails, and saves nothing", async () => {
    customer.customerFromRequest.mockRejectedValueOnce(new customer.CustomerAuthError("Sign in with your Cedar Google account to place an order."));
    const response = await post(studentOrder([{ item_id: 1, name: "Samosa", quantity: 1 }]));
    expect(response.status).toBe(401);
    expect(orderDb.createOrderAtomic).not.toHaveBeenCalled();
  });

  it("takes the student ID from the sign-in, not from the browser", async () => {
    const body = studentOrder([{ item_id: 1, name: "Samosa", quantity: 1 }]);
    body.order.student_id = "7654321";
    const response = await post(body);
    expect(response.status).toBe(201);
    const saved = orderDb.rows.get(body.order.id);
    expect(saved).toMatchObject({ student_id: "1234567", customer_user_id: customer.student.user_id, customer_email: "1234567@cedar.edu.pk" });
    const { order } = await response.json();
    expect(order).toHaveProperty("student_id", "1234567");
    expect(order).not.toHaveProperty("customer_email");
  });

  it("sends wallet payment through the atomic order-and-wallet transaction", async () => {
    const body = studentOrder([{ item_id: 1, name: "Samosa", quantity: 1 }]);
    body.order.payment_method = "wallet";
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(orderDb.createOrderAtomic).toHaveBeenCalledWith(expect.objectContaining({ payment_method: "wallet", payment_status: "PENDING" }), expect.any(String));
    expect(orderDb.rows.get(body.order.id)).toMatchObject({ payment_method: "wallet", payment_status: "PAID" });
  });

  it("does not let another account reuse someone else's order reference", async () => {
    const body = studentOrder([{ item_id: 1, name: "Samosa", quantity: 1 }]);
    expect((await post(body)).status).toBe(201);
    customer.customerFromRequest.mockResolvedValueOnce({ ...customer.student, user_id: "6b1f3c1e-0000-4000-8000-000000000002" });
    expect((await post(body)).status).toBe(409);
  });
});

describe("counter order customer identity", () => {
  const COUNTER = { "x-canteen-role": "order_taker", "x-canteen-username": "counter", "x-canteen-password": "counter-test-password" };
  const counterOrder = (id, pickup_code, customer) => post({
    action: "create-counter-order",
    order: {
      id,
      pickup_code,
      mode: "QUICK",
      payment_method: "cash",
      ...customer,
      items: [{ item_id: 1, name: "Samosa", quantity: 1 }],
    },
  }, COUNTER);

  it("stores a student's Cedar email even before their first sign-in", async () => {
    const response = await counterOrder("counter-student-order", "CB12AB34", {
      customer_type: "STUDENT",
      student_id: "2526245",
      customer_name: "New Student",
    });

    expect(response.status).toBe(201);
    expect(orderDb.rows.get("counter-student-order")).toMatchObject({
      customer_type: "STUDENT",
      customer_email: "2526245@cedar.edu.pk",
      customer_user_id: null,
      student_id: "2526245",
      customer_name: "New Student",
    });
  });

  it("saves teacher and guest orders with distinct types and only links the teacher account", async () => {
    const teacherResponse = await counterOrder("counter-teacher-order", "CB12AB35", {
      customer_type: "TEACHER",
      customer_name: "Adam Asif",
    });
    const guestResponse = await counterOrder("counter-guest-order", "CB12AB36", {
      customer_type: "GUEST",
      customer_name: "Visitor Name",
    });

    expect(teacherResponse.status).toBe(201);
    expect(orderDb.rows.get("counter-teacher-order")).toMatchObject({
      customer_type: "TEACHER",
      customer_email: "adam.asif@cedar.edu.pk",
      customer_user_id: null,
      customer_name: "Adam Asif",
    });
    expect(guestResponse.status).toBe(201);
    expect(orderDb.rows.get("counter-guest-order")).toMatchObject({ customer_type: "GUEST", customer_name: "Visitor Name" });
    expect(orderDb.rows.get("counter-guest-order")).toHaveProperty("customer_email", null);
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
      expect(o).toHaveProperty("student_id", o.pickup_code === "CB222222" ? "7654321" : "1234567");
      expect(o).not.toHaveProperty("customer_email");
      expect(o).not.toHaveProperty("customer_user_id");
    }

    customer.customerFromRequest.mockResolvedValueOnce(OTHER);
    const other = await (await myOrders()).json();
    expect(other.orders.map((o) => o.pickup_code)).toEqual(["CB222222"]);
  });

  it("finds a student counter order by Cedar email after the student first signs in", async () => {
    orderDb.rows.set("counter-first-order", {
      id: "counter-first-order",
      pickup_code: "CB8A8A8A",
      status: "SUBMITTED",
      mode: "QUICK",
      source: "COUNTER",
      customer_type: "STUDENT",
      customer_name: "Name entered at the counter",
      student_id: "1234567",
      customer_user_id: null,
      customer_email: "1234567@cedar.edu.pk",
      created_at: "2026-11-19T03:00:00.000Z",
      items: [{ name: "Samosa", quantity: 1 }],
    });
    customer.customerFromRequest.mockResolvedValueOnce({ ...customer.student, full_name: "Supabase Profile Name" });

    const { orders } = await (await myOrders()).json();
    expect(orders).toEqual([expect.objectContaining({
      pickup_code: "CB8A8A8A",
      customer_type: "STUDENT",
      student_id: "1234567",
      customer_name: "Supabase Profile Name",
    })]);
    expect(orders[0]).not.toHaveProperty("customer_email");
  });

  it("shows a teacher's unclaimed counter orders after first sign-in", async () => {
    orderDb.rows.set("counter-teacher-first-order", {
      id: "counter-teacher-first-order",
      pickup_code: "CB8A8A8B",
      status: "SUBMITTED",
      mode: "QUICK",
      source: "COUNTER",
      customer_type: "TEACHER",
      customer_name: "Adam Asif",
      customer_user_id: null,
      customer_email: "adam.asif@cedar.edu.pk",
      created_at: "2026-11-19T03:00:00.000Z",
      items: [{ name: "Samosa", quantity: 1 }],
    });
    customer.customerFromRequest.mockResolvedValueOnce({
      user_id: "teacher-auth-id",
      email: "adam.asif@cedar.edu.pk",
      role: "teacher",
      student_id: null,
      full_name: "Adam Asif",
    });

    const { orders } = await (await myOrders()).json();
    expect(orders).toEqual([expect.objectContaining({
      pickup_code: "CB8A8A8B",
      customer_type: "TEACHER",
      customer_name: "Adam Asif",
    })]);
    expect(orders[0]).not.toHaveProperty("customer_email");
  });

  it("does not show another Cedar account's counter order by email", async () => {
    orderDb.rows.set("other-counter-order", {
      id: "other-counter-order",
      pickup_code: "CB9B9B9B",
      status: "SUBMITTED",
      mode: "QUICK",
      source: "COUNTER",
      customer_type: "STUDENT",
      customer_name: "Other Student",
      student_id: "7654321",
      customer_user_id: null,
      customer_email: "7654321@cedar.edu.pk",
      created_at: "2026-11-19T03:00:00.000Z",
      items: [{ name: "Samosa", quantity: 1 }],
    });

    const { orders } = await (await myOrders()).json();
    expect(orders).toEqual([]);
  });

  it("still finds an order after the canteen moves it to history", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    await post(order(id, "CB444444"));
    orderDb.rows.set(id, { ...orderDb.rows.get(id), status: "COLLECTED", completed_at: new Date().toISOString() });
    const { orders } = await (await myOrders()).json();
    expect(orders).toEqual([expect.objectContaining({ pickup_code: "CB444444", status: "COLLECTED" })]);
  });
});

describe("orders are kept in Supabase", () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const place = () => post({ action: "create-order", order: { id, pickup_code: "CB555555", mode: "SCHEDULED", pickup_window: { start_at: "2026-11-19T03:10:00.000Z", end_at: "2026-11-19T03:20:00.000Z" }, payment_method: "cash", items: [{ item_id: 1, name: "Samosa", quantity: 1 }] } });
  const setStatus = (status) => post({ action: "set-status", order_id: id, status }, MANAGER);
  const stationList = (scope) => sharedData(new Request(`${ENDPOINT}?scope=${scope}`, { headers: MANAGER }));

  it("saves a new online order in the orders table, not Netlify storage", async () => {
    expect((await place()).status).toBe(201);
    expect(orderDb.rows.get(id)).toMatchObject({ status: "SUBMITTED", total_paisa: 15000 });
    expect([...mockStore.values.keys()].some((key) => key.startsWith("queue/") || key.startsWith("customers/"))).toBe(false);
  });

  it("holds quick orders for manager acceptance, then marks them ready", async () => {
    const quick = { action: "create-order", order: { id, pickup_code: "CB555555", mode: "QUICK", payment_method: "cash", items: [{ item_id: 1, name: "Samosa", quantity: 1 }] } };
    expect((await post(quick)).status).toBe(201);
    expect(orderDb.rows.get(id)).toMatchObject({ status: "SUBMITTED", payment_status: "UNPAID" });
    const accepted = await post({ action: "set-status", order_id: id, status: "READY" }, MANAGER);
    expect(accepted.status).toBe(200);
    expect(orderDb.rows.get(id)).toMatchObject({ status: "READY", ready_at: expect.any(String) });
  });

  it("records cash as received when an order is marked collected", async () => {
    await place();
    await setStatus("PREPARING");
    await setStatus("READY");
    const response = await setStatus("COLLECTED");
    expect(response.status).toBe(200);
    expect(orderDb.rows.get(id)).toMatchObject({ status: "COLLECTED", payment_status: "PAID", cash_received_at: expect.any(String) });
  });

  it("moves an order through the canteen and into history", async () => {
    await place();
    expect((await setStatus("PREPARING")).status).toBe(200);
    expect((await setStatus("READY")).status).toBe(200);
    expect((await setStatus("COLLECTED")).status).toBe(200);
    expect(orderDb.rows.get(id)).toMatchObject({ status: "COLLECTED", completed_at: expect.any(String) });
    expect((await (await stationList("queue")).json()).orders).toEqual([]);
    expect((await (await stationList("history")).json()).orders.map((o) => o.id)).toEqual([id]);
    expect((await setStatus("COLLECTED")).status).toBe(200); // pressing again is harmless
  });

  it("refuses a status change if another screen changed the order first", async () => {
    await place();
    orderDb.updateOrder.mockImplementationOnce(async () => {
      orderDb.rows.set(id, { ...orderDb.rows.get(id), status: "PREPARING" });
      return null; // the other screen won
    });
    const response = await post({ action: "set-status", order_id: id, status: "PREPARING" }, MANAGER);
    expect(response.status).toBe(200); // it already has the status we wanted
    orderDb.updateOrder.mockImplementationOnce(async () => null);
    orderDb.rows.set(id, { ...orderDb.rows.get(id), status: "READY" });
    expect((await post({ action: "set-status", order_id: id, status: "COLLECTED" }, MANAGER)).status).toBe(409);
  });

  it("voids new orders reversibly, and only completed ones from history", async () => {
    await place();
    expect((await post({ action: "delete-history-order", order_id: id }, MANAGER)).status).toBe(404);
    expect((await post({ action: "delete-order", order_id: id }, MANAGER)).status).toBe(200);
    expect(orderDb.rows.get(id)).toMatchObject({ status: "VOIDED", void_reason: "Accidental or invalid new order" });
  });
});

describe("students can cancel only before the canteen accepts", () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const place = () => post({ action: "create-order", order: { id, pickup_code: "CB666666", mode: "SCHEDULED", pickup_window: { start_at: "2026-11-19T03:10:00.000Z", end_at: "2026-11-19T03:20:00.000Z" }, payment_method: "cash", items: [{ item_id: 1, name: "Samosa", quantity: 1 }] } });
  const cancel = (orderId = id) => post({ action: "cancel-order", order_id: orderId });
  const stationList = (scope) => sharedData(new Request(`${ENDPOINT}?scope=${scope}`, { headers: MANAGER }));

  it("cancels a submitted order, removes it from the kitchen queue and keeps it in My orders", async () => {
    await place();
    const response = await cancel();
    expect(response.status).toBe(200);
    expect((await response.json()).order).toMatchObject({ status: "CANCELLED" });
    expect((await (await stationList("queue")).json()).orders).toEqual([]);
    expect((await (await stationList("history")).json()).orders.map((o) => o.status)).toEqual(["CANCELLED"]);
    const mine = await (await sharedData(new Request(`${ENDPOINT}?scope=my-orders`, { headers: { Authorization: "Bearer t" } }))).json();
    expect(mine.orders.map((o) => o.status)).toEqual(["CANCELLED"]);
    expect((await cancel()).status).toBe(200); // pressing again is harmless
  });

  it("refuses once the canteen has accepted it", async () => {
    await place();
    await post({ action: "set-status", order_id: id, status: "PREPARING" }, MANAGER);
    expect((await cancel()).status).toBe(409);
    expect(orderDb.rows.get(id).status).toBe("PREPARING");
  });

  it("lets the kitchen win if it accepts at the same moment", async () => {
    await place();
    orderDb.updateOrder.mockImplementationOnce(async () => {
      orderDb.rows.set(id, { ...orderDb.rows.get(id), status: "PREPARING" });
      return null;
    });
    expect((await cancel()).status).toBe(409);
    expect(orderDb.rows.get(id).status).toBe("PREPARING");
  });

  it("refuses someone else's order, an order paid at the cash desk, and a missing sign-in", async () => {
    await place();
    customer.customerFromRequest.mockResolvedValueOnce({ ...customer.student, user_id: "6b1f3c1e-0000-4000-8000-000000000009" });
    expect((await cancel()).status).toBe(404);
    orderDb.rows.set(id, { ...orderDb.rows.get(id), payment_status: "PAID" });
    expect((await cancel()).status).toBe(409);
    customer.customerFromRequest.mockRejectedValueOnce(new customer.CustomerAuthError("Sign in with your Cedar Google account to place an order."));
    expect((await cancel()).status).toBe(401);
    expect(orderDb.rows.get(id).status).toBe("SUBMITTED");
  });

  it("stops staff moving or charging a cancelled order", async () => {
    await place();
    await cancel();
    expect((await post({ action: "set-status", order_id: id, status: "PREPARING" }, MANAGER)).status).toBe(409);
    expect(orderDb.rows.get(id).status).toBe("CANCELLED");
  });
});

describe("menu item options (e.g. drink flavours)", () => {
  const id = "77777777-7777-4777-8777-777777777777";
  const drink = (extra = {}) => post({ action: "create-order", order: { id, pickup_code: "CB777777", mode: "QUICK", payment_method: "cash", items: [{ item_id: 3, name: "Cold drink", quantity: 2, ...extra }] } });

  it("saves the chosen option in the order line name, at the item's price", async () => {
    const response = await drink({ option_id: "opt-cola", unit_price_paisa: 1 });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    expect(order.items[0]).toMatchObject({ name: "Cold drink · Cola", option_id: "opt-cola", unit_price_paisa: 10000 });
    expect(order.total_paisa).toBe(20000);
  });

  it("refuses a missing, out-of-stock, unknown or badly formed option", async () => {
    expect((await drink()).status).toBe(409);
    expect((await drink({ option_id: "opt-mango" })).status).toBe(409);
    expect((await drink({ option_id: "opt-nope" })).status).toBe(409);
    expect((await drink({ option_id: 5 })).status).toBe(400);
    expect(orderDb.createOrderAtomic).not.toHaveBeenCalled();
  });

  it("refuses an option on an item that has none", async () => {
    const response = await post({ action: "create-order", order: { id, pickup_code: "CB777777", mode: "QUICK", payment_method: "cash", items: [{ item_id: 1, name: "Samosa", quantity: 1, option_id: "opt-cola" }] } });
    expect(response.status).toBe(409);
  });
});

describe("manager station password reset", () => {
  it("stores a hashed station password and accepts it at the next login", async () => {
    delete process.env.CANTEEN_CASHIER_PASSWORD;
    const newPassword = "Cashdesk-reset-2026!";
    const reset = await post({ action: "reset-station-password", station: "cashier", new_password: newPassword }, MANAGER);
    expect(reset.status).toBe(200);

    const saved = mockStore.values.get("staff-passwords/cashier");
    expect(saved).toMatchObject({ salt: expect.any(String), hash: expect.any(String) });
    expect(saved.hash).not.toBe(newPassword);

    const login = (password) => post({ action: "login", station: "cashier", username: "cashdesk", password });
    expect((await login("old-cashier-password" )).status).toBe(401);
    const accepted = await login(newPassword);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, station: "cashier", username: "cashdesk" });
  });
});

describe("homepage banner settings", () => {
  it("returns a saved replacement image from the student-facing banner endpoint", async () => {
    const slides = [{ id: "cedarbite-hero-1", kicker: "CEDAR COLLEGE", title: "Fresh lunch", highlight: "made easy.", description: "Browse the menu and collect on campus.", image_data: "data:image/jpeg;base64,AA==", active: true }];
    const saved = await post({ action: "set-hero-slides", slides }, MANAGER);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ slides });

    const studentView = await get("hero-slides");
    expect(studentView.status).toBe(200);
    expect(await studentView.json()).toEqual({ slides });
  });
});
