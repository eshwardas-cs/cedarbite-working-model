import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

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
  });

  it("records cash received and removes that order from the unpaid cash list", async () => {
    setStationSession("/cash-desk", "cashier", ["cashier.manage", "wallet.cash_topup"]);
    render(<App/>);

    const button = await screen.findByRole("button", { name: "Record cash received" });
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Record cash received" })).not.toBeInTheDocument());
    expect(requests.some((request) => request.method === "POST" && request.body?.action === "mark-cash-paid")).toBe(true);
    expect(screen.getByText("No unpaid cash orders right now.")).toBeInTheDocument();
  });

  it("accepts a new order into Preparing and marks it ready from the Preparing list", async () => {
    setStationSession("/owner", "order_manager", ["queue.view", "menu.manage", "availability.toggle"]);
    render(<App/>);

    fireEvent.click(await screen.findByRole("button", { name: /Accept order/ }));
    const readyButton = await screen.findByRole("button", { name: /Mark order ready/ });
    expect(queueOrder.status).toBe("PREPARING");

    fireEvent.click(readyButton);
    await waitFor(() => expect(queueOrder.status).toBe("READY"));
    expect(screen.getByText("Order ready")).toBeInTheDocument();
    expect(requests.filter((request) => request.method === "POST" && request.body?.action === "set-status").map((request) => request.body?.status)).toEqual(["PREPARING", "READY"]);
  });
});
