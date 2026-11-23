import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

// A real JSON Response, so the app's content-type check (added in 0ceae63) and the
// Supabase client both see what a real server would send.
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const staffUser = (permissions: string[]) => ({
  email: "station@canteen.local",
  role: "DEMO_CANTEEN",
  email_verified: true,
  student_id: null,
  permissions,
  csrf_token: "test-csrf",
});

function setStationSession(path: string, station: string, permissions: string[]) {
  window.history.replaceState({}, "", path);
  localStorage.setItem("cedarbite-demo-user", JSON.stringify(staffUser(permissions)));
  sessionStorage.setItem("cedarbite-canteen-session", "test-station-password");
  sessionStorage.setItem("cedarbite-canteen-username", station === "cashier" ? "cashdesk" : "manager");
  sessionStorage.setItem("cedarbite-canteen-role", station);
}

describe("cash desk and order workflow actions", () => {
  let requests: { url: string; method: string; body?: Record<string, unknown> }[];
  let queueOrder: Record<string, any>;
  let cashPaid: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T03:00:00.000Z"));
    vi.spyOn(window, "setInterval").mockReturnValue(0 as unknown as number);
    localStorage.clear();
    sessionStorage.clear();
    requests = [];
    cashPaid = false;
    queueOrder = {
      id: "workflow-order-1",
      status: "SUBMITTED",
      mode: "QUICK",
      pickup_code: "CB123456",
      created_at: new Date().toISOString(),
      items: [{ name: "Test sandwich", quantity: 1 }],
      total_display: "Rs 300",
      payment_method: "cash",
      payment_status: "UNPAID",
      student_id: "2526245",
      waiting_minutes: 0,
    };

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });

      if (url === "/api/pickup-windows") return jsonResponse({ windows: [] });
      if (url === "/api/auth/google/status") return jsonResponse({ configured: false });
      if (method === "POST" && body?.action === "login") return jsonResponse({ ok: true, station: body.station, username: body.username });
      if (url === "/api/menu") return jsonResponse({ categories: [] });
      if (url.includes("scope=menu")) return jsonResponse({ categories: null });
      if (url.includes("scope=availability")) return jsonResponse({ availability: {} });
      if (url.includes("scope=cash-desk")) return jsonResponse({ orders: cashPaid ? [] : [{ ...queueOrder, payment_status: "UNPAID" }] });
      if (url.includes("scope=queue")) return jsonResponse({ orders: [queueOrder] });
      if (url.includes("scope=pickup-windows")) return jsonResponse({ windows: [] });

      if (method === "POST" && body?.action === "mark-cash-paid") {
        cashPaid = true;
        return jsonResponse({ order: { ...queueOrder, payment_status: "PAID", cash_received_at: new Date().toISOString() } });
      }
      if (method === "POST" && body?.action === "set-status") {
        queueOrder = { ...queueOrder, status: body.status };
        return jsonResponse({ order: queueOrder });
      }

      return jsonResponse({ error: `Unexpected test request: ${method} ${url}` }, 404);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("opens the cash desk after the server confirms that station login", async () => {
    window.history.replaceState({}, "", "/cash-desk");
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<App/>);

    fireEvent.change(await screen.findByPlaceholderText("Enter username"), { target: { value: "cashdesk" } });
    fireEvent.change(screen.getByPlaceholderText("Enter password"), { target: { value: "cashdesk-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in to cash desk" }));

    expect(await screen.findByText("Canteen workspace · shared queue and availability")).toBeInTheDocument();
    expect(requests.find((request) => request.body?.action === "login")?.body).toMatchObject({ station: "cashier", username: "cashdesk" });
  });

  it("keeps teacher and guest counter orders as separate customer types", async () => {
    setStationSession("/counter", "order_taker", ["counter.orders.create"]);
    render(<App/>);

    const customerType = await screen.findByRole("combobox", { name: "Order placed for" });
    expect(customerType).toHaveDisplayValue("Student");
    expect(screen.getByRole("option", { name: "Teacher" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Guest" })).toBeInTheDocument();

    fireEvent.change(customerType, { target: { value: "TEACHER" } });
    expect(await screen.findByPlaceholderText("Search the Cedar teacher list")).toBeInTheDocument();
    expect(document.getElementById("cedar-counter-teachers")?.querySelector('option[value="Adam Asif"]')).not.toBeNull();

    fireEvent.change(customerType, { target: { value: "GUEST" } });
    expect(await screen.findByPlaceholderText("Enter guest name")).toBeInTheDocument();
  });

  it("records cash received and removes that order from the unpaid cash list", async () => {
    setStationSession("/cash-desk", "cashier", ["cashier.manage", "wallet.cash_topup"]);
    localStorage.setItem("cedarbite-local-order-queue", JSON.stringify([{ ...queueOrder, status: "READY" }]));
    render(<App/>);

    const button = await screen.findByRole("button", { name: "Record cash received" });
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Record cash received" })).not.toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("cedarbite-local-order-queue") || "[]")[0].payment_status).toBe("PAID");
    expect(requests.some((request) => request.method === "POST" && request.body?.action === "mark-cash-paid")).toBe(false);
    expect(screen.getByText("No unpaid cash orders right now.")).toBeInTheDocument();
  });

  it("accepts a new order into Preparing and marks it ready from the Preparing list", async () => {
    queueOrder.mode = "SCHEDULED";
    setStationSession("/owner", "order_manager", ["queue.view", "menu.manage", "availability.toggle"]);
    localStorage.setItem("cedarbite-local-order-queue", JSON.stringify([queueOrder]));
    render(<App/>);

    fireEvent.click(await screen.findByRole("button", { name: /Accept order/ }));
    const readyButton = await screen.findByRole("button", { name: /Mark order ready/ });
    expect(JSON.parse(localStorage.getItem("cedarbite-local-order-queue") || "[]")[0].status).toBe("PREPARING");

    fireEvent.click(readyButton);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("cedarbite-local-order-queue") || "[]")[0].status).toBe("READY"));
    expect(screen.getByText("Order ready")).toBeInTheDocument();
    expect(requests.filter((request) => request.method === "POST" && request.body?.action === "set-status")).toHaveLength(0);
  });
});
