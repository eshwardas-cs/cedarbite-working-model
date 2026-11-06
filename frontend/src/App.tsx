import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { availablePickupWindows as filterPickupWindows, formatPickupTime, samplePickupWindows, type PickupWindow } from "./pickupWindows";

type User = { email: string; role: string; email_verified: boolean; student_id: string | null; permissions: string[]; csrf_token: string };
type Item = { id: number; category_id: number; name: string; description: string; price_paisa: number; price_display: string; available: boolean; quick_allowed: boolean; scheduled_allowed: boolean; prep_minutes: number | null; image_data?: string | null; addon_name?: string | null; addon_price_paisa?: number };
type Category = { id: number; name: string; items: Item[] };
type MenuItemEditValues = Pick<Item, "category_id" | "name" | "description" | "price_paisa" | "quick_allowed" | "scheduled_allowed" | "prep_minutes" | "image_data" | "addon_name" | "addon_price_paisa">;
type Order = { id: string | number; status: string; mode: string; total_display?: string; pickup_code: string; created_at: string; completed_at?: string; refunded_at?: string; refund_method?: string; refund_status?: string; pickup_window?: { start_at: string; end_at: string } | null; items: { item_id?: number; name: string; quantity: number; unit_price_paisa?: number }[]; waiting_minutes?: number; student_id?: string | null; customer_type?: "STUDENT" | "TEACHER"; customer_name?: string | null; payment_method?: string; payment_status?: string };
type Deal = { id: string; title: string; description: string; active: boolean; item_ids?: number[] };
type SalesSummary = { date: string; generated_at: string; orders_placed: number; placed_order_value_paisa: number; pending_payment_orders: number; paid_orders: number; paid_sales_paisa: number; units_sold: number; items_sold: { name: string; quantity: number }[]; payment_methods: { method: string; count: number; amount_paisa: number }[]; hourly_sales: { hour: number; amount_paisa: number }[] };
type Page = "menu" | "orders" | "owner" | "stations" | "counter" | "cashdesk" | "order-manager" | "kitchen" | "about" | "privacy" | "contact" | "team" | "confirmation";
type OrderMode = "quick" | "scheduled";
type WalletEntry = { id: string | number; label: string; amount: number; kind: "credit" | "debit"; created_at: string; method: string };
type WalletTopUpHistoryEntry = { id: string; student_id: string; amount_paisa: number; label: string; created_at: string; recorded_by?: string; method?: string; status?: string };

function pageForPath(path: string): Page {
  if (path === "/stations") return "stations";
  if (path === "/counter") return "counter";
  if (path === "/cash-desk") return "cashdesk";
  if (path === "/order-manager") return "order-manager";
  if (path === "/kitchen") return "kitchen";
  if (path.startsWith("/owner")) return "owner";
  if (path.startsWith("/my-orders")) return "orders";
  if (path === "/order-confirmation") return "confirmation";
  if (path === "/about") return "about";
  if (path === "/privacy-policy") return "privacy";
  if (path === "/contact-us") return "contact";
  if (path === "/team") return "team";
  return "menu";
}
function stationForPage(page: Page) {
  return page === "counter" ? "order_taker" : page === "cashdesk" ? "cashier" : page === "kitchen" ? "kitchen" : "order_manager";
}

const money = (paisa: number) => `Rs ${(paisa / 100).toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const pakistanDay = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const isValidSalesDate = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};
const salesDateLabel = (date: string) => isValidSalesDate(date)
  ? new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00.000Z`))
  : "Choose a summary date";
const human = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (x) => x.toUpperCase());
const orderCustomerLabel = (order: Order) => order.customer_type === "TEACHER" ? `Teacher: ${order.customer_name || "Name not provided"}` : `Student ID: ${order.student_id || "Not available"}`;
function useAutoPrintReceipt(request: { order: Order; key: string } | null) {
  useEffect(() => {
    if (!request) return;
    const timer = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(timer);
  }, [request?.key]);
}
function ReceiptPrintView({ order }: { order: Order }) {
  const pickupWindow = order.pickup_window ? `${new Date(order.pickup_window.start_at).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" })}–${new Date(order.pickup_window.end_at).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" })}` : "Quick pickup";
  return <div className="receipt-print-root"><article className="receipt-print"><header><div className="receipt-brand"><ReceiptLogoMark/><b>CedarBite</b></div><span>CEDAR COLLEGE CANTEEN</span></header><div className="receipt-divider"/><h1>ORDER RECEIPT</h1><div className="receipt-pickup"><small>PICKUP NUMBER</small><strong>{order.pickup_code}</strong></div><div className="receipt-meta"><span>Customer</span><b>{orderCustomerLabel(order)}</b><span>Order type</span><b>{order.mode === "SCHEDULED" ? `Scheduled · ${pickupWindow}` : pickupWindow}</b><span>Placed</span><b>{new Date(order.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })}</b><span>Payment</span><b>{human(order.payment_method ?? "cash")} · {human(order.payment_status ?? "unpaid")}</b></div><div className="receipt-divider"/><div className="receipt-lines">{order.items.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}</span>{item.unit_price_paisa != null && <b>{money(item.unit_price_paisa * item.quantity)}</b>}</div>)}</div><div className="receipt-divider"/><div className="receipt-total"><span>TOTAL</span><strong>{order.total_display || "—"}</strong></div><footer>Keep this receipt and show the pickup number when collecting your order.<br/>Thank you for choosing CedarBite.</footer></article></div>;
}
const stationName = (station: string | null, user?: User | null) => station === "order_taker" ? "the counter station" : station === "cashier" ? "the cash desk" : station === "kitchen" ? "the kitchen monitor" : station === "order_manager" ? "the order manager station" : user?.email ? `the student account ${user.email}` : "another account";
const sampleDeals: Deal[] = [
  { id: "sample-1", title: "Break-time bundle", description: "Pick a drink and snack to enjoy during your break.", active: true, item_ids: [-31, -32] },
  { id: "sample-2", title: "Lunch deal", description: "Chicken biryani with a cold drink, ready for scheduled pickup.", active: true, item_ids: [-21, -33] },
];
const sampleMenu: Category[] = [
  { id: -1, name: "Burgers & wraps", items: [
    { id: -11, category_id: -1, name: "Cedar chicken burger", description: "Crispy chicken, fresh lettuce, and house sauce.", price_paisa: 45000, price_display: "Rs 450", available: true, quick_allowed: false, scheduled_allowed: true, prep_minutes: 12 },
    { id: -12, category_id: -1, name: "Spicy chicken wrap", description: "A warm, spicy wrap for a filling break.", price_paisa: 38000, price_display: "Rs 380", available: true, quick_allowed: false, scheduled_allowed: true, prep_minutes: 10 },
  ] },
  { id: -2, name: "Hot favourites", items: [
    { id: -21, category_id: -2, name: "Chicken biryani", description: "Aromatic rice with chicken and raita.", price_paisa: 42000, price_display: "Rs 420", available: true, quick_allowed: false, scheduled_allowed: true, prep_minutes: 15 },
    { id: -22, category_id: -2, name: "Chicken samosa", description: "Crisp, savoury, and ready to go.", price_paisa: 12000, price_display: "Rs 120", available: true, quick_allowed: true, scheduled_allowed: false, prep_minutes: null },
    { id: -23, category_id: -2, name: "Masala fries", description: "Seasoned fries, made fresh for your break.", price_paisa: 22000, price_display: "Rs 220", available: true, quick_allowed: false, scheduled_allowed: true, prep_minutes: 8 },
  ] },
  { id: -3, name: "Drinks & snacks", items: [
    { id: -31, category_id: -3, name: "Bottled water", description: "Chilled bottled water.", price_paisa: 8000, price_display: "Rs 80", available: true, quick_allowed: true, scheduled_allowed: false, prep_minutes: null },
    { id: -32, category_id: -3, name: "Chocolate cookie", description: "A sweet treat with your break.", price_paisa: 10000, price_display: "Rs 100", available: true, quick_allowed: true, scheduled_allowed: false, prep_minutes: null },
    { id: -33, category_id: -3, name: "Cold drink", description: "A cold drink, ready to pick up or add to scheduled food.", price_paisa: 12000, price_display: "Rs 120", available: true, quick_allowed: true, scheduled_allowed: true, prep_minutes: null },
    { id: -34, category_id: -3, name: "Fresh juice", description: "Freshly prepared juice.", price_paisa: 18000, price_display: "Rs 180", available: true, quick_allowed: true, scheduled_allowed: false, prep_minutes: null },
  ] },
];
const DEMO_USER_KEY = "cedarbite-demo-user";
const LEGACY_DEMO_ORDERS_KEY = "cedarbite-demo-orders";
const CANTEEN_SESSION_KEY = "cedarbite-canteen-session";
const CANTEEN_USERNAME_KEY = "cedarbite-canteen-username";
const CANTEEN_ROLE_KEY = "cedarbite-canteen-role";
const SHARED_DATA_URL = "/.netlify/functions/shared-data";
const walletKey = (email: string) => `cedarbite-demo-wallet:${email}`;
const demoOrdersKey = (email: string) => `cedarbite-demo-orders:${email.trim().toLowerCase()}`;
function loadDemoOrders(email: string, studentId: string | null): Order[] {
  const key = demoOrdersKey(email);
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const orders = JSON.parse(saved) as Order[];
      return Array.isArray(orders) ? orders : [];
    }
    // Earlier preview versions stored orders in one shared list. Carry forward
    // only entries whose student ID matches this Cedar email's ID.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_DEMO_ORDERS_KEY) || "[]") as Order[];
    const ownOrders = Array.isArray(legacy) && studentId
      ? legacy.filter((order) => String(order.student_id ?? "") === studentId)
      : [];
    localStorage.setItem(key, JSON.stringify(ownOrders));
    return ownOrders;
  } catch {
    return [];
  }
}
function cacheDemoMenu(categories: Category[]) {
  try { localStorage.setItem("cedarbite-demo-menu", JSON.stringify(categories)); }
  catch { /* The shared menu remains the source of truth if the browser cache is full. */ }
}
async function resizeMenuImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Choose an image smaller than 8 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This image could not be prepared. Try another one.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL("image/jpeg", 0.72);
    if (imageData.length > 180_000) throw new Error("This image is still too large. Choose a simpler or smaller image.");
    return imageData;
  } finally { bitmap.close(); }
}
function itemIcon(item: Pick<Item, "name">) {
  return /drink|water|juice|soda/i.test(item.name) ? "🥤" : /fries|chips/i.test(item.name) ? "🍟" : /rice|biryani/i.test(item.name) ? "🍛" : /wrap|roll/i.test(item.name) ? "🌯" : /cake|cookie|sweet/i.test(item.name) ? "🧁" : /sandwich|toast/i.test(item.name) ? "🥪" : /samosa/i.test(item.name) ? "🥟" : /burger/i.test(item.name) ? "🍔" : "🍽️";
}
function MenuItemVisual({ item, className = "" }: { item: Item; className?: string }) {
  return item.image_data
    ? <img className={`menu-item-image ${className}`} src={item.image_data} alt={item.name} />
    : <span className={className}>{itemIcon(item)}</span>;
}
function CedarMark() {
  return <svg className="cedar-mark" viewBox="0 0 64 64" role="img" aria-label="CedarBite logo mark"><path d="M9 25C15 14 24 9 32 8v13C24 22 18 26 14 33z" fill="#ffc928"/><path d="M55 25C49 14 40 9 32 8v13c8 1 14 5 18 12z" fill="#102b4c"/><path d="M12 36h40v5H12z" fill="#102b4c"/><path d="M19 34a13 13 0 0 1 26 0z" fill="#102b4c"/><path d="M20 44v11h5V44m7 0v11h5V44m7 0v11h5V44" fill="#ffc928"/><circle cx="49" cy="49" r="9" fill="#fff" stroke="#102b4c" strokeWidth="3"/><path d="m45 49 3 3 5-6" fill="none" stroke="#ffc928" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function ReceiptLogoMark() {
  return <svg className="receipt-logo-mark" viewBox="0 0 48 48" role="img" aria-label="CedarBite serving cloche logo"><path fill="currentColor" d="M5 18C10 8 18 3 24 3v10c-6 2-10 5-13 12zm38 0C38 8 30 3 24 3v10c6 2 10 5 13 12zM12 27a12 12 0 0 1 24 0zM7 29h34v5H7zm6 8h6v8h-6zm11 0h6v8h-6zm11 0h6v8h-6z"/></svg>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [csrf, setCsrf] = useState("");
  const [canteenPassword, setCanteenPassword] = useState(() => sessionStorage.getItem(CANTEEN_SESSION_KEY) || "");
  const [canteenUsername, setCanteenUsername] = useState(() => sessionStorage.getItem(CANTEEN_USERNAME_KEY) || "manager");
  const [canteenStation, setCanteenStation] = useState(() => {
    const routePage = pageForPath(window.location.pathname);
    if (["counter", "cashdesk", "order-manager", "kitchen"].includes(routePage)) return stationForPage(routePage);
    return sessionStorage.getItem(CANTEEN_ROLE_KEY) || "order_manager";
  });
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuLoadedRole, setMenuLoadedRole] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderConfirmation, setOrderConfirmation] = useState<Order | null>(null);
  const [queue, setQueue] = useState<Order[]>([]);
  const [orderHistory, setOrderHistory] = useState<Order[]>([]);
  const [salesSummary, setSalesSummary] = useState<SalesSummary | null>(null);
  const [salesSummaryDates, setSalesSummaryDates] = useState<string[]>([]);
  const [salesSummaryLoading, setSalesSummaryLoading] = useState(false);
  const [salesSummaryError, setSalesSummaryError] = useState("");
  const [walletTopUpHistory, setWalletTopUpHistory] = useState<WalletTopUpHistoryEntry[]>([]);
  const [walletHistoryError, setWalletHistoryError] = useState("");
  const [walletHistoryLoading, setWalletHistoryLoading] = useState(false);
  const [queuePendingIds, setQueuePendingIds] = useState<string[]>([]);
  const queueLoadInFlightRef = useRef(false);
  const queueRefreshRequestedRef = useRef(false);
  const queueRevisionRef = useRef(0);
  const queueRefreshRef = useRef<() => void>(() => {});
  const queueMutationPendingRef = useRef(new Set<string>());
  const [availabilityPending, setAvailabilityPending] = useState<number[]>([]);
  const [menuMutationPending, setMenuMutationPending] = useState(false);
  const menuMutationInFlightRef = useRef(false);
  const itemAddInFlightRef = useRef(false);
  const [itemAddPending, setItemAddPending] = useState(false);
  const availabilityPendingRef = useRef(new Set<number>());
  const availabilityVersionRef = useRef(new Map<number, number>());
  const menuRevisionRef = useRef(0);
  const orderSubmittingRef = useRef(false);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [showOrderConfirmation, setShowOrderConfirmation] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [pickupWindows, setPickupWindows] = useState<PickupWindow[]>([]);
  const pickupWindowsFromApiRef = useRef(false);
  const [scheduleClock, setScheduleClock] = useState(Date.now());
  const [selectedWindow, setSelectedWindow] = useState("");
  const [dealsActive, setDealsActive] = useState(false);
  const [orderingReason, setOrderingReason] = useState("Ordering is open");
  const [demoEmail, setDemoEmail] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [walletBalance, setWalletBalance] = useState(0);
  const [walletEntries, setWalletEntries] = useState<WalletEntry[]>([]);
  const [walletOpen, setWalletOpen] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("500");
  const [topUpMethod, setTopUpMethod] = useState("easypaisa");
  const [topUpSubmitting, setTopUpSubmitting] = useState(false);
  const [walletMessage, setWalletMessage] = useState("");
  const [cashTopUpPending, setCashTopUpPending] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [addOnPromptItem, setAddOnPromptItem] = useState<Item | null>(null);
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  const [menuError, setMenuError] = useState("");
  const [googleReady, setGoogleReady] = useState(false);
  const [page, setPage] = useState<Page>(() => pageForPath(window.location.pathname));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("cedarbite-color-mode") === "dark");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [orderMode, setOrderMode] = useState<OrderMode>("quick");
  const [cartOpen, setCartOpen] = useState(false);
  const [deals, setDeals] = useState<Deal[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cedarbite-preview-deals") || "null") as Deal[] | null;
      const current = saved ?? sampleDeals;
      return current.map((deal) => deal.id === "sample-2" ? { ...deal, title: "Lunch deal", description: "Chicken biryani with a cold drink, ready for scheduled pickup.", item_ids: [-21, -33] } : deal);
    } catch { return sampleDeals; }
  });
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const loginDialog = useRef<HTMLDialogElement>(null);
  const cashTopUpRequest = useRef<{ signature: string; key: string } | null>(null);
  const [dealMessage, setDealMessage] = useState("");
  const [itemMessage, setItemMessage] = useState("");
  const availablePickupWindows = useMemo(
    () => filterPickupWindows(pickupWindows, new Date(scheduleClock)),
    [pickupWindows, scheduleClock],
  );

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if ((init.method ?? "GET").toUpperCase() !== "GET" && csrf) headers.set("X-CSRF-Token", csrf);
    if (canteenPassword && path.startsWith(SHARED_DATA_URL)) {
      headers.set("X-Canteen-Password", canteenPassword);
      headers.set("X-Canteen-Username", canteenUsername);
      headers.set("X-Canteen-Role", canteenStation);
    }
    const response = await fetch(path, { ...init, headers, credentials: "include" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
    return body as T;
  }, [canteenPassword, canteenStation, canteenUsername, csrf]);

  const loadPickupSchedule = useCallback(async () => {
    try {
      const result = await request<{ windows: PickupWindow[] }>("/api/pickup-windows", { cache: "no-store" });
      if (Array.isArray(result.windows)) return result.windows;
    } catch { /* Use the shared Netlify schedule when the API route is not deployed. */ }
    const result = await request<{ windows: PickupWindow[] }>(`${SHARED_DATA_URL}?scope=pickup-windows`, { cache: "no-store" });
    if (!Array.isArray(result.windows)) throw new Error("Pickup schedule is unavailable.");
    return result.windows;
  }, [request]);

  const loadSharedAvailability = useCallback(async () => {
    if (user?.role !== "DEMO_CANTEEN" && user?.role !== "DEMO_STUDENT") return;
    const versionsAtRequest = new Map(availabilityVersionRef.current);
    const pendingAtRequest = new Set(availabilityPendingRef.current);
    try {
      const result = await request<{ availability: Record<string, boolean> }>(`${SHARED_DATA_URL}?scope=availability`, { cache: "no-store" });
      setCategories((current) => current.map((category) => ({ ...category, items: category.items.map((item) => {
        const id = item.id;
        if (pendingAtRequest.has(id) || availabilityPendingRef.current.has(id) || (availabilityVersionRef.current.get(id) ?? 0) !== (versionsAtRequest.get(id) ?? 0)) return item;
        return { ...item, available: result.availability[String(id)] ?? item.available };
      }) })));
    } catch { /* The static menu remains usable if shared availability is temporarily unavailable. */ }
  }, [request, user?.role]);

  const userRole = user?.role;
  const loadMenu = useCallback(async (manage = false) => {
    const revisionAtStart = menuRevisionRef.current;
    if (userRole?.startsWith("DEMO_") || !userRole) {
      try {
        const shared = await request<{ categories: Category[] | null }>(`${SHARED_DATA_URL}?scope=menu`, { cache: "no-store" });
        if (shared.categories !== null && revisionAtStart === menuRevisionRef.current && availabilityPendingRef.current.size === 0) {
          const latestCategories = shared.categories;
          setCategories(latestCategories);
          setMenuLoadedRole(userRole ?? "anonymous");
          if (userRole?.startsWith("DEMO_")) cacheDemoMenu(latestCategories);
          setMenuError("");
          if (userRole?.startsWith("DEMO_")) void loadSharedAvailability();
          return;
        }
      } catch { /* Continue with a local fallback for demo accounts, or the API menu for real accounts. */ }
    }
    if (userRole?.startsWith("DEMO_")) {
      if (revisionAtStart !== menuRevisionRef.current || availabilityPendingRef.current.size > 0) return;
      const saved = localStorage.getItem("cedarbite-demo-menu");
      if (saved) { try { setCategories(JSON.parse(saved) as Category[]); setMenuLoadedRole(userRole); setMenuError(""); void loadSharedAvailability(); } catch { localStorage.removeItem("cedarbite-demo-menu"); } return; }
      if (userRole === "DEMO_CANTEEN") { setCategories(sampleMenu); setMenuLoadedRole(userRole); void loadSharedAvailability(); return; }
    }
    try { const result = await request<{ categories: Category[] }>(manage ? "/api/menu/manage" : "/api/menu"); if (revisionAtStart === menuRevisionRef.current && availabilityPendingRef.current.size === 0) { setCategories(result.categories); setMenuLoadedRole(userRole ?? "anonymous"); setMenuError(""); } }
    catch { if (revisionAtStart === menuRevisionRef.current && availabilityPendingRef.current.size === 0) { setCategories(sampleMenu); setMenuLoadedRole(userRole ?? "anonymous"); setMenuError(""); } }
  }, [loadSharedAvailability, request, userRole]);
  const loadQueue = useCallback(async () => {
    if (canteenStation === "order_taker") return;
    if (queueLoadInFlightRef.current) { queueRefreshRequestedRef.current = true; return; }
    queueLoadInFlightRef.current = true;
    const revision = queueRevisionRef.current;
    try {
      const scope = canteenStation === "cashier" ? "cash-desk" : canteenStation === "kitchen" ? "kitchen" : "queue";
      const path = user?.role === "DEMO_CANTEEN" ? `${SHARED_DATA_URL}?scope=${scope}` : "/api/queue";
      const result = await request<{ orders: Order[] }>(path, { cache: "no-store" });
      if (revision === queueRevisionRef.current) setQueue(result.orders);
    } catch { /* Keep the last loaded queue visible without a recurring popup during refresh failures. */ }
    finally {
      queueLoadInFlightRef.current = false;
      if (queueRefreshRequestedRef.current) {
        queueRefreshRequestedRef.current = false;
        queueRefreshRef.current();
      }
    }
  }, [canteenStation, page, request, user]);
  const loadOrderHistory = useCallback(async () => {
    if (user?.role !== "DEMO_CANTEEN" || canteenStation !== "order_manager") return;
    try {
      const result = await request<{ orders: Order[] }>(`${SHARED_DATA_URL}?scope=history`, { cache: "no-store" });
      setOrderHistory(result.orders);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Order history could not be loaded.");
    }
  }, [canteenStation, request, user]);
  const loadWalletTopUpHistory = useCallback(async () => {
    if (user?.role !== "DEMO_CANTEEN" || canteenStation !== "cashier") return;
    setWalletHistoryLoading(true);
    setWalletHistoryError("");
    try {
      const result = await request<{ entries: typeof walletTopUpHistory }>(`${SHARED_DATA_URL}?scope=wallet-history`, { cache: "no-store" });
      if (!Array.isArray(result.entries)) throw new Error("The cash desk returned an unexpected history response.");
      setWalletTopUpHistory(result.entries);
    } catch (error) {
      setWalletHistoryError(error instanceof Error ? error.message : "Wallet top-up history could not be loaded.");
    } finally {
      setWalletHistoryLoading(false);
    }
  }, [canteenStation, request, user]);
  const loadSalesSummaryDates = useCallback(async () => {
    if (user?.role !== "DEMO_CANTEEN" || canteenStation !== "order_manager") return;
    try {
      const result = await request<{ dates: string[] }>(`${SHARED_DATA_URL}?scope=sales-dates`, { cache: "no-store" });
      setSalesSummaryDates(result.dates);
    } catch (error) {
      setSalesSummaryError(error instanceof Error ? error.message : "Daily summaries could not be loaded.");
    }
  }, [canteenStation, request, user]);
  const loadSalesSummary = useCallback(async (date = pakistanDay()) => {
    if (!isValidSalesDate(date) || user?.role !== "DEMO_CANTEEN" || canteenStation !== "order_manager") return;
    setSalesSummaryLoading(true);
    setSalesSummaryError("");
    try {
      const result = await request<{ report: SalesSummary }>(`${SHARED_DATA_URL}?scope=sales-summary&date=${encodeURIComponent(date)}`, { cache: "no-store" });
      setSalesSummary(result.report);
      setSalesSummaryDates((current) => [...new Set([date, ...current])].sort((a, b) => b.localeCompare(a)));
    } catch (error) {
      setSalesSummaryError(error instanceof Error ? error.message : "The daily summary could not be loaded.");
    } finally { setSalesSummaryLoading(false); }
  }, [canteenStation, request, user]);
  const deleteSalesSummary = useCallback(async (date: string) => {
    await request<{ deleted: boolean; date: string }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "delete-sales-summary", date }) });
    setSalesSummaryDates((current) => current.filter((savedDate) => savedDate !== date));
    setSalesSummary((current) => current?.date === date ? null : current);
  }, [request]);
  queueRefreshRef.current = () => { void loadQueue(); };
  const loadOrders = useCallback(async () => {
    try { const result = await request<{ orders: Order[] }>("/api/orders"); setOrders(result.orders); }
    catch (error) { setToast(error instanceof Error ? error.message : "Orders unavailable."); }
  }, [request]);
  const loadWallet = useCallback(async () => {
    if (user?.role === "DEMO_STUDENT") {
      try {
        const saved = JSON.parse(localStorage.getItem(walletKey(user.email)) || "null") as { balance?: number; entries?: WalletEntry[] } | null;
        let balance = Number(saved?.balance) || 0;
        let entries = Array.isArray(saved?.entries) ? saved.entries : [];
        const result = await request<{ entries: { id: string; label: string; amount_paisa: number; kind: "credit" | "debit"; created_at: string; method: string }[] }>(`${SHARED_DATA_URL}?scope=student-wallet&student_id=${encodeURIComponent(user.student_id || "")}`, { cache: "no-store" });
        const knownIds = new Set(entries.map((entry) => String(entry.id)));
        const unseenCredits = result.entries.filter((entry) => entry.kind === "credit" && !knownIds.has(String(entry.id)));
        for (const entry of unseenCredits) {
          balance += entry.amount_paisa;
          entries = [{ id: entry.id, label: entry.label, amount: entry.amount_paisa, kind: "credit", created_at: entry.created_at, method: entry.method }, ...entries];
        }
        if (unseenCredits.length) localStorage.setItem(walletKey(user.email), JSON.stringify({ balance, entries }));
        setWalletBalance(balance);
        setWalletEntries(entries);
      } catch { /* Keep the saved wallet available if shared storage is offline. */ }
      return;
    }
    if (!user || user.role.startsWith("DEMO_")) return;
    try {
      const result = await request<{ balance_paisa: number; entries: { id: number; label: string; amount_paisa: number; kind: "credit" | "debit"; created_at: string; method: string }[] }>("/api/wallet");
      setWalletBalance(result.balance_paisa);
      setWalletEntries(result.entries.map((entry) => ({ id: entry.id, label: entry.label, amount: entry.amount_paisa, kind: entry.kind, created_at: entry.created_at, method: entry.method })));
    } catch (error) {
      if (user.role === "student" || user.role === "staff_customer") setWalletMessage(error instanceof Error ? error.message : "Wallet could not be loaded.");
    }
  }, [request, user]);

  useEffect(() => {
    document.title = page === "owner" ? "CedarBite Canteen Console" : page === "confirmation" ? "Order confirmed · CedarBite" : page === "about" ? "About CedarBite" : page === "privacy" ? "Privacy Policy · CedarBite" : page === "contact" ? "Contact CedarBite" : page === "team" ? "Team behind CedarBite" : "CedarBite — order your break";
    void loadMenu();
    void loadPickupSchedule().then((windows) => {
      pickupWindowsFromApiRef.current = true;
      setPickupWindows(windows);
    }).catch(() => {
      pickupWindowsFromApiRef.current = false;
      setPickupWindows(samplePickupWindows());
    });
    void request<{ configured: boolean }>("/api/auth/google/status").then((result) => setGoogleReady(result.configured)).catch(() => setGoogleReady(false));
    const savedDemoUser = localStorage.getItem(DEMO_USER_KEY);
    if (savedDemoUser) { try { const result = JSON.parse(savedDemoUser) as User; if (result.role === "DEMO_CANTEEN" && !sessionStorage.getItem(CANTEEN_SESSION_KEY)) { localStorage.removeItem(DEMO_USER_KEY); setUser(null); } else { setUser(result); setCsrf(result.csrf_token); } } catch { localStorage.removeItem(DEMO_USER_KEY); setUser(null); } }
    else void request<User>("/api/auth/me").then((result) => { setUser(result); setCsrf(result.csrf_token); }).catch(() => { setUser(null); setCsrf(""); });
    if (savedDemoUser) {
      try {
        const savedUser = JSON.parse(savedDemoUser) as User;
        setOrders(savedUser.role === "DEMO_STUDENT" ? loadDemoOrders(savedUser.email, savedUser.student_id) : []);
      } catch { setOrders([]); }
    } else setOrders([]);
    const params = new URLSearchParams(window.location.search);
    if (params.get("signin_error")) { setToast(params.get("signin_error") ?? "Cedar sign-in failed."); window.history.replaceState({}, "", window.location.pathname); }
  }, [loadMenu, loadPickupSchedule, page, request]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    localStorage.setItem("cedarbite-color-mode", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setScheduleClock(now);
      if (!pickupWindowsFromApiRef.current) setPickupWindows(samplePickupWindows(new Date(now)));
      void loadPickupSchedule().then((windows) => {
        pickupWindowsFromApiRef.current = true;
        setPickupWindows(windows);
      }).catch(() => {
        if (!pickupWindowsFromApiRef.current) setPickupWindows(samplePickupWindows(new Date(now)));
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadPickupSchedule]);

  useEffect(() => {
    if (selectedWindow && !availablePickupWindows.some((window) => String(window.id) === selectedWindow)) setSelectedWindow("");
  }, [availablePickupWindows, selectedWindow]);

  useEffect(() => {
    if (user?.role === "DEMO_CANTEEN") { void loadMenu(true); void loadQueue(); void loadSharedAvailability(); return; }
    if (user?.role === "DEMO_STUDENT") { setOrders(loadDemoOrders(user.email, user.student_id)); void loadMenu(); void loadWallet(); return; }
    if (user?.permissions.includes("queue.view")) void loadQueue();
    if (user?.permissions.includes("orders.view_own")) void loadOrders();
    if (user?.role === "student" || user?.role === "staff_customer") void loadWallet();
    void loadMenu(Boolean(user?.permissions.includes("menu.manage") || user?.permissions.includes("availability.toggle")));
  }, [user, page, loadMenu, loadOrders, loadQueue, loadWallet]);
  useEffect(() => { localStorage.setItem("cedarbite-preview-deals", JSON.stringify(deals)); }, [deals]);
  useEffect(() => { if (user?.role === "DEMO_STUDENT") { try { const saved = JSON.parse(localStorage.getItem(walletKey(user.email)) || "null"); setWalletBalance(saved?.balance ?? 0); setWalletEntries(saved?.entries ?? []); } catch { setWalletBalance(0); setWalletEntries([]); } } }, [user]);
  useEffect(() => {
    if (!(["owner", "order-manager", "counter", "cashdesk", "kitchen"] as Page[]).includes(page) || user?.role !== "DEMO_CANTEEN") return;
    const refreshQueue = () => { if (!document.hidden) void loadQueue(); };
    const timer = window.setInterval(refreshQueue, 2_000);
    window.addEventListener("focus", refreshQueue);
    document.addEventListener("visibilitychange", refreshQueue);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshQueue); document.removeEventListener("visibilitychange", refreshQueue); };
  }, [loadQueue, page, user?.role]);
  useEffect(() => {
    if (page !== "menu" && !(["owner", "order-manager", "counter", "cashdesk", "kitchen"] as Page[]).includes(page)) return;
    const refreshAvailability = () => {
      if (user?.role === "DEMO_CANTEEN") void loadSharedAvailability();
      else if (user?.role === "DEMO_STUDENT") void loadMenu();
      else void loadMenu(Boolean(user?.permissions.includes("menu.manage") || user?.permissions.includes("availability.toggle")));
    };
    refreshAvailability();
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshAvailability();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadMenu, loadSharedAvailability, page, user]);

  const canManage = user?.permissions.includes("menu.manage") ?? false;
  const canToggle = user?.permissions.includes("availability.toggle") ?? false;
  const canQueue = user?.permissions.includes("queue.view") ?? false;
  const canSeeOrders = user?.permissions.includes("orders.view_own") ?? false;
  const items = useMemo(() => categories.flatMap((category) => category.items.map((item) => ({ ...item, category: category.name }))), [categories]);
  const menuReady = menuLoadedRole === (user?.role ?? "anonymous");
  const modeCategories = categories.map((category) => ({ ...category, items: category.items.filter((item) => orderMode === "quick" ? item.quick_allowed : item.scheduled_allowed) }));
  const availableModeCategories = modeCategories.filter((category) => category.items.length > 0);
  const shownCategories = (categoryFilter === "All" ? availableModeCategories : availableModeCategories.filter((category) => category.name === categoryFilter));
  const quickOrdersOpen = true;
  const cartCount = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
  const cartTotal = Object.entries(cart).reduce((sum, [key, quantity]) => { const [id, variant] = key.split(":"); const item = items.find((candidate) => candidate.id === Number(id)); return sum + (item ? item.price_paisa + (variant === "addon" ? item.addon_price_paisa ?? 0 : 0) : 0) * quantity; }, 0);

  function navigate(next: Page) {
    setPage(next);
    if (next === "menu") setDealsActive(false);
    setMobileMenuOpen(false);
    const url = next === "owner" ? "/owner" : next === "stations" ? "/stations" : next === "counter" ? "/counter" : next === "cashdesk" ? "/cash-desk" : next === "order-manager" ? "/order-manager" : next === "kitchen" ? "/kitchen" : next === "orders" ? "/my-orders" : next === "confirmation" ? "/order-confirmation" : next === "about" ? "/about" : next === "privacy" ? "/privacy-policy" : next === "contact" ? "/contact-us" : next === "team" ? "/team" : "/";
    window.history.pushState({}, "", url);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function returnToActiveStation() {
    const active = sessionStorage.getItem(CANTEEN_ROLE_KEY);
    navigate(active === "order_taker" ? "counter" : active === "cashier" ? "cashdesk" : active === "kitchen" ? "kitchen" : active === "order_manager" ? "order-manager" : "menu");
  }
  useEffect(() => {
    const onPop = () => setPage(pageForPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  function startSignIn() { if (!googleReady) { setToast("Cedar Google sign-in has not been configured for this preview yet."); return; } window.location.assign(`/api/auth/google/start?next=${encodeURIComponent(page === "owner" ? "/owner" : "/")}`); }
  function demoSignIn(emailValue: string, role: "DEMO_STUDENT" | "DEMO_CANTEEN" = "DEMO_STUDENT") {
    const email = emailValue.trim().toLowerCase();
    if (!email.endsWith("@cedar.edu.pk")) { setToast("Use a Cedar College email ending in @cedar.edu.pk."); return; }
    const localPart = email.split("@")[0];
    const demoUser: User = { email, role, email_verified: true, student_id: /^\d+$/.test(localPart) ? localPart : null, permissions: role === "DEMO_CANTEEN" ? ["orders.view_own", "queue.view", "menu.manage", "availability.toggle"] : ["orders.view_own"], csrf_token: "demo-local" };
    localStorage.setItem(DEMO_USER_KEY, JSON.stringify(demoUser)); setUser(demoUser); setCsrf(demoUser.csrf_token); loginDialog.current?.close(); if (role === "DEMO_STUDENT") { setOrders(loadDemoOrders(email, demoUser.student_id)); try { const saved = JSON.parse(localStorage.getItem(walletKey(email)) || "null"); setWalletBalance(saved?.balance ?? 0); setWalletEntries(saved?.entries ?? []); } catch { setWalletBalance(0); setWalletEntries([]); } setToast(""); } else setToast("Canteen workspace opened.");
  }
  async function demoStaffSignIn(username: string, password: string, station = "order_manager") {
    try {
      const response = await fetch(SHARED_DATA_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "login", station, username: username.trim(), password }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Sign in failed (${response.status}).`);
    } catch (error) { throw new Error(error instanceof Error ? error.message : "Canteen sign-in could not be verified."); }
    const permissions: Record<string, string[]> = {
      order_manager: ["queue.view", "menu.manage", "availability.toggle"],
      order_taker: ["counter.orders"],
      cashier: ["cashier.manage", "wallet.cash_topup"],
      kitchen: ["kitchen.view"],
    };
    const demoUser: User = { email: `${station}@canteen.local`, role: "DEMO_CANTEEN", email_verified: true, student_id: null, permissions: permissions[station] ?? [], csrf_token: "demo-local" };
    sessionStorage.setItem(CANTEEN_SESSION_KEY, password); sessionStorage.setItem(CANTEEN_USERNAME_KEY, username.trim()); sessionStorage.setItem(CANTEEN_ROLE_KEY, station); setCanteenPassword(password); setCanteenUsername(username.trim()); setCanteenStation(station); localStorage.setItem(DEMO_USER_KEY, JSON.stringify(demoUser)); setUser(demoUser); setCsrf(demoUser.csrf_token); setToast("Canteen workspace opened.");
  }
  async function changeStaffPassword(newPassword: string) {
    const station = canteenStation;
    await request(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "change-password", station, new_password: newPassword }) });
    sessionStorage.setItem(CANTEEN_SESSION_KEY, newPassword);
    setCanteenPassword(newPassword);
    setToast("Your station password has been changed.");
  }
  async function resetStaffPassword(station: string, newPassword: string) {
    await request(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "reset-station-password", station, new_password: newPassword }) });
    setToast(`The ${station === "order_taker" ? "counter" : station === "cashier" ? "cash desk" : "kitchen monitor"} password has been reset.`);
  }
  async function markCashPaid(order: Order) {
    const orderId = String(order.id);
    if (queueMutationPendingRef.current.has(orderId)) return;
    queueMutationPendingRef.current.add(orderId);
    queueRevisionRef.current += 1;
    setQueuePendingIds((current) => [...new Set([...current, orderId])]);
    try {
      const result = await request<{ order?: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "mark-cash-paid", order_id: orderId }) });
      if (!result.order || result.order.payment_status !== "PAID") throw new Error("The cash desk did not confirm this receipt.");
      queueRevisionRef.current += 1;
      setQueue((current) => current.filter((entry) => String(entry.id) !== orderId));
      setToast(`Cash received for order ${order.pickup_code}.`);
    } catch (error) {
      queueRevisionRef.current += 1;
      setToast(error instanceof Error ? error.message : "Cash receipt was not recorded.");
    }
    finally {
      queueMutationPendingRef.current.delete(orderId);
      setQueuePendingIds((current) => current.filter((id) => id !== orderId));
      void loadQueue();
    }
  }
  async function signOut() {
    const demoUser = user?.role.startsWith("DEMO_") ?? false;
    const hasStationSession = Boolean(sessionStorage.getItem(CANTEEN_SESSION_KEY) || sessionStorage.getItem(CANTEEN_ROLE_KEY));
    if (demoUser) localStorage.removeItem(DEMO_USER_KEY);
    if (demoUser || (!user && hasStationSession)) {
      sessionStorage.removeItem(CANTEEN_SESSION_KEY);
      sessionStorage.removeItem(CANTEEN_USERNAME_KEY);
      sessionStorage.removeItem(CANTEEN_ROLE_KEY);
      setCanteenPassword(""); setCanteenUsername(""); setCanteenStation("order_manager"); setQueue([]);
      setUser(null); setCsrf(""); setToast("You are signed out."); return;
    }
    if (hasStationSession) {
      sessionStorage.removeItem(CANTEEN_SESSION_KEY);
      sessionStorage.removeItem(CANTEEN_USERNAME_KEY);
      sessionStorage.removeItem(CANTEEN_ROLE_KEY);
      setCanteenPassword(""); setCanteenUsername(""); setCanteenStation("order_manager"); setQueue([]);
    }
    if (!user) { setToast("You are signed out."); return; }
    try { await request("/api/auth/logout", { method: "POST" }); setUser(null); setCsrf(""); setToast("You are signed out."); }
    catch (error) { setToast(error instanceof Error ? error.message : "Sign out failed."); }
  }
  async function cashWalletTopUp(form: HTMLFormElement) {
    const data = new FormData(form);
    const student_id = String(data.get("student_id") ?? "").trim();
    const amount = Number(data.get("amount"));
    const note = String(data.get("note") ?? "").trim();
    if (!/^\d{7}$/.test(student_id)) { setWalletMessage("Enter the student’s 7-digit Cedar ID."); return; }
    if (!Number.isFinite(amount) || amount < 50 || amount > 5000) { setWalletMessage("Enter a cash amount from Rs 50 to Rs 5,000."); return; }
    if (user?.role === "DEMO_CANTEEN" && canteenStation === "cashier") {
      if (cashTopUpPending) return;
      const signature = `${student_id}:${Math.round(amount * 100)}:${note}`;
      if (!cashTopUpRequest.current || cashTopUpRequest.current.signature !== signature) cashTopUpRequest.current = { signature, key: crypto.randomUUID() };
      setWalletMessage("Recording cash received…");
      setCashTopUpPending(true);
      try {
        const result = await request<{ student_id: string; balance_paisa: number }>(SHARED_DATA_URL, {
          method: "POST",
          body: JSON.stringify({ action: "cash-topup", student_id, amount_paisa: Math.round(amount * 100), note, idempotency_key: cashTopUpRequest.current.key }),
        });
        setWalletMessage(`Added ${money(Math.round(amount * 100))} for student ${result.student_id}. New balance: ${money(result.balance_paisa)}.`);
        cashTopUpRequest.current = null;
        form.reset();
        void loadWalletTopUpHistory();
      } catch (error) { setWalletMessage(error instanceof Error ? error.message : "Cash top-up was not recorded."); }
      finally { setCashTopUpPending(false); }
      return;
    }
    if (user?.role === "DEMO_CANTEEN") {
      const email = `${student_id}@cedar.edu.pk`;
      const amount_paisa = Math.round(amount * 100);
      try {
        const previous = JSON.parse(localStorage.getItem(walletKey(email)) || "null") as { balance?: number; entries?: WalletEntry[] } | null;
        const entry: WalletEntry = { id: crypto.randomUUID(), label: note || "Cash top-up at canteen counter", amount: amount_paisa, kind: "credit", created_at: new Date().toISOString(), method: "Cash at counter" };
        const entries = Array.isArray(previous?.entries) ? previous.entries : [];
        const balance = (Number(previous?.balance) || 0) + amount_paisa;
        localStorage.setItem(walletKey(email), JSON.stringify({ balance, entries: [entry, ...entries] }));
        setWalletMessage(`Added ${money(amount_paisa)} for student ${student_id}. Browser-only balance: ${money(balance)}. Sign in as that student in this same browser to view it.`);
        form.reset();
      } catch {
        setWalletMessage("Could not save the browser-only top-up. Check that this browser allows site storage.");
      }
      return;
    }
    if (cashTopUpPending) return;
    const signature = `${student_id}:${Math.round(amount * 100)}:${note}`;
    if (!cashTopUpRequest.current || cashTopUpRequest.current.signature !== signature) {
      cashTopUpRequest.current = { signature, key: crypto.randomUUID() };
    }
    setWalletMessage("Recording cash received…");
    setCashTopUpPending(true);
    try {
      const result = await request<{ student_id: string; balance_paisa: number }>("/api/wallet/cash-topups", {
        method: "POST", headers: { "Idempotency-Key": cashTopUpRequest.current.key },
        body: JSON.stringify({ student_id, amount_paisa: Math.round(amount * 100), note }),
      });
      setWalletMessage(`Added ${money(Math.round(amount * 100))} for student ${result.student_id}. New balance: ${money(result.balance_paisa)}.`);
      cashTopUpRequest.current = null;
      form.reset();
    } catch (error) { setWalletMessage(error instanceof Error ? error.message : "Cash top-up was not recorded."); }
    finally { setCashTopUpPending(false); }
  }
  function addToCart(id: number, amount = 1, withAddon = false) { const key = `${id}${withAddon ? ":addon" : ""}`; setCart((current) => { const next = { ...current, [key]: Math.min(20, Math.max(0, (current[key] ?? 0) + amount)) }; if (!next[key]) delete next[key]; return next; }); }
  function requestAddToCart(item: Item) { if (item.addon_name?.trim()) { setAddOnPromptItem(item); return; } addToCart(item.id); setCartOpen(true); }
  function saveWallet(balance: number, entries: WalletEntry[]) { if (user?.email) localStorage.setItem(walletKey(user.email), JSON.stringify({ balance, entries })); setWalletBalance(balance); setWalletEntries(entries); }
  async function demoTopUp() {
    const amount = Math.round(Number(topUpAmount) * 100);
    if (user?.role !== "DEMO_STUDENT") { setToast("Sign in with your Cedar email to use the wallet."); return; }
    if (topUpSubmitting) return;
    if (!Number.isFinite(amount) || amount < 10000 || amount > 500000) { setToast("Choose a top-up amount between Rs 100 and Rs 5,000."); return; }
    const student_id = user.student_id;
    if (!student_id || !/^\d{7}$/.test(student_id)) { setToast("Use a Cedar email with a 7-digit student ID before topping up your wallet."); return; }
    const id = crypto.randomUUID();
    setTopUpSubmitting(true);
    try {
      const { entry } = await request<{ entry: { id: string; created_at: string } }>(SHARED_DATA_URL, {
        method: "POST",
        body: JSON.stringify({ action: "student-topup-request", id, student_id, amount_paisa: amount, method: topUpMethod }),
      });
      const walletEntry: WalletEntry = { id, label: "Wallet top-up", amount, kind: "credit", created_at: entry.created_at, method: `${topUpMethod} · unverified` };
      saveWallet(walletBalance + amount, [walletEntry, ...walletEntries]);
      setWalletOpen(false);
      setToast(`Wallet balance updated: ${money(amount)}. Payment through ${topUpMethod} has not been verified or received.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The wallet top-up could not be recorded.");
    } finally {
      setTopUpSubmitting(false);
    }
  }
  async function placeDemoOrder() {
    if (orderSubmittingRef.current) return;
    if (user?.role !== "DEMO_STUDENT") { setToast("Sign in with a Cedar email to place an order."); return; }
    if (!cartCount) return;
    if (orderingReason.includes("paused")) { setToast("Ordering is paused in the canteen console."); return; }
    const selectedPickupWindow = orderMode === "scheduled"
      ? availablePickupWindows.find((window) => String(window.id) === selectedWindow)
      : null;
    if (orderMode === "scheduled" && !selectedPickupWindow) {
      setSelectedWindow("");
      setToast("That pickup slot is no longer available. Choose a current slot.");
      return;
    }
    const cartEntries = Object.entries(cart).filter(([, quantity]) => quantity > 0);
    const orderItems = cartEntries.flatMap(([key, quantity]) => {
      const [rawId, variant] = key.split(":");
      const item = items.find((candidate) => candidate.id === Number(rawId));
      const addon_selected = variant === "addon";
      if (!item) return [];
      const addonPrice = addon_selected ? item.addon_price_paisa ?? 0 : 0;
      return [{ item_id: item.id, name: item.name.replace("[DEV SAMPLE] ", ""), quantity, addon_selected, unit_price_paisa: item.price_paisa + addonPrice }];
    });
    if (!cartEntries.length || orderItems.length !== cartEntries.length || orderItems.some((item) => !Number.isSafeInteger(item.item_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 || item.name.length > 120)) {
      const currentItemIds = new Set(items.map((item) => String(item.id)));
      setCart((current) => Object.fromEntries(Object.entries(current).filter(([key, quantity]) => currentItemIds.has(key.split(":")[0]) && quantity > 0)));
      setOrderError("Your bucket had an item that is no longer on the current menu. It has been removed; please review the items and try again.");
      return;
    }
    if (paymentMethod === "wallet" && walletBalance < cartTotal) { setToast("Your wallet balance is too low. Add wallet balance to continue."); setWalletOpen(true); return; }
    orderSubmittingRef.current = true;
    setOrderSubmitting(true);
    setOrderError("");
    setToast("");
    const entry = paymentMethod === "wallet" ? { id: crypto.randomUUID(), label: "Order payment", amount: cartTotal, kind: "debit" as const, created_at: new Date().toISOString(), method: "CedarBite wallet" } : null;
    let pickupCode = "";
    do { pickupCode = `CB${crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`; } while (orders.some((existing) => existing.pickup_code === pickupCode));
    const order: Order = { id: crypto.randomUUID(), status: "SUBMITTED", mode: orderMode === "quick" ? "QUICK" : "SCHEDULED", student_id: user.student_id, payment_method: paymentMethod, total_display: money(cartTotal), pickup_code: pickupCode, created_at: new Date().toISOString(), pickup_window: selectedPickupWindow ? { start_at: selectedPickupWindow.start_at, end_at: selectedPickupWindow.end_at } : null, items: orderItems, waiting_minutes: 0 };
    try {
      const result = await request<{ order?: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "create-order", order }) });
      const confirmedOrder = result.order;
      if (!confirmedOrder?.pickup_code) throw new Error("The canteen did not confirm this order. Your bucket is still here; check My Orders before trying again.");
      if (entry) saveWallet(walletBalance - cartTotal, [entry, ...walletEntries]);
      const nextOrders = [confirmedOrder, ...orders.filter((existing) => existing.id !== confirmedOrder.id)];
      localStorage.setItem(demoOrdersKey(user.email), JSON.stringify(nextOrders));
      setOrders(nextOrders);
      setQueue((current) => [confirmedOrder, ...current.filter((existing) => existing.id !== confirmedOrder.id)]);
      setOrderConfirmation(confirmedOrder);
      setCart({});
      setCartOpen(false);
      setShowOrderConfirmation(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not send this order to the canteen. Your bucket is unchanged.";
      setOrderError(message);
    }
    finally { orderSubmittingRef.current = false; setOrderSubmitting(false); }
  }
  function changeOrderMode(nextMode: OrderMode) {
    setOrderMode(nextMode);
    setCategoryFilter("All");
    setCart((current) => Object.fromEntries(Object.entries(current).filter(([key]) => {
      const item = items.find((entry) => entry.id === Number(key.split(":")[0]));
      return item && (nextMode === "quick" ? item.quick_allowed : item.scheduled_allowed);
    })));
    setSelectedWindow("");
  }

  async function toggleAvailability(item: Item) {
    if (availabilityPendingRef.current.has(item.id)) return;
    const previousAvailable = categories.flatMap((category) => category.items).find((entry) => entry.id === item.id)?.available ?? item.available;
    const nextAvailable = !previousAvailable;
    const updateItem = (available: boolean) => setCategories((current) => current.map((category) => ({
      ...category,
      items: category.items.map((entry) => entry.id === item.id ? { ...entry, available } : entry),
    })));

    availabilityPendingRef.current.add(item.id);
    availabilityVersionRef.current.set(item.id, (availabilityVersionRef.current.get(item.id) ?? 0) + 1);
    menuRevisionRef.current += 1;
    setAvailabilityPending((current) => current.includes(item.id) ? current : [...current, item.id]);
    updateItem(nextAvailable);

    try {
      if (user?.role === "DEMO_CANTEEN") {
        const result = await request<{ item_id: number; available: boolean }>(SHARED_DATA_URL, {
          method: "POST",
          body: JSON.stringify({ action: "set-availability", item_id: item.id, available: nextAvailable }),
        });
        if (result.item_id !== item.id || result.available !== nextAvailable) throw new Error("The canteen did not confirm this availability change.");
        setToast(`${item.name} is now ${nextAvailable ? "available" : "unavailable"} for everyone.`);
      } else {
        const result = await request<{ is_available?: boolean; available?: boolean }>(`/api/menu/items/${item.id}/availability`, {
          method: "PATCH",
          body: JSON.stringify({ is_available: nextAvailable }),
        });
        const saved = result.is_available ?? result.available;
        if (saved !== nextAvailable) throw new Error("The canteen did not confirm this availability change.");
        setToast(`${item.name} is now ${nextAvailable ? "available" : "unavailable"}.`);
      }
    } catch (error) {
      updateItem(previousAvailable);
      setToast(error instanceof Error ? `Could not update ${item.name}: ${error.message}` : `Could not update ${item.name}. Please try again.`);
    } finally {
      menuRevisionRef.current += 1;
      availabilityVersionRef.current.set(item.id, (availabilityVersionRef.current.get(item.id) ?? 0) + 1);
      availabilityPendingRef.current.delete(item.id);
      setAvailabilityPending((current) => current.filter((id) => id !== item.id));
      if (user?.role === "DEMO_CANTEEN") void loadSharedAvailability();
      else void loadMenu(true);
    }
  }
  async function changePrice(item: Item, form: HTMLFormElement) {
    const price = Number(new FormData(form).get("price"));
    if (!Number.isFinite(price) || price < 0) { setToast("Enter a valid price."); return; }
    if (user?.role === "DEMO_CANTEEN") {
      const price_paisa = Math.round(price * 100);
      const next = categories.map((category) => ({ ...category, items: category.items.map((entry) => entry.id === item.id ? { ...entry, price_paisa, price_display: money(price_paisa) } : entry) }));
      try { await saveDemoMenu(next); setToast(`Price updated for ${item.name}.`); }
      catch (error) { setToast(error instanceof Error ? error.message : "Price was not changed."); }
      return;
    }
    try { await request(`/api/menu/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ price_paisa: Math.round(price * 100) }) }); await loadMenu(true); setToast(`Price updated for ${item.name}.`); }
    catch (error) { setToast(error instanceof Error ? error.message : "Price was not changed."); }
  }
  async function updateMenuItem(item: Item, values: MenuItemEditValues) {
    if (menuMutationInFlightRef.current) throw new Error("Another menu change is still saving. Wait for it to finish, then try again.");
    menuMutationInFlightRef.current = true;
    setMenuMutationPending(true);
    try {
      if (user?.role === "DEMO_CANTEEN") {
        const result = await request<{ categories: Category[] }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "update-menu-item", item: { id: item.id, ...values } }) });
        setCategories(result.categories);
        cacheDemoMenu(result.categories);
      } else {
        await request(`/api/menu/items/${item.id}`, { method: "PATCH", body: JSON.stringify(values) });
        await loadMenu(true);
      }
      setToast(`${values.name} was updated on the shared menu.`);
    } finally {
      menuMutationInFlightRef.current = false;
      setMenuMutationPending(false);
    }
  }
  async function removeMenuItem(item: Item): Promise<boolean> {
    if (menuMutationInFlightRef.current) return false;
    if (user?.role === "DEMO_CANTEEN") {
      const next = categories.map((category) => ({ ...category, items: category.items.filter((entry) => entry.id !== item.id) }));
      try {
        await saveDemoMenu(next);
        setToast(`${item.name} was removed from the shared menu. Existing orders stay in history.`);
        return true;
      } catch (error) {
        setToast(error instanceof Error ? error.message : `${item.name} was not removed.`);
        return false;
      }
    }
    menuMutationInFlightRef.current = true;
    setMenuMutationPending(true);
    try {
      await request(`/api/menu/items/${item.id}/archive`, { method: "POST" });
      await loadMenu(true);
      setToast(`${item.name} was removed from the menu. Existing orders stay in history.`);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : `${item.name} was not removed.`);
      return false;
    } finally {
      menuMutationInFlightRef.current = false;
      setMenuMutationPending(false);
    }
  }

  async function saveDemoMenu(nextCategories: Category[]) {
    if (menuMutationInFlightRef.current) throw new Error("A menu change is already saving. Wait for it to finish, then try again.");
    menuMutationInFlightRef.current = true;
    setMenuMutationPending(true);
    try {
      const result = await request<{ categories: Category[] }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-menu", categories: nextCategories }) });
      setCategories(result.categories);
      cacheDemoMenu(result.categories);
      return result.categories;
    } finally {
      menuMutationInFlightRef.current = false;
      setMenuMutationPending(false);
    }
  }
  async function reorderMenuItems(sourceId: number, targetId: number) {
    if (user?.role !== "DEMO_CANTEEN" || sourceId === targetId || menuMutationInFlightRef.current) return;
    const source = items.find((item) => item.id === sourceId);
    const target = items.find((item) => item.id === targetId);
    if (!source || !target || source.category_id !== target.category_id) return;
    const category = categories.find((entry) => entry.id === source.category_id);
    if (!category) return;
    const reordered = [...category.items];
    const from = reordered.findIndex((item) => item.id === sourceId);
    const to = reordered.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const next = categories.map((entry) => entry.id === category.id ? { ...entry, items: reordered } : entry);
    try { await saveDemoMenu(next); setToast("Menu item order saved."); }
    catch (error) { setToast(error instanceof Error ? error.message : "Menu item order was not saved."); }
  }
  async function reorderMenuCategories(sourceId: number, targetId: number) {
    if (user?.role !== "DEMO_CANTEEN" || sourceId === targetId || menuMutationInFlightRef.current) return;
    const from = categories.findIndex((category) => category.id === sourceId);
    const to = categories.findIndex((category) => category.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...categories];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    try { await saveDemoMenu(next); setToast("Category order saved for the student menu and counter."); }
    catch (error) { setToast(error instanceof Error ? error.message : "Category order was not saved."); }
  }
  async function addCategory(form: HTMLFormElement) {
    const name = String(new FormData(form).get("category") ?? "").trim(); if (!name) return;
    if (user?.role === "DEMO_CANTEEN") {
      const next = [...categories, { id: Math.max(0, ...categories.map((category) => category.id)) + 1, name, items: [] }];
      try { await saveDemoMenu(next); form.reset(); setToast(`Category ${name} added.`); }
      catch (error) { setToast(error instanceof Error ? error.message : "Category was not added."); }
      return;
    }
    try { await request("/api/menu/categories", { method: "POST", body: JSON.stringify({ name }) }); await loadMenu(true); form.reset(); setToast(`Added ${name}.`); }
    catch (error) { setToast(error instanceof Error ? error.message : "Category was not added."); }
  }
  async function removeCategory(category: Category, targetCategoryId?: number): Promise<boolean> {
    if (user?.role !== "DEMO_CANTEEN" || menuMutationInFlightRef.current) return false;
    const current = categories.find((entry) => entry.id === category.id);
    if (!current) return false;
    if (categories.length <= 1) {
      setToast("Keep at least one menu category.");
      return false;
    }
    const target = current.items.length ? categories.find((entry) => entry.id === targetCategoryId && entry.id !== current.id) : undefined;
    if (current.items.length && !target) {
      setToast("Choose another category to move these items into first.");
      return false;
    }
    try {
      const movedItems = current.items.map((item) => target ? { ...item, category_id: target.id } : item);
      const next = categories.filter((entry) => entry.id !== current.id).map((entry) => entry.id === target?.id ? { ...entry, items: [...entry.items, ...movedItems] } : entry);
      await saveDemoMenu(next);
      if (categoryFilter === current.name) setCategoryFilter(target?.name ?? "All");
      setToast(target ? `${current.name} removed; its items moved to ${target.name}.` : `${current.name} category removed.`);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Category was not removed.");
      return false;
    }
  }
  async function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    if (itemAddInFlightRef.current) return;
    if (user?.role === "DEMO_CANTEEN") {
      const category_id = Number(data.get("category_id"));
      const name = String(data.get("name") ?? "").trim();
      const description = String(data.get("description") ?? "").trim();
      const price = Number(data.get("price"));
      const quick_allowed = data.get("quick") === "on";
      const scheduled_allowed = data.get("scheduled") === "on";
      const image_data = String(data.get("image_data") ?? "") || null;
      if (!categories.some((category) => category.id === category_id)) { setItemMessage("Choose a valid menu category."); return; }
      if (!name || !Number.isFinite(price) || price < 0 || (!quick_allowed && !scheduled_allowed)) { setItemMessage("Enter a name and valid price, then choose at least one pickup type."); return; }
      const addonInputName = String(data.get("addon_name") ?? "").trim();
      const addonInputPrice = Number(data.get("addon_price") || 0);
      if (addonInputName && (!Number.isFinite(addonInputPrice) || addonInputPrice < 0)) { setItemMessage("Enter a valid non-negative price for the optional add-on."); return; }
      const price_paisa = Math.round(price * 100);
      const prepValue = String(data.get("prep_minutes") ?? "").trim();
      const addon_name = String(data.get("addon_name") ?? "").trim() || null;
      const addon_price_paisa = addon_name ? Math.round(Number(data.get("addon_price") || 0) * 100) : 0;
      const newItem = { category_id, name, description, price_paisa, addon_name, addon_price_paisa, quick_allowed, scheduled_allowed, prep_minutes: prepValue ? Number(prepValue) : null, image_data };
      if (menuMutationInFlightRef.current) { setItemMessage("Another menu change is still saving. Wait a moment and try again."); return; }
      itemAddInFlightRef.current = true;
      menuMutationInFlightRef.current = true;
      setMenuMutationPending(true);
      setItemAddPending(true);
      setItemMessage("Saving to the shared menu…");
      try {
        const result = await request<{ categories: Category[]; item: Item }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "add-menu-item", item: newItem, bootstrap_categories: categories }) });
        setCategories(result.categories);
        cacheDemoMenu(result.categories);
        form.reset();
        setItemMessage(`${result.item.name} is now on the shared menu for everyone.`);
      }
      catch (error) { setItemMessage(error instanceof Error ? error.message : "Item was not added. Try again."); }
      finally { itemAddInFlightRef.current = false; menuMutationInFlightRef.current = false; setMenuMutationPending(false); setItemAddPending(false); }
      return;
    }
    itemAddInFlightRef.current = true;
    setItemAddPending(true);
    try {
      await request("/api/menu/items", { method: "POST", body: JSON.stringify({ category_id: Number(data.get("category_id")), name: String(data.get("name")), description: String(data.get("description")), price_paisa: Math.round(Number(data.get("price")) * 100), quick_allowed: data.get("quick") === "on", scheduled_allowed: data.get("scheduled") === "on", prep_minutes: Number(data.get("prep_minutes")) || null, image_data: String(data.get("image_data") ?? "") || null, addon_name: String(data.get("addon_name") ?? "").trim() || null, addon_price_paisa: String(data.get("addon_name") ?? "").trim() ? Math.round(Number(data.get("addon_price") || 0) * 100) : 0 }) });
      await loadMenu(true); form.reset(); setItemMessage("Added to the canteen menu.");
    } catch (error) { setItemMessage(error instanceof Error ? error.message : "Item was not added."); }
    finally { itemAddInFlightRef.current = false; setItemAddPending(false); }
  }
  async function advanceOrder(order: Order) {
    const next: Record<string, string> = { SUBMITTED: "PREPARING", ACCEPTED: "READY", PREPARING: "READY", READY: "COLLECTED" };
    if (!next[order.status]) return;
    const orderId = String(order.id);
    if (queueMutationPendingRef.current.has(orderId)) return;
    queueMutationPendingRef.current.add(orderId);
    queueRevisionRef.current += 1;
    setQueuePendingIds((current) => [...new Set([...current, orderId])]);
    try {
      if (user?.role === "DEMO_CANTEEN") {
        const result = await request<{ order: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-status", order_id: orderId, status: next[order.status] }) });
        if (!result.order || result.order.status !== next[order.status]) throw new Error("The canteen did not confirm this order update.");
        queueRevisionRef.current += 1;
        setQueue((current) => result.order.status === "COLLECTED" ? current.filter((entry) => String(entry.id) !== orderId) : [result.order, ...current.filter((entry) => String(entry.id) !== orderId)]);
        if (result.order.status === "COLLECTED") setOrderHistory((current) => [result.order, ...current.filter((entry) => String(entry.id) !== orderId)].slice(0, 100));
        setToast(`Order ${order.pickup_code} updated.`);
        return;
      }
      const result = await request<Order & { order?: Order }>(`/api/orders/${order.id}/status`, { method: "POST", body: JSON.stringify({ to: next[order.status] }) });
      const savedOrder = result.order ?? (result.id != null ? result : undefined);
      if (!savedOrder || savedOrder.status !== next[order.status]) throw new Error("The canteen did not confirm this order update.");
      const updated = { ...order, ...savedOrder };
      queueRevisionRef.current += 1;
      setQueue((current) => updated.status === "COLLECTED" ? current.filter((entry) => String(entry.id) !== orderId) : [updated, ...current.filter((entry) => String(entry.id) !== orderId)]);
      setToast(`Order ${order.pickup_code} updated.`);
    } catch (error) {
      queueRevisionRef.current += 1;
      setToast(error instanceof Error ? error.message : "Order status was not changed.");
    } finally {
      queueMutationPendingRef.current.delete(orderId);
      setQueuePendingIds((current) => current.filter((id) => id !== orderId));
      void loadQueue();
      if (next[order.status] === "COLLECTED") void loadOrderHistory();
    }
  }
  async function deleteOrder(order: Order) {
    if (user?.role !== "DEMO_CANTEEN" || canteenStation !== "order_manager" || order.status !== "SUBMITTED") return;
    if (!window.confirm(`Delete accidental order ${order.pickup_code}? It has not been accepted and will be removed from the active queue.`)) return;
    const orderId = String(order.id);
    if (queueMutationPendingRef.current.has(orderId)) return;
    queueMutationPendingRef.current.add(orderId);
    queueRevisionRef.current += 1;
    setQueuePendingIds((current) => [...new Set([...current, orderId])]);
    try {
      await request(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "delete-order", order_id: orderId }) });
      queueRevisionRef.current += 1;
      setQueue((current) => current.filter((entry) => String(entry.id) !== orderId));
      setToast(`Order ${order.pickup_code} was deleted.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Order was not deleted.");
    } finally {
      queueMutationPendingRef.current.delete(orderId);
      setQueuePendingIds((current) => current.filter((id) => id !== orderId));
      void loadQueue();
    }
  }
  async function deleteHistoryOrder(order: Order) {
    if (user?.role !== "DEMO_CANTEEN" || canteenStation !== "order_manager") return;
    if (!window.confirm(`Permanently remove completed order ${order.pickup_code} from order history?`)) return;
    const orderId = String(order.id);
    if (queueMutationPendingRef.current.has(orderId)) return;
    queueMutationPendingRef.current.add(orderId);
    setQueuePendingIds((current) => [...new Set([...current, orderId])]);
    try {
      await request(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "delete-history-order", order_id: orderId }) });
      setOrderHistory((current) => current.filter((entry) => String(entry.id) !== orderId));
      setToast(`Completed order ${order.pickup_code} was removed from history.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Order was not removed from history.");
    } finally {
      queueMutationPendingRef.current.delete(orderId);
      setQueuePendingIds((current) => current.filter((id) => id !== orderId));
      void loadOrderHistory();
    }
  }
  async function refundHistoryOrder(order: Order) {
    if (user?.role !== "DEMO_CANTEEN" || canteenStation !== "order_manager" || order.refund_status === "REFUNDED") return;
    const paymentMethod = String(order.payment_method || "cash").trim().toLowerCase();
    const isWallet = paymentMethod === "wallet";
    if (!isWallet && String(order.payment_status || "").trim().toUpperCase() !== "PAID") { setToast("This order has no recorded payment to refund. Record the cash receipt in Cash Desk first."); return; }
    const message = isWallet
      ? `Return ${order.total_display || "the order total"} for ${order.pickup_code} to the student's CedarBite wallet? This will be recorded once.`
      : `Record that the ${human(order.payment_method || "cash")} refund for ${order.pickup_code} has already been returned manually? This does not contact a payment provider.`;
    if (!window.confirm(message)) return;
    const orderId = String(order.id);
    if (queueMutationPendingRef.current.has(orderId)) return;
    queueMutationPendingRef.current.add(orderId);
    setQueuePendingIds((current) => [...new Set([...current, orderId])]);
    try {
      const result = await request<{ order: Order; duplicate?: boolean }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "refund-order", order_id: orderId }) });
      if (!result.order?.refund_status) throw new Error("The canteen did not confirm the refund record.");
      setOrderHistory((current) => current.map((entry) => String(entry.id) === orderId ? result.order : entry));
      setToast(isWallet ? `Refunded ${order.total_display || "the order total"} to student ${order.student_id || "wallet"}.` : `Manual refund recorded for ${order.pickup_code}.`);
    } catch (error) { setToast(error instanceof Error ? error.message : "The order could not be refunded."); }
    finally {
      queueMutationPendingRef.current.delete(orderId);
      setQueuePendingIds((current) => current.filter((id) => id !== orderId));
      void loadOrderHistory();
    }
  }
  async function toggleOrdering() {
    if (user?.role === "DEMO_CANTEEN") { setOrderingReason((current) => current.includes("paused") ? "Ordering is open" : "Ordering is paused"); return; }
    const paused = orderingReason !== "Online ordering is paused by the canteen.";
    try { await request("/api/ordering/pause", { method: "POST", body: JSON.stringify({ paused }) }); setOrderingReason(paused ? "Online ordering is paused by the canteen." : "Ordering is open"); }
    catch (error) { setToast(error instanceof Error ? error.message : "Ordering status was not changed."); }
  }
  function saveDeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const title = String(data.get("title") ?? "").trim(); const description = String(data.get("description") ?? "").trim();
    const item_ids = data.getAll("item_ids").map(Number).filter(Number.isFinite);
    if (!title) return;
    if (!item_ids.length) { setDealMessage("Choose at least one menu item for this deal."); return; }
    const selectedItems = items.filter((item) => item_ids.includes(item.id));
    if (!selectedItems.every((item) => item.quick_allowed) && !selectedItems.every((item) => item.scheduled_allowed)) { setDealMessage("Choose items that share Quick Order or Scheduled Order pickup."); return; }
    setDeals((current) => [{ id: crypto.randomUUID(), title, description, active: true, item_ids }, ...current]); form.reset(); setDealMessage("Deal saved and ready to add to a bucket.");
  }

  function dealItemsFor(deal: Deal) {
    const linked = deal.item_ids?.length ? items.filter((item) => deal.item_ids?.includes(item.id)) : [];
    const associated = deal.id === "sample-1" ? linked.length ? linked : items.filter((item) => /drink|water|juice|cookie|snack|samosa/i.test(item.name)).slice(0, 2)
      : deal.id === "sample-2" ? [items.find((item) => /chicken biryani|biryani/i.test(item.name)), items.find((item) => /cold drink/i.test(item.name))].filter((item): item is Item & { category: string } => Boolean(item))
      : linked;
    return associated.filter((item) => item.available);
  }

  function addDealToBucket(deal: Deal) {
    const dealItems = dealItemsFor(deal);
    if (!dealItems.length) { setToast("The menu items for this deal are currently unavailable."); return; }
    const quick = dealItems.every((item) => item.quick_allowed);
    const scheduled = dealItems.every((item) => item.scheduled_allowed);
    const supportsCurrentMode = orderMode === "quick" ? quick : scheduled;
    const targetMode = supportsCurrentMode ? orderMode : quick ? "quick" : scheduled ? "scheduled" : null;
    if (!targetMode) { setToast("This offer combines items that need different pickup styles."); return; }
    const currentItems = items.filter((item) => Object.entries(cart).some(([key, quantity]) => Number(key.split(":")[0]) === item.id && quantity > 0));
    if (currentItems.some((item) => targetMode === "quick" ? !item.quick_allowed : !item.scheduled_allowed)) { setToast("Your bucket has items for a different pickup style. Remove them before adding this deal."); return; }
    setOrderMode(targetMode);
    setCart((current) => ({ ...current, ...Object.fromEntries(dealItems.map((item) => [item.id, (current[item.id] ?? 0) + 1])) }));
    setSelectedDeal(null); setCartOpen(true);
  }

  if (page === "stations") return <StationDirectory onNavigate={(next) => navigate(next)} onBack={() => navigate("menu")}/>;
  if (page === "counter") return !menuReady ? <main className="owner-loading" role="status">Loading the latest menu…</main> : <CounterStation user={user} categories={categories} items={items} windows={availablePickupWindows} pending={orderSubmitting} darkMode={darkMode} onToggleTheme={() => setDarkMode((dark) => !dark)} onSignIn={(username, password) => demoStaffSignIn(username, password, "order_taker")} onSignOut={() => void signOut()} onReturnToActive={returnToActiveStation} onChangePassword={changeStaffPassword} onCreate={async (customer, selections, addonSelections, mode, windowId) => {
    const selected = items.filter((item) => selections[item.id] > 0);
    if (!selected.length) throw new Error("Add at least one menu item.");
    const pickupWindow = mode === "SCHEDULED" ? availablePickupWindows.find((slot) => String(slot.id) === windowId) : null;
    if (mode === "SCHEDULED" && !pickupWindow) throw new Error("Choose a current pickup slot.");
    const total = selected.reduce((sum, item) => sum + (item.price_paisa + (addonSelections[item.id] ? item.addon_price_paisa ?? 0 : 0)) * selections[item.id], 0);
    const pickupCode = `CB${crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const order = { id: crypto.randomUUID(), pickup_code: pickupCode, mode, ...customer, total_display: money(total), pickup_window: pickupWindow ? { start_at: pickupWindow.start_at, end_at: pickupWindow.end_at } : null, payment_method: "cash", items: selected.map((item) => { const addon_selected = Boolean(addonSelections[item.id] && item.addon_name); const unit_price_paisa = item.price_paisa + (addon_selected ? item.addon_price_paisa ?? 0 : 0); return { item_id: item.id, name: item.name, quantity: selections[item.id], addon_selected, unit_price_paisa }; }) };
    const result = await request<{ order: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "create-counter-order", order }) });
    return result.order;
  }}/>
  if (["owner", "order-manager", "cashdesk"].includes(page)) return !menuReady ? <main className="owner-loading" role="status">Loading the latest menu…</main> : <OwnerApp station={page === "cashdesk" ? "cashier" : "order_manager"} user={user} googleReady={googleReady} categories={categories} items={items} queue={queue} orderHistory={orderHistory} salesSummary={salesSummary} salesSummaryDates={salesSummaryDates} salesSummaryError={salesSummaryError} salesSummaryLoading={salesSummaryLoading} onLoadSalesSummary={(date) => void loadSalesSummary(date)} onLoadSalesDates={() => void loadSalesSummaryDates()} onDeleteSalesSummary={deleteSalesSummary} walletTopUpHistory={walletTopUpHistory} walletHistoryError={walletHistoryError} walletHistoryLoading={walletHistoryLoading} onLoadHistory={() => void loadOrderHistory()} onLoadWalletTopUpHistory={() => void loadWalletTopUpHistory()} queuePendingIds={queuePendingIds} deals={deals} darkMode={darkMode} onToggleTheme={() => setDarkMode((dark) => !dark)} canManage={canManage} canSortMenu={user?.role === "DEMO_CANTEEN"} onReorderMenuItems={reorderMenuItems} onReorderMenuCategories={reorderMenuCategories} canToggle={canToggle} availabilityPending={availabilityPending} menuMutationPending={menuMutationPending} itemAddPending={itemAddPending} canQueue={canQueue} canTopUp={user?.permissions.includes("wallet.cash_topup") ?? false} walletMessage={walletMessage} walletPending={cashTopUpPending} onCashTopUp={cashWalletTopUp} itemMessage={itemMessage} dealMessage={dealMessage} onSignIn={startSignIn} onDemoStaff={(username, password, station) => demoStaffSignIn(username, password, station)} onSignOut={() => void signOut()} onReturnToActive={returnToActiveStation} onBack={() => navigate("menu")} onToggle={toggleAvailability} onPrice={(item, form) => void changePrice(item, form)} onAddCategory={(form) => void addCategory(form)} onRemoveCategory={removeCategory} onAddItem={(event) => void addItem(event)} onRemoveItem={removeMenuItem} onUpdateItem={updateMenuItem} onAdvance={(order) => void advanceOrder(order)} onDeleteOrder={(order) => void deleteOrder(order)} onDeleteHistoryOrder={(order) => void deleteHistoryOrder(order)} onRefundHistoryOrder={(order) => void refundHistoryOrder(order)} onMarkCashPaid={markCashPaid} onChangePassword={changeStaffPassword} onResetPassword={resetStaffPassword} onToggleOrdering={() => void toggleOrdering()} onDeal={saveDeal} onDealToggle={(id) => setDeals((current) => current.map((deal) => deal.id === id ? { ...deal, active: !deal.active } : deal))} onRefresh={() => { void loadMenu(user?.role !== "DEMO_CANTEEN"); void loadQueue(); void loadOrderHistory(); void loadWalletTopUpHistory(); void loadWallet(); if (user?.role === "DEMO_CANTEEN") void loadSharedAvailability(); }} orderingReason={orderingReason} />;
  if (page === "kitchen") return <KitchenStation user={user} queue={queue} pendingIds={queuePendingIds} darkMode={darkMode} onToggleTheme={() => setDarkMode((dark) => !dark)} onSignIn={(username, password) => demoStaffSignIn(username, password, "kitchen")} onSignOut={() => void signOut()} onReturnToActive={returnToActiveStation} onChangePassword={changeStaffPassword}/>;
  if (page === "confirmation") return <main className="order-confirmation-page"><section className="order-confirmation-page-card"><div className="confirmation-check" aria-hidden="true">✓</div><span className="section-kicker">ORDER CONFIRMED</span><h1>Your order was placed successfully.</h1><div className="confirmation-pickup"><small>PICKUP NUMBER</small><strong>{orderConfirmation?.pickup_code ?? "—"}</strong></div><button className="blue-button" onClick={() => navigate("menu")}>← Return to menu</button></section></main>;

  return <div className="storefront">
    <header className={`store-header ${mobileMenuOpen ? "menu-open" : ""}`}>
  <button className="wordmark" onClick={() => navigate("menu")}><CedarMark /><span>Cedar<span>Bite</span></span></button>
  <button type="button" className="mobile-menu-toggle" aria-controls="store-navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}><span aria-hidden="true">{mobileMenuOpen ? "×" : "☰"}</span>{mobileMenuOpen ? "Close" : "Menu"}</button>
  <div className={`header-menu ${mobileMenuOpen ? "is-open" : ""}`} id="store-navigation">
    <nav className="store-nav" aria-label="Main navigation"><button className={page === "menu" && !dealsActive ? "selected" : ""} onClick={() => navigate("menu")}>Menu</button><button className={page === "menu" && dealsActive ? "selected" : ""} onClick={() => { if (page !== "menu") navigate("menu"); setDealsActive(true); setMobileMenuOpen(false); setTimeout(() => document.getElementById("deals")?.scrollIntoView({ behavior: "smooth" }), 0); }}>Deals</button><button className={page === "about" ? "selected" : ""} onClick={() => navigate("about")}>About us</button><button className={page === "contact" ? "selected" : ""} onClick={() => navigate("contact")}>Contact</button>{canSeeOrders && <button className={page === "orders" ? "selected" : ""} onClick={() => navigate("orders")}>My orders</button>}</nav>
    <div className="header-actions"><button className="wallet-header" onClick={() => { setMobileMenuOpen(false); user?.role === "DEMO_STUDENT" ? setWalletOpen(true) : loginDialog.current?.showModal(); }}><span>Wallet</span><b>{user?.role === "DEMO_STUDENT" ? money(walletBalance) : "Sign in"}</b></button><button className="basket-header" aria-label={`Open bucket, ${cartCount} items`} onClick={() => { setMobileMenuOpen(false); setCartOpen(true); }}><span className="basket-symbol">▣</span><span>Bucket</span><b>{cartCount}</b></button>{canManage && <button className="owner-entry" onClick={() => navigate("owner")}>Canteen console <span>↗</span></button>}{user ? <button className="sign-button" onClick={() => { setMobileMenuOpen(false); void signOut(); }}>{user.student_id ? `ID ${user.student_id}` : human(user.role)} · Sign out</button> : <button className="sign-button" onClick={() => { setMobileMenuOpen(false); loginDialog.current?.showModal(); }}>Login <span>↗</span></button>}<button type="button" className="theme-toggle" onClick={() => setDarkMode((dark) => !dark)} aria-label={`Switch to ${darkMode ? "light" : "dark"} mode`} title={darkMode ? "Switch to light mode" : "Switch to dark mode"}><span aria-hidden="true">{darkMode ? "☀" : "☾"}</span></button></div>
  </div>
</header>
    {page === "orders" ? <main className="orders-page"><div className="page-kicker">YOUR CEDARBITE ACCOUNT</div><h1>My orders</h1><p className="page-lead">Orders appear here with their pickup code and progress.</p>{orders.length ? <div className="order-list">{orders.map((order) => <OrderCard key={order.id} order={order} />)}</div> : <div className="empty-state"><span>◷</span><h2>No orders yet</h2><p>Choose an item from the menu to see it appear here.</p><button className="blue-button" onClick={() => navigate("menu")}>Browse menu</button></div>}</main> : page === "team" ? <TeamPage/> : page === "about" || page === "privacy" || page === "contact" ? <InfoPage page={page}/> : <main>
      <section className="order-controls" aria-label="Order type"><div className="service-choice pickup-choice"><span className="control-label">COLLECTION</span><div className="pickup-pill"><span className="pickup-pin">⌖</span><span><b>Pickup</b><small>Cedar canteen</small></span><span className="pickup-chevron">⌄</span></div></div><div className="service-choice mode-choice"><span className="control-label">CHOOSE YOUR ORDER STYLE</span><button className={orderMode === "quick" ? "chosen" : ""} onClick={() => changeOrderMode("quick")}>Quick Order <small>Ready items · no time slot</small></button><button className={orderMode === "scheduled" ? "chosen" : ""} onClick={() => changeOrderMode("scheduled")}>Schedule Order <small>Choose a pickup window</small></button></div></section>
      <section className="promo-hero"><div className="hero-copy"><span className="yellow-pill"><span className="hero-pill-dot"/> CEDAR COLLEGE CANTEEN</span><h1>Your break,<br/><span>your moment.</span></h1><p>Find a favourite, build your bucket, and choose the pickup style that fits your day.</p><button className="yellow-button" onClick={() => document.getElementById("menu")?.scrollIntoView({ behavior: "smooth" })}>Explore the menu <span>↓</span></button><div className="preview-note">Discover the menu, made for your campus break.</div><div className="hero-features"><span><b>01</b> Quick pickup</span><span><b>02</b> Scheduled food</span><span><b>03</b> One easy bucket</span></div></div><div className="hero-food" aria-hidden="true"><div className="food-sun"/><div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/><div className="hero-plate"><span>🍔</span><span>🍟</span><span>🥤</span></div><div className="hero-sticker"><small>MADE FOR</small><b>YOUR BREAK</b><i>CEDARBITES · GOOD VIBES</i></div><div className="hero-spark">✦</div><div className="hero-floating-card"><span>✦</span><b>Choose.<br/>Collect.<br/>Enjoy.</b></div></div><div className="hero-ribbon"><span>QUICK PICKUP</span><i>•</i><span>SCHEDULED PICKUP</span><i>•</i><span>MADE FOR YOUR BREAK</span></div></section>
      {deals.some((deal) => deal.active) && <section className="deals-section" id="deals"><div className="deals-title"><div><span className="section-kicker">GOOD THINGS TO LOOK FOR</span><h2>Break-time <span>deals</span></h2></div><small>Canteen favourites · featured picks</small></div><div className="deal-grid">{deals.filter((deal) => deal.active).slice(0, 3).map((deal, index) => <button type="button" className={`deal-tile deal-tone-${index % 3}`} key={deal.id} onClick={() => setSelectedDeal(deal)} aria-label={`View deal: ${deal.title}`}><span className="deal-icon">{index % 2 ? "✦" : "★"}</span><span className="deal-tile-copy"><span className="deal-label">FEATURED DEAL · VIEW DETAILS</span><h3>{deal.title}</h3><span className="deal-summary">{deal.description}</span></span><span className="deal-arrow">↗</span></button>)}</div></section>}
      {selectedDeal && <div className="deal-modal-scrim" onClick={() => setSelectedDeal(null)}><section className="deal-modal" role="dialog" aria-modal="true" aria-labelledby="deal-modal-title" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setSelectedDeal(null); }}><button className="deal-modal-close" autoFocus onClick={() => setSelectedDeal(null)} aria-label="Close deal details">×</button><span className="section-kicker">FEATURED DEAL</span><h2 id="deal-modal-title">{selectedDeal.title}</h2><p>{selectedDeal.description}</p><div className="deal-modal-items">{dealItemsFor(selectedDeal).map((item) => <div key={item.id}><span>{item.name}</span><b>{item.price_display}</b></div>)}{!dealItemsFor(selectedDeal).length && <p>Items in this offer are currently unavailable.</p>}</div><small>Items are added at their listed menu prices.</small><button className="blue-button deal-add-button" disabled={!dealItemsFor(selectedDeal).length} onClick={() => addDealToBucket(selectedDeal)}>Add deal to bucket <span>→</span></button></section></div>}<section className="menu-area" id="menu"><div className="menu-intro"><div><span className="section-kicker">THE CANTEEN MENU</span><h2>Find your <span>favourite.</span></h2></div><div className="menu-live"><i className="live-dot"/> Menu availability from canteen service</div></div><div className="menu-layout"><nav className="category-sidebar" aria-label="Menu categories"><button className={categoryFilter === "All" ? "active" : ""} onClick={() => setCategoryFilter("All")}>All items</button>{menuReady && availableModeCategories.map((category) => <button className={categoryFilter === category.name ? "active" : ""} key={category.id} onClick={() => setCategoryFilter(category.name)}>{category.name}</button>)}</nav><div className="menu-results">{}
       {!menuReady ? <div className="empty-state menu-loading-message" role="status">Loading the latest menu…</div> : menuError ? <div className="empty-state error-state"><h2>Menu didn’t load</h2><p>{menuError}</p></div> : <>{!availableModeCategories.length ? <div className="empty-state"><span>🍽️</span><h2>Menu being prepared</h2><p>Menu items will appear here when they are available.</p></div> : shownCategories.map((category) => <div className="menu-category" key={category.id}><div className="category-title"><h3>{category.name}</h3><span>{category.items.length} items</span></div><div className="food-grid">{category.items.map((item, index) => <FoodCard key={item.id} item={item} index={index} orderMode={orderMode} canOrder={quickOrdersOpen} onAdd={() => { const allowed = orderMode === "quick" ? item.quick_allowed : item.scheduled_allowed; if (!allowed) changeOrderMode(item.quick_allowed ? "quick" : "scheduled"); requestAddToCart(item); }} />)}</div></div>)}</>}</div></div></section>
      <section className="how-it-works"><div><span className="section-kicker">TWO WAYS TO ORDER</span><h2>Made for <span>your day.</span></h2><p className="section-subcopy">Different food, different pickup. The canteen chooses which items and times it can support.</p></div><div className="ordering-modes"><article><span className="mode-icon">↗</span><div><small>01 · READY TO SELL</small><h3>Quick Order</h3><p>Choose a ready-made item, add it to your bucket, and move it through the canteen queue. No pickup slot is needed.</p></div></article><article><span className="mode-icon blue">◷</span><div><small>02 · MADE FRESH</small><h3>Scheduled Order</h3><p>For food that needs preparation, choose from pickup windows supported by the canteen.</p></div></article></div></section>      <section className="payment-note"><div><span className="section-kicker">CEDARBITE WALLET</span><h2>Top up. <span>Order. Enjoy.</span></h2><p>Top up your CedarBite wallet and choose a payment method at checkout. Online payment providers are not connected. Transfers selected here are not verified or received by CedarBite.</p><button className="blue-button" onClick={() => user?.role === "DEMO_STUDENT" ? setWalletOpen(true) : loginDialog.current?.showModal()}>Open wallet <span>→</span></button></div><div className="payment-pills"><span>EasyPaisa</span><span>JazzCash</span><span>Bank transfer</span><span>Card</span><span>Cash at pickup</span></div></section>
    </main>}
    <footer className="store-footer"><div className="footer-main"><div><button className="wordmark footer-mark" onClick={() => navigate("menu")}><CedarMark/><span>Cedar<span>Bite</span></span></button><p>Queue · Order · Enjoy</p></div><div><b>Explore</b><button onClick={() => navigate("menu")}>Menu</button><button onClick={() => { navigate("menu"); setDealsActive(true); setTimeout(() => document.getElementById("deals")?.scrollIntoView({ behavior:"smooth" }),0); }}>Deals</button><button onClick={() => navigate("about")}>About us</button><button onClick={() => navigate("stations")}>Staff stations</button></div><div><b>Help & information</b><button onClick={() => navigate("contact")}>Contact us</button><button onClick={() => navigate("privacy")}>Privacy policy</button></div><div><b>Team behind CedarBite</b><button className="team-footer-link" onClick={() => navigate("team")}>Meet the team <span aria-hidden="true">↗</span></button></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} CedarBite. All rights reserved.</span></div></footer>
    {addOnPromptItem && <div className="addon-prompt-scrim" onClick={() => setAddOnPromptItem(null)}><section className="addon-prompt" role="dialog" aria-modal="true" aria-labelledby="addon-prompt-title" onClick={(event) => event.stopPropagation()}><span className="section-kicker">MAKE IT YOURS</span><h2 id="addon-prompt-title">Add {addOnPromptItem.addon_name}?</h2><p>{addOnPromptItem.name} is {money(addOnPromptItem.price_paisa)}. Add {addOnPromptItem.addon_name} for {money(addOnPromptItem.addon_price_paisa ?? 0)} more?</p><div className="addon-prompt-actions"><button type="button" onClick={() => { addToCart(addOnPromptItem.id); setAddOnPromptItem(null); setCartOpen(true); }}>No thanks · {money(addOnPromptItem.price_paisa)}</button><button type="button" className="blue-button" onClick={() => { addToCart(addOnPromptItem.id, 1, true); setAddOnPromptItem(null); setCartOpen(true); }}>Add {addOnPromptItem.addon_name} · {money(addOnPromptItem.price_paisa + (addOnPromptItem.addon_price_paisa ?? 0))}</button></div><button type="button" className="addon-prompt-cancel" onClick={() => setAddOnPromptItem(null)}>Cancel</button></section></div>}
    {cartOpen && <div className="cart-scrim" onClick={() => setCartOpen(false)}><aside className="cart-drawer" onClick={(event) => event.stopPropagation()} aria-label="Your bucket"><div className="cart-head"><div><span className="section-kicker">YOUR ORDER</span><h2>Your bucket <small>({cartCount})</small></h2></div><button onClick={() => setCartOpen(false)} aria-label="Close bucket">×</button></div><div className="cart-service"><b>Pickup</b><span>{orderMode === "quick" ? "Quick Order · no slot required" : "Scheduled Order · choose a slot"}</span></div>{orderMode === "scheduled" && <label className="bucket-window">Choose your pickup slot<select value={selectedWindow} onChange={(event) => setSelectedWindow(event.target.value)}><option value="">{availablePickupWindows.length ? "Choose from the next available pickup slots" : "No pickup slots are available right now"}</option>{availablePickupWindows.slice(0, 6).map((window) => <option key={window.id} value={window.id}>{new Date(window.start_at).toLocaleString("en-PK", { timeZone:"Asia/Karachi", weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" })} – {formatPickupTime(window.end_at)}</option>)}</select></label>}<div className="cart-lines">{Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([key, quantity]) => { const [rawId, variant] = key.split(":"); const item = items.find((entry) => entry.id === Number(rawId)); if (!item) return null; const withAddon = variant === "addon"; const unitPrice = item.price_paisa + (withAddon ? item.addon_price_paisa ?? 0 : 0); const lineName = `${item.name.replace("[DEV SAMPLE] ", "")}${withAddon && item.addon_name ? ` + ${item.addon_name}` : ""}`; return <div className="cart-line" key={key}><div><b>{lineName}</b><small>{money(unitPrice)} each{withAddon ? " · add-on included" : ""}</small></div><div className="quantity-controls"><button onClick={() => addToCart(item.id, -1, withAddon)} aria-label={`Remove one ${lineName}`}>−</button><b>{quantity}</b><button onClick={() => addToCart(item.id, 1, withAddon)} aria-label={`Add one ${lineName}`}>+</button></div><strong>{money(unitPrice * quantity)}</strong></div>; })}{!cartCount && <div className="cart-empty"><span>▣</span><h3>Your bucket is empty</h3><p>Add a menu item to start building your order.</p><button className="blue-button" onClick={() => { setCartOpen(false); document.getElementById("menu")?.scrollIntoView({behavior:"smooth"}); }}>Browse menu</button></div>}</div><div className="cart-bottom"><div className="cart-total"><span>Subtotal</span><b>{money(cartTotal)}</b></div><label className="demo-payment">Payment method<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="wallet">CedarBite wallet · {money(walletBalance)}</option><option value="easypaisa">EasyPaisa</option><option value="jazzcash">JazzCash</option><option value="bank">Bank transfer</option><option value="card">Card</option><option value="cash">Cash at pickup</option></select></label><p className="checkout-hint">Review your items and pickup details before placing the order.</p>{orderError && <p className="order-error" role="alert">{orderError}</p>}<button className="checkout-button" disabled={!cartCount || orderSubmitting || user?.role !== "DEMO_STUDENT" || (orderMode === "scheduled" && !selectedWindow)} onClick={placeDemoOrder}>{orderSubmitting ? "Sending order…" : user?.role === "DEMO_STUDENT" ? "Place order" : "Sign in to place an order"}</button>{user?.role !== "DEMO_STUDENT" && <button className="cart-signin" onClick={() => loginDialog.current?.showModal()}>Sign in with your Cedar email</button>}</div></aside></div>}
    <dialog className="signin-dialog" ref={loginDialog}><button className="dialog-x" onClick={() => loginDialog.current?.close()} aria-label="Close sign in">×</button><CedarMark/><span className="section-kicker">WELCOME TO CEDARBITE</span><h2>Sign in with your<br/><span>cedar email</span></h2><p>Sign in with your Cedar College email to access student ordering and wallet features.</p>{googleReady ? <button className="google-button" onClick={startSignIn}><GoogleIcon/> Sign in with Google account</button> : <form className="demo-signin-form" onSubmit={(event) => { event.preventDefault(); demoSignIn(demoEmail); }}><label>Cedar email<input type="email" required value={demoEmail} onChange={(event) => setDemoEmail(event.target.value)} placeholder="your.email@cedar.edu.pk"/></label><button className="google-button">Continue with Cedar email</button><small>Cedar College account</small></form>}<small className="secure-hint">Your profile and wallet activity are saved in this browser.</small></dialog>
    {walletOpen && <div className="wallet-scrim" onClick={() => setWalletOpen(false)}><section className="wallet-panel" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={(event) => event.stopPropagation()}><div className="cart-head"><div><span className="section-kicker">CEDARBITE WALLET</span><h2 id="wallet-title">Your wallet</h2></div><button onClick={() => setWalletOpen(false)} aria-label="Close wallet">×</button></div><div className="wallet-balance"><span>Available balance</span><b>{money(walletBalance)}</b><small>{user?.role === "DEMO_STUDENT" ? "Wallet balance saved in this browser" : user?.role === "student" || user?.role === "staff_customer" ? "Shared account balance" : "Sign in with your Cedar account to view your wallet"}</small></div>{user?.role === "DEMO_STUDENT" ? <><label className="demo-payment">Top-up amount (PKR)<input type="number" min="100" max="5000" step="50" value={topUpAmount} onChange={(event) => setTopUpAmount(event.target.value)}/></label><label className="demo-payment">Top up using<select value={topUpMethod} onChange={(event) => setTopUpMethod(event.target.value)}><option value="easypaisa">EasyPaisa</option><option value="jazzcash">JazzCash</option><option value="bank">Bank transfer</option><option value="card">Card</option></select></label><p className="wallet-note">Online payment providers are not connected. A wallet balance added here is not backed by a verified payment.</p><button className="blue-button wallet-topup" onClick={() => void demoTopUp()} disabled={topUpSubmitting}>{topUpSubmitting ? "Updating wallet…" : "Add wallet balance"}</button></> : <p className="wallet-note">To add cash to this wallet, give the money to canteen staff and ask them to record it against your student ID.</p>}<h3>Recent wallet activity</h3>{walletEntries.length ? <div className="wallet-history">{walletEntries.slice(0,5).map((entry) => <div key={entry.id}><span><b>{entry.label}</b><small>{new Date(entry.created_at).toLocaleString()} · {entry.method}</small></span><strong className={entry.kind}>{entry.kind === "credit" ? "+" : "−"}{money(entry.amount)}</strong></div>)}</div> : <p className="wallet-empty">No wallet activity yet.</p>}</section></div>}
    {showOrderConfirmation && orderConfirmation && <div className="order-confirmation-scrim"><section className="order-confirmation" role="dialog" aria-modal="true" aria-labelledby="order-success-title" aria-describedby="order-success-description"><CedarMark/><div className="confirmation-check" aria-hidden="true">✓</div><span className="section-kicker">ORDER PLACED SUCCESSFULLY</span><h2 id="order-success-title">Your order is confirmed.</h2><p id="order-success-description">Show this pickup number to the canteen staff when you collect your order.</p><div className="confirmation-pickup"><small>PICKUP NUMBER</small><strong>{orderConfirmation.pickup_code}</strong></div><button className="blue-button" autoFocus onClick={() => { setShowOrderConfirmation(false); navigate("menu"); }}>Return to menu</button></section></div>}
    {toast && <div className="toast-message" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </div>;
}

function GoogleIcon() { return <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.25 5.48-4.73 7.18l7.35 5.7c4.29-3.96 7.42-9.8 7.42-17.35z"/><path fill="#FBBC05" d="M10.54 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a23.94 23.94 0 0 0 0 21.56l7.98-6.19z"/><path fill="#34A853" d="M24 48c6.47 0 11.9-2.13 15.86-6.1l-7.35-5.7c-2.04 1.38-4.65 2.2-8.51 2.2-6.26 0-11.57-4.22-13.46-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>; }

function TeamPage() {
  const members = [
    { name: "Eshwar Das", initials: "ED", role: "LEAD DEVELOPER", description: "Lead Developer for CedarBite, working with the team on the campus ordering experience." },
    { name: "Muhammad Eyad Imran", initials: "ME", role: "BACKEND DEVELOPER", description: "Collaborating on the data and shared order experience for CedarBite." },
    { name: "Mudassir", initials: "M", role: "FRONTEND DEVELOPER", description: "Helping shape the student and canteen interfaces as CedarBite develops." },
    { name: "Rayan", initials: "R", role: "PRODUCT & TESTING", description: "Exploring the student and staff experience and helping review the ordering flow." },
  ];
  return <main className="team-page">
    <section className="team-hero"><span className="section-kicker">TEAM BEHIND CEDARBITE</span><h1>Four students.<br/><span>One shared idea.</span></h1><p>We are the student team building CedarBite for the Cedar College community.</p><div className="team-hero-orbit" aria-hidden="true"><span><CedarMark/></span><i/><b/></div></section>
    <section className="team-roster" aria-labelledby="team-roster-title"><div className="team-section-heading"><div><span className="section-kicker">MEET THE TEAM</span><h2 id="team-roster-title">Built together at Cedar.</h2></div><span className="team-count">04 <small>COLLABORATORS</small></span></div><div className="team-member-list">{members.map((member, index) => <article className="team-member-row" key={member.name} style={{ "--team-index": index } as React.CSSProperties}><div className="team-member-visual"><div className="team-member-orbit" aria-hidden="true"><i/></div><div className="team-member-avatar" role="img" aria-label={`${member.initials} initials portrait for ${member.name}`}><span>{member.initials}</span></div><span className="team-member-index">0{index + 1}</span></div><div className="team-member-copy"><span className="team-role">{member.role}</span><h3>{member.name}</h3><p>{member.description}</p></div><span className="team-row-arrow" aria-hidden="true">↗</span></article>)}</div></section>
  </main>;
}

function InfoPage({ page }: { page: "about" | "privacy" | "contact" }) {
  if (page === "about") return <main className="info-page"><span className="section-kicker">ABOUT CEDARBITE</span><h1>More time for your break.</h1><p className="info-lead">CedarBite brings Cedar College canteen ordering into one clear flow.</p><div className="info-callout"><b>Built around a smoother break.</b><p>Browse the canteen menu, place a pickup order, and manage your CedarBite wallet in one place.</p></div><h2>Two ways to order</h2><p><b>Quick Order</b> is for ready-to-sell items, with no later pickup slot. <b>Scheduled Order</b> lets students choose a pickup window for items that need preparation. Canteen staff can manage menu availability and move orders through preparation and pickup.</p><h2>Made for the Cedar community</h2><p>CedarBite connects students and canteen staff through a shared menu and order workflow.</p></main>;
  if (page === "privacy") return <main className="info-page"><span className="section-kicker">PRIVACY INFORMATION</span><h1>Privacy policy</h1><p className="info-lead">This page explains what CedarBite stores when you use the ordering and canteen services.</p><h2>Account information</h2><p>Student sign-in uses a Cedar College email and derives the student ID from the part before @cedar.edu.pk. When Google sign-in is enabled, Google verifies account ownership. If email-entry sign-in is shown, entering an address alone does not verify that the user owns it. Staff accounts use station credentials.</p><h2>Orders</h2><p>Orders may include a student ID, pickup code, items, order time, payment method, and payment status. Shared orders are stored for canteen staff to manage and remain in the order history until removed by an authorized staff member.</p><h2>Wallet and payments</h2><p>Wallet balances and activity are stored in the student’s browser, with cashier credits and wallet refunds recorded in shared storage. Cash payments are marked received by staff after cash is collected. EasyPaisa, JazzCash, bank, and card selections do not initiate or verify a transfer; a selected method is not proof that payment was received.</p><h2>Contact</h2><p>For questions about an order or personal information, speak to CedarBite staff or use Cedar College’s existing contact channels.</p></main>;
  return <main className="info-page"><span className="section-kicker">CONTACT</span><h1>Talk to the CedarBite team.</h1><p className="info-lead">For help with an order, share your pickup ID with canteen staff at the counter.</p><div className="info-callout"><b>Order support</b><p>Canteen staff can check an order’s status using its pickup ID.</p></div><h2>Other questions</h2><p>For general questions about CedarBite, speak with a member of the CedarBite team through Cedar College’s existing communication channels.</p></main>;
}
function MenuItemEditForm({ item, categories, saving, onCancel, onSave }: { item: Item; categories: Category[]; saving: boolean; onCancel: () => void; onSave: (item: Item, values: MenuItemEditValues) => Promise<void> }) {
  const [imageData, setImageData] = useState(item.image_data ?? "");
  const [imageError, setImageError] = useState("");
  const [formError, setFormError] = useState("");
  const [imageLoading, setImageLoading] = useState(false);
  const [formSaving, setFormSaving] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageVersion = useRef(0);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const category_id = Number(data.get("category_id"));
    const price = Number(data.get("price"));
    const quick_allowed = data.get("quick") === "on";
    const scheduled_allowed = data.get("scheduled") === "on";
    const prepValue = String(data.get("prep_minutes") ?? "").trim();
    const addonName = String(data.get("addon_name") ?? "").trim();
    const addonPrice = Number(data.get("addon_price") || 0);
    if (!name || !categories.some((category) => category.id === category_id) || !Number.isFinite(price) || price < 0 || (addonName && (!Number.isFinite(addonPrice) || addonPrice < 0)) || (!quick_allowed && !scheduled_allowed)) {
      setFormError("Check the name, category, price, and select at least one order mode.");
      return;
    }
    setFormSaving(true);
    setFormError("");
    try {
      await onSave(item, {
        category_id,
        name,
        description: String(data.get("description") ?? "").trim(),
        price_paisa: Math.round(price * 100),
        quick_allowed,
        scheduled_allowed,
        prep_minutes: prepValue ? Number(prepValue) : null,
        image_data: imageData || null,
        addon_name: String(data.get("addon_name") ?? "").trim() || null,
        addon_price_paisa: String(data.get("addon_name") ?? "").trim() ? Math.round(Number(data.get("addon_price") || 0) * 100) : 0,
      });
      onCancel();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The menu item could not be updated.");
    } finally {
      setFormSaving(false);
    }
  }
  return <form className="menu-item-edit-form" onSubmit={(event) => void submit(event)}>
    <div className="menu-edit-fields"><label>Item name<input name="name" required maxLength={120} defaultValue={item.name}/></label><label>Category<select name="category_id" defaultValue={String(item.category_id)} required>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Description<textarea name="description" rows={2} maxLength={500} defaultValue={item.description}/></label><label>Price in PKR<input name="price" type="number" min="0" step="1" required defaultValue={Math.round(item.price_paisa / 100)}/></label><label>Add-on name (optional)<input name="addon_name" maxLength={80} placeholder="e.g. Fries, extra cheese" defaultValue={item.addon_name ?? ""}/></label><label>Add-on extra price (PKR)<input name="addon_price" type="number" min="0" step="1" defaultValue={Math.round((item.addon_price_paisa ?? 0) / 100)}/></label><label>Preparation time in minutes<input name="prep_minutes" type="number" min="0" max="240" placeholder="Optional" defaultValue={item.prep_minutes ?? ""}/></label><div className="check-row"><label><input type="checkbox" name="quick" defaultChecked={item.quick_allowed}/> Quick pickup</label><label><input type="checkbox" name="scheduled" defaultChecked={item.scheduled_allowed}/> Scheduled order</label></div></div>
    <label className="menu-edit-image">Item image<input ref={imageInput} type="file" accept="image/*" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; const version = ++imageVersion.current; setImageError(""); if (!file) return; setImageLoading(true); void resizeMenuImage(file).then((image) => { if (version === imageVersion.current) setImageData(image); }).catch((error) => { if (version === imageVersion.current) { setImageError(error instanceof Error ? error.message : "This image could not be loaded."); input.value = ""; } }).finally(() => { if (version === imageVersion.current) setImageLoading(false); }); }}/></label>
    {imageData && <div className="item-image-preview"><img src={imageData} alt={`Preview of ${item.name}`}/><button type="button" disabled={saving || formSaving} onClick={() => { imageVersion.current += 1; setImageData(""); setImageLoading(false); if (imageInput.current) imageInput.current.value = ""; }}>Remove image</button></div>}
    {imageLoading && <p className="form-message" role="status">Preparing image…</p>}{imageError && <p className="form-message error-message" role="alert">{imageError}</p>}{formError && <p className="form-message error-message" role="alert">{formError}</p>}
    <div className="menu-edit-actions"><button type="button" disabled={saving || formSaving} onClick={onCancel}>Cancel</button><button className="blue-button" disabled={saving || formSaving || imageLoading}>{saving || formSaving ? "Saving…" : "Save changes"}</button></div>
  </form>;
}

function FoodCard({ item, index, orderMode, onAdd, canOrder }: { item: Item; index: number; orderMode: OrderMode; onAdd: () => void; canOrder: boolean }) {
  const allowedForMode = orderMode === "quick" ? item.quick_allowed : item.scheduled_allowed;
  const orderBlocked = !item.available || !canOrder;
  const modeLabel = item.quick_allowed && item.scheduled_allowed ? "QUICK + SCHEDULED" : item.quick_allowed ? "QUICK PICKUP" : "SCHEDULED PICKUP";
  const actionLabel = !item.available ? "Sold out" : !canOrder ? "Closed" : !allowedForMode ? orderMode === "quick" ? "Switch to Schedule" : "Switch to Quick" : "Add";
  return <article className={`food-card ${!item.available ? "sold-out" : ""}`}><div className={`food-picture picture-${index % 4}`}>{item.image_data ? <img className="food-item-photo" src={item.image_data} alt={item.name}/> : <span className="food-emoji">{itemIcon(item)}</span>}<span className="food-tag">{modeLabel}</span></div><div className="food-info"><div className="food-name-price"><h4>{item.name.replace("[DEV SAMPLE] ", "")}</h4><b>{item.price_display}</b></div><p>{item.description || (item.prep_minutes ? `Made to order · about ${item.prep_minutes} minutes` : "A canteen favourite.")}</p><div className="food-bottom"><span className={item.available ? "stock-yes" : "stock-no"}><i/> {item.available ? !allowedForMode ? `Choose ${orderMode === "quick" ? "Schedule Order" : "Quick Order"}` : "Available" : "Sold out"}</span><button onClick={onAdd} disabled={orderBlocked} aria-label={!item.available ? `${item.name} is sold out` : !canOrder ? `Quick Orders are closed for ${item.name}` : !allowedForMode ? `Switch order mode to add ${item.name}` : `Add ${item.name} to bucket`}>{actionLabel}{allowedForMode && item.available && canOrder && <span> +</span>}</button></div></div></article>;
}

function OrderCard({ order }: { order: Order }) { return <article className="order-row"><div className="order-row-top"><b>Pickup number: {order.pickup_code}</b><span className="order-status">{human(order.status)}</span><span className="order-date">{new Date(order.created_at).toLocaleString()}</span></div><p>{order.items.map((line, index) => <span key={`${line.name}-${index}`}>{line.quantity} × {line.name}</span>)}</p><div className="order-row-bottom"><span>{human(order.mode)}{order.pickup_window ? ` · ${new Date(order.pickup_window.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " · Quick pickup"}</span><b>{order.total_display}</b></div></article>; }

type OwnerProps = { station: "order_manager" | "cashier"; user: User | null; googleReady: boolean; categories: Category[]; items: (Item & { category: string })[]; queue: Order[]; orderHistory: Order[]; salesSummary: SalesSummary | null; salesSummaryDates: string[]; salesSummaryError: string; salesSummaryLoading: boolean; onLoadSalesSummary: (date?: string) => void; onLoadSalesDates: () => void; onDeleteSalesSummary: (date: string) => Promise<void>; walletTopUpHistory: WalletTopUpHistoryEntry[]; walletHistoryError: string; walletHistoryLoading: boolean; onLoadHistory: () => void; onLoadWalletTopUpHistory: () => void; queuePendingIds: string[]; deals: Deal[]; darkMode: boolean; onToggleTheme: () => void; canManage: boolean; canSortMenu: boolean; onReorderMenuItems: (sourceId: number, targetId: number) => void; onReorderMenuCategories: (sourceId: number, targetId: number) => void; canToggle: boolean; availabilityPending: number[]; menuMutationPending: boolean; itemAddPending: boolean; canQueue: boolean; canTopUp: boolean; walletMessage: string; walletPending: boolean; onCashTopUp: (form: HTMLFormElement) => void; itemMessage: string; dealMessage: string; orderingReason: string; onSignIn: () => void; onDemoStaff: (username: string, password: string, station: string) => Promise<void>; onSignOut: () => void; onReturnToActive: () => void; onBack: () => void; onToggle: (item: Item) => void; onPrice: (item: Item, form: HTMLFormElement) => void; onAddCategory: (form: HTMLFormElement) => void; onRemoveCategory: (category: Category, targetCategoryId?: number) => Promise<boolean>; onAddItem: (event: FormEvent<HTMLFormElement>) => void; onRemoveItem: (item: Item) => Promise<boolean>; onUpdateItem: (item: Item, values: MenuItemEditValues) => Promise<void>; onAdvance: (order: Order) => void; onDeleteOrder: (order: Order) => void; onDeleteHistoryOrder: (order: Order) => void; onRefundHistoryOrder: (order: Order) => void; onMarkCashPaid: (order: Order) => void; onChangePassword: (newPassword: string) => Promise<void>; onResetPassword: (station: string, newPassword: string) => Promise<void>; onToggleOrdering: () => void; onDeal: (event: FormEvent<HTMLFormElement>) => void; onDealToggle: (id: string) => void; onRefresh: () => void };
function OwnerApp(props: OwnerProps) {
  const initialTab = props.station === "cashier" ? "Cash receipts" : "Overview";
  const [tab, setTab] = useState(initialTab);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [salesDate, setSalesDate] = useState(pakistanDay());
  const [salesDeleteConfirmDate, setSalesDeleteConfirmDate] = useState<string | null>(null);
  const [salesDeletePendingDate, setSalesDeletePendingDate] = useState<string | null>(null);
  const [salesDeleteError, setSalesDeleteError] = useState("");
  const [removeCategoryConfirmId, setRemoveCategoryConfirmId] = useState<number | null>(null);
  const [removeCategoryTargetId, setRemoveCategoryTargetId] = useState<number | null>(null);
  const [newItemImage, setNewItemImage] = useState("");
  const [newItemImageError, setNewItemImageError] = useState("");
  const [newItemImageLoading, setNewItemImageLoading] = useState(false);
  const itemImageInput = useRef<HTMLInputElement>(null);
  const itemImageLoadVersion = useRef(0);
  const lastItemAddPending = useRef(false);
  const [demoUsername, setDemoUsername] = useState("");
  const [demoPassword, setDemoPassword] = useState("");
  const [demoLoginError, setDemoLoginError] = useState("");
  const [removeConfirmId, setRemoveConfirmId] = useState<number | null>(null);
  const [editingMenuItemId, setEditingMenuItemId] = useState<number | null>(null);
  const [receiptRequest, setReceiptRequest] = useState<{ order: Order; key: string } | null>(null);
  useAutoPrintReceipt(receiptRequest);
  const { user, categories, items, queue, deals, canManage, canToggle, canQueue } = props;
  const activeStation = sessionStorage.getItem(CANTEEN_ROLE_KEY);
  const stationConflict = Boolean((activeStation && activeStation !== props.station) || (user && (user.role !== "DEMO_CANTEEN" || activeStation !== props.station)));
  const waiting = queue.filter((order) => ["SUBMITTED", "ACCEPTED", "PREPARING"].includes(order.status)).length;
  const tabs = props.station === "cashier" ? ["Cash receipts", "Wallet top-ups", "Wallet top-up history"] : ["Overview", "Daily sales", "Orders history", "Menu", "Deals", "Staff passwords"];
  useEffect(() => {
    if (lastItemAddPending.current && !props.itemAddPending && /is now on the shared menu|Added to the canteen menu/.test(props.itemMessage)) {
      setNewItemImage("");
      setNewItemImageError("");
      setNewItemImageLoading(false);
      if (itemImageInput.current) itemImageInput.current.value = "";
    }
    lastItemAddPending.current = props.itemAddPending;
  }, [props.itemAddPending, props.itemMessage]);
  async function removeSalesSummary(date: string) {
    setSalesDeleteError("");
    setSalesDeletePendingDate(date);
    try {
      await props.onDeleteSalesSummary(date);
      setSalesDeleteConfirmDate(null);
      if (salesDate === date) setSalesDate("");
    } catch (error) {
      setSalesDeleteError(error instanceof Error ? error.message : "This summary could not be removed.");
    } finally {
      setSalesDeletePendingDate(null);
    }
  }  return <div className="owner-app"><aside className="owner-sidebar"><button className="owner-logo" onClick={props.onBack}><CedarMark/><span>Cedar<span>Bite</span><small>CANTEEN CONSOLE</small></span></button><button type="button" className="owner-mobile-toggle" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}><span>{tab}</span><b>{mobileNavOpen ? "Close" : "Navigate"}<i aria-hidden="true">{mobileNavOpen ? "×" : "☰"}</i></b></button><div className={`owner-nav-content ${mobileNavOpen ? "is-open" : ""}`}><span className="sidebar-label">WORKSPACE</span>{tabs.map((name) => <button key={name} className={`sidebar-link ${tab === name ? "active" : ""}`} onClick={() => { setTab(name); setMobileNavOpen(false); if (name === "Orders history") props.onLoadHistory(); if (name === "Daily sales") { const today = pakistanDay(); setSalesDate(today); props.onLoadSalesDates(); props.onLoadSalesSummary(today); } if (name === "Wallet top-up history") props.onLoadWalletTopUpHistory(); }}><span>{({Overview:"⌂","Daily sales":"▥","New orders":"▤",Preparing:"◷","Order Ready":"✓", "Orders history":"▤",Menu:"☷",Deals:"✦","Staff passwords":"⚿", "Cash receipts":"¤", "Wallet top-ups":"＋", "Wallet top-up history":"≡"} as Record<string,string>)[name]}</span>{name}{name === "New orders" && queue.filter((order) => order.status === "SUBMITTED").length > 0 && <i>{queue.filter((order) => order.status === "SUBMITTED").length}</i>}</button>)}<a className="owner-all-stations-link" href="/stations">← All staff stations</a><button className="back-store owner-mobile-back-store" onClick={props.onBack}>← Back to student menu</button></div><div className="sidebar-spacer"/><div className="service-state"><span className="state-dot"/> <span><b>Canteen service</b><small>{props.orderingReason}</small></span></div><button className="back-store" onClick={props.onBack}>← Back to student menu</button></aside>
    <div className="owner-main"><header className="owner-topbar"><div><span className="owner-crumb">CEDARBITE <span>/</span> CANTEEN</span><h1>{({Overview:"Canteen overview","Daily sales":"Daily sales summary","New orders":"New orders",Preparing:"Preparing","Order Ready":"Order Ready","Orders history":"Completed order history",Menu:"Menu management",Deals:"Deals & offers","Staff passwords":"Staff password reset","Cash receipts":"Cash receipts","Wallet top-ups":"Student wallet top-ups","Wallet top-up history":"Wallet top-up history"} as Record<string,string>)[tab] ?? "Canteen console"}</h1></div><div className="owner-top-actions"><a className="owner-stations-button" href="/stations">Staff stations <span aria-hidden="true">↗</span></a><button className="refresh-link" onClick={() => { props.onRefresh(); if (tab === "Daily sales") { props.onLoadSalesDates(); if (isValidSalesDate(salesDate)) props.onLoadSalesSummary(salesDate); } }}>↻ Refresh</button>{user ? <button className="owner-user" onClick={props.onSignOut}><span>{user.email.slice(0,1).toUpperCase()}</span>{user.email} · Sign out</button> : <button className="sign-button" onClick={props.onSignIn}>Sign in</button>}{user && sessionStorage.getItem(CANTEEN_ROLE_KEY) === props.station && <ChangePasswordForm station={props.station} onChange={props.onChangePassword}/>}<button className="theme-toggle owner-theme-toggle" onClick={props.onToggleTheme} aria-label={`Switch to ${props.darkMode ? "light" : "dark"} mode`} title={props.darkMode ? "Switch to light mode" : "Switch to dark mode"}><span aria-hidden="true">{props.darkMode ? "☀" : "☾"}</span></button></div></header>
    {stationConflict ? <StationSwitchPrompt activeStation={activeStation} activeUser={user} targetStation={props.station} onSignOut={props.onSignOut} onReturn={props.onReturnToActive}/> : !user || sessionStorage.getItem(CANTEEN_ROLE_KEY) !== props.station ? <section className="owner-lock"><div className="lock-emblem"><CedarMark/></div><span className="section-kicker">{props.station === "cashier" ? "CASH DESK" : "ORDER CONTROL"}</span><h2>{props.station === "cashier" ? <>Cash desk<br/><span>staff sign-in.</span></> : <>Canteen order<br/><span>management.</span></>}</h2><p>Sign in with the username and password for this staff station.</p><form className="demo-signin-form" onSubmit={(event) => { event.preventDefault(); setDemoLoginError(""); void props.onDemoStaff(demoUsername, demoPassword, props.station).catch((error) => setDemoLoginError(error instanceof Error ? error.message : "Sign-in failed.")); }}><label>Username<input autoComplete="username" required value={demoUsername} onChange={(event) => setDemoUsername(event.target.value)} placeholder={props.station === "cashier" ? "cashdesk" : "manager"}/></label><label>Password<input type="password" autoComplete="current-password" required value={demoPassword} onChange={(event) => setDemoPassword(event.target.value)} placeholder="Enter station password"/></label>{demoLoginError && <p className="form-message error-message">{demoLoginError}</p>}<button className="blue-button">Log in to {props.station === "cashier" ? "cash desk" : "order control"}</button></form><p className="password-help">Forgot password? {props.station === "cashier" ? "Ask the order manager to reset the cash desk password." : "If you are the order manager, update your password in Netlify environment variables."}</p><button className="back-to-store" onClick={props.onBack}>← Return to student menu</button></section> : !(canManage || canToggle || canQueue || props.canTopUp) ? <section className="owner-lock"><span className="section-kicker">STAFF WORKSPACE</span><h2>This account<br/><span>doesn’t have staff access.</span></h2><p>Use the credentials assigned to this staff station.</p><button className="blue-button" onClick={props.onSignOut}>Sign out</button><button className="back-to-store" onClick={props.onBack}>Return to student menu</button></section> : <>
      <div className="owner-banner"><div><b>Canteen workspace · shared queue and availability</b><span>Pickup orders, menu items, prices, and availability sync across devices.</span></div><button onClick={props.onToggleOrdering}>{props.orderingReason.includes("paused") ? "Resume ordering" : "Pause ordering"}</button></div>
      {tab === "Overview" && <section className="owner-content"><div className="metric-grid"><article><span>ACTIVE MENU ITEMS</span><b>{items.length}</b><small>Across {categories.length} menu categories</small></article><article><span>ORDERS TO FULFIL</span><b>{waiting}</b><small>{canQueue ? "Needs canteen attention" : "Queue access is restricted"}</small></article><article><span>AVAILABLE ITEMS</span><b>{items.filter((item) => item.available).length}</b><small>{items.filter((item) => !item.available).length} currently unavailable</small></article></div><div className="order-stage-cards"><button onClick={() => document.getElementById("new-orders-list")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>NEW ORDERS</span><b>{queue.filter((order) => order.status === "SUBMITTED").length}</b><small>Review and accept</small></button><button onClick={() => document.getElementById("preparing-list")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>PREPARING</span><b>{queue.filter((order) => ["PREPARING", "ACCEPTED"].includes(order.status)).length}</b><small>Shown on kitchen monitor</small></button><button onClick={() => document.getElementById("ready-list")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>ORDER READY</span><b>{queue.filter((order) => order.status === "READY").length}</b><small>Waiting for pickup</small></button></div>{canQueue ? <><div className="owner-workflow-sections"><section className="owner-panel" id="new-orders-list"><div className="panel-heading"><div><span className="section-kicker">INCOMING</span><h2>New orders</h2></div><span className="queue-live"><i/> {queue.filter((order) => order.status === "SUBMITTED").length} waiting</span></div>{queue.filter((order) => order.status === "SUBMITTED").length ? <div className="queue-list">{queue.filter((order) => order.status === "SUBMITTED").map((order) => <QueueItem key={order.id} order={order} pending={props.queuePendingIds.includes(String(order.id))} onAdvance={props.onAdvance} onDelete={props.onDeleteOrder}/>)}</div> : <div className="panel-empty">No new orders are waiting for acceptance.</div>}</section><section className="owner-panel" id="preparing-list"><div className="panel-heading"><div><span className="section-kicker">IN THE KITCHEN</span><h2>Preparing</h2></div><span className="queue-live"><i/> {queue.filter((order) => ["PREPARING", "ACCEPTED"].includes(order.status)).length} in progress</span></div>{queue.filter((order) => ["PREPARING", "ACCEPTED"].includes(order.status)).length ? <div className="queue-list">{queue.filter((order) => ["PREPARING", "ACCEPTED"].includes(order.status)).map((order) => <QueueItem key={order.id} order={order} pending={props.queuePendingIds.includes(String(order.id))} onAdvance={props.onAdvance}/>)}</div> : <div className="panel-empty">No orders are being prepared.</div>}</section><section className="owner-panel" id="ready-list"><div className="panel-heading"><div><span className="section-kicker">READY FOR COLLECTION</span><h2>Order ready</h2></div><span className="queue-live"><i/> {queue.filter((order) => order.status === "READY").length} awaiting pickup</span></div>{queue.filter((order) => order.status === "READY").length ? <div className="queue-list">{queue.filter((order) => order.status === "READY").map((order) => <QueueItem key={order.id} order={order} pending={props.queuePendingIds.includes(String(order.id))} onAdvance={props.onAdvance}/>)}</div> : <div className="panel-empty">No orders are ready for pickup.</div>}<PickupLookup queue={queue} pendingIds={props.queuePendingIds} onConfirm={props.onAdvance}/></section></div></> : <div className="panel-empty large">Queue access is not enabled for your account.</div>}<section className="owner-panel overview-availability"><div className="panel-heading"><div><span className="section-kicker">MENU STATUS</span><h2>Availability</h2></div><button onClick={() => setTab("Menu")}>Manage menu →</button></div>{items.map((item) => <div className="mini-menu-row" key={item.id}><MenuItemVisual item={item} className="mini-food"/><span><b>{item.name.replace("[DEV SAMPLE] ", "")}</b><small>{item.price_display}</small></span><AvailabilitySwitch item={item} disabled={!canToggle || props.availabilityPending.includes(item.id)} onToggle={props.onToggle}/></div>)}</section></section>}      {tab === "Cash receipts" && props.station === "cashier" && <section className="owner-content"><div className="panel-heading"><div><span className="section-kicker">PAY AT PICKUP</span><h2>Cash orders awaiting payment</h2></div><span className="queue-live"><i/> Shared cash desk queue</span></div>{queue.length ? <div className="queue-list">{queue.map((order) => <article className="queue-item" key={order.id}><div className="queue-number">{order.pickup_code}<small>Pickup number</small></div><div className="queue-details"><div><b>{human(order.status)} · {order.payment_status === "PAID" ? "Paid" : "Payment due"}</b><small>{orderCustomerLabel(order)}</small></div><p>{order.items.map((line, index) => <span key={`${order.id}-${index}`}>{line.quantity} × {line.name}</span>)}</p></div><div className="queue-amount">{order.total_display}</div>{order.payment_status !== "PAID" && <button className="blue-button queue-action" disabled={props.queuePendingIds.includes(String(order.id))} onClick={() => props.onMarkCashPaid(order)}>{props.queuePendingIds.includes(String(order.id)) ? "Saving…" : "Record cash received"}</button>}</article>)}</div> : <div className="panel-empty large">No unpaid cash orders right now.</div>}</section>}
      {tab === "Daily sales" && <section className="owner-content sales-report"><section className="owner-panel sales-report-heading"><div><span className="section-kicker">CANTEEN PERFORMANCE</span><h2>{salesDateLabel(salesDate)}</h2><p>Daily sales and item counts, based on orders recorded as paid.</p></div><label>Summary date<input aria-label="Summary date" type="date" max={pakistanDay()} value={salesDate} onChange={(event) => { const date = event.target.value; setSalesDate(date); if (isValidSalesDate(date)) props.onLoadSalesSummary(date); }}/></label></section><section className="owner-panel sales-date-panel"><div><span className="section-kicker">PAST SUMMARIES</span><h2>Previous day summaries</h2><p>Choose a date to open its saved daily results. Removing a summary keeps the underlying orders and payment records.</p></div><div className="sales-date-list">{props.salesSummaryDates.filter((date) => date < pakistanDay()).map((date) => <div className="sales-date-entry" key={date}><button type="button" className={`sales-date-open ${salesDate === date ? "selected" : ""}`} aria-pressed={salesDate === date} onClick={() => { setSalesDate(date); setSalesDeleteError(""); props.onLoadSalesSummary(date); }}><b>{salesDateLabel(date)}</b><span>Open summary →</span></button>{canManage && (salesDeleteConfirmDate === date ? <div className="sales-delete-confirm" role="group" aria-label={`Confirm removing ${salesDateLabel(date)} summary`}><span>Remove this summary? Order records stay.</span><div><button type="button" onClick={() => { setSalesDeleteConfirmDate(null); setSalesDeleteError(""); }} disabled={salesDeletePendingDate === date}>Cancel</button><button type="button" className="confirm" onClick={() => void removeSalesSummary(date)} disabled={salesDeletePendingDate === date}>{salesDeletePendingDate === date ? "Removing…" : "Remove"}</button></div></div> : <button type="button" className="sales-date-delete" aria-label={`Remove ${salesDateLabel(date)} summary`} title="Remove this summary" onClick={() => { setSalesDeleteError(""); setSalesDeleteConfirmDate(date); }}><span aria-hidden="true">×</span></button>)}</div>)}{!props.salesSummaryDates.some((date) => date < pakistanDay()) && <span className="sales-no-days">Previous dates will appear here when orders have been recorded.</span>}</div>{salesDeleteError && <p className="form-message error-message" role="alert">{salesDeleteError}</p>}</section>{salesDate && props.salesSummaryError && <div className="panel-empty large sales-report-error" role="alert"><b>Summary unavailable</b><p>{props.salesSummaryError}</p><button className="blue-button" onClick={() => { props.onLoadSalesDates(); if (isValidSalesDate(salesDate)) props.onLoadSalesSummary(salesDate); }}>Try again</button></div>}{salesDate && props.salesSummaryLoading && <div className="panel-empty large" role="status">Loading daily summary…</div>}{!salesDate ? <div className="panel-empty large">Choose a date to view its daily summary.</div> : !props.salesSummaryLoading && !props.salesSummaryError && props.salesSummary && <><div className="sales-kpi-grid"><article><span>PAID SALES</span><b>{money(props.salesSummary.paid_sales_paisa)}</b><small>Confirmed order payments</small></article><article><span>PAID ORDERS</span><b>{props.salesSummary.paid_orders}</b><small>Orders counted as sales</small></article><article><span>ITEMS SOLD</span><b>{props.salesSummary.units_sold}</b><small>Units in paid orders</small></article><article><span>ORDERS PLACED</span><b>{props.salesSummary.orders_placed}</b><small>{props.salesSummary.pending_payment_orders} still unpaid or pending</small></article></div><section className="owner-panel sales-items-panel"><div className="panel-heading"><div><span className="section-kicker">ITEM BREAKDOWN</span><h2>What sold</h2></div><span className="queue-live">{props.salesSummary.items_sold.length} item types</span></div>{props.salesSummary.items_sold.length ? <div className="sales-item-chart">{props.salesSummary.items_sold.map((item) => <div className="sales-item-bar" key={item.name}><b>{item.name}</b><div className="sales-item-track"><span style={{ width: `${Math.max(4, item.quantity / Math.max(1, ...props.salesSummary!.items_sold.map((entry) => entry.quantity)) * 100)}%` }}/></div><strong>{item.quantity}</strong></div>)}</div> : <div className="panel-empty">No paid items were recorded for this date.</div>}</section><div className="sales-bottom-grid"><section className="owner-panel"><span className="section-kicker">PAYMENT SPLIT</span><h2>Paid by method</h2>{props.salesSummary.payment_methods.length ? <div className="sales-method-list">{props.salesSummary.payment_methods.map((entry) => <div key={entry.method}><span><b>{human(entry.method)}</b><small>{entry.count} paid orders</small></span><strong>{money(entry.amount_paisa)}</strong></div>)}</div> : <div className="panel-empty">No confirmed payments for this date.</div>}</section><section className="owner-panel"><span className="section-kicker">ORDER ACTIVITY</span><h2>Placed that day</h2><div className="sales-activity-row"><span>Order value placed</span><b>{money(props.salesSummary.placed_order_value_paisa)}</b></div><div className="sales-activity-row"><span>Payment still due</span><b>{props.salesSummary.pending_payment_orders}</b></div><p className="sample-reminder">Unpaid or pending orders are not included in paid sales or items sold.</p></section></div></>}</section>}      {tab === "Orders history" && <section className="owner-content"><div className="panel-heading"><div><span className="section-kicker">COMPLETED COLLECTIONS</span><h2>Orders history</h2></div><button onClick={props.onLoadHistory}>↻ Refresh history</button></div>{props.orderHistory.length ? <div className="queue-list">{props.orderHistory.map((order) => { const pending = props.queuePendingIds.includes(String(order.id)); const paymentMethod = String(order.payment_method || "cash").trim().toLowerCase(); const eligible = paymentMethod === "wallet" || String(order.payment_status || "").trim().toUpperCase() === "PAID"; return <article className="queue-item history-item" key={order.id}><div className="queue-number">{order.pickup_code}<small>Pickup number</small></div><div className="queue-details"><div><b>{order.refund_status === "REFUNDED" ? "Refunded" : "Collected"}</b><small>{new Date(order.completed_at ?? order.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} · {human(order.payment_method || "cash")} · {human(order.payment_status || "unpaid")}</small>{order.refunded_at && <small>Refunded {new Date(order.refunded_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} · {human(order.refund_method || "wallet")}</small>}</div><p>{order.items.map((line, index) => <span key={`${order.id}-${index}`}>{line.quantity} × {line.name}</span>)}</p><small className="queue-student-id">{orderCustomerLabel(order)}</small></div><div className="queue-amount">{order.total_display}</div><div className="history-actions"><button type="button" className="receipt-print-button" onClick={() => setReceiptRequest({ order, key: crypto.randomUUID() })} aria-label={`Print receipt for order ${order.pickup_code}`} title="Print receipt">▤</button>{canManage && order.refund_status !== "REFUNDED" && <button type="button" className="history-refund-button" disabled={pending || !eligible} onClick={() => props.onRefundHistoryOrder(order)} title={!eligible ? paymentMethod === "cash" ? "Record cash received in Cash Desk before refunding" : "This payment is not marked as paid" : paymentMethod === "wallet" ? "Return funds to the student's wallet" : "Record that the payment was returned manually"} aria-label={`Refund order ${order.pickup_code}`}>{pending ? "…" : paymentMethod === "wallet" ? "Refund to wallet" : "Record refund"}</button>}{order.refund_status === "REFUNDED" && <span className="refund-complete-label">Refunded</span>}{canManage && <button type="button" className="history-delete-button" disabled={pending} onClick={() => props.onDeleteHistoryOrder(order)} aria-label={`Delete order ${order.pickup_code} from history`} title="Delete from history"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2m2 0-.7 10H6.7L6 6m2.5 2.5v5m3-5v5"/></svg></button>}</div></article>; })}</div> : <div className="panel-empty large">No completed orders have been recorded yet.</div>}</section>}{tab === "Menu" && <section className="owner-content"><div className="owner-columns"><section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">CATALOGUE</span><h2>Menu items</h2></div><span className="queue-live">{items.length} items</span></div>{props.canSortMenu && <p className="menu-sort-help">Drag the grip or use the arrows to reorder items within their category. The new order is saved for everyone.</p>}{items.map((item) => <div className="menu-admin-row" key={item.id} onDragOver={(event) => { if (props.canSortMenu) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const sourceId = Number(event.dataTransfer.getData("text/plain")); if (sourceId) props.onReorderMenuItems(sourceId, item.id); }}><div className="menu-admin-name">{props.canSortMenu && <MenuSortHandle item={item} items={items.filter((entry) => entry.category_id === item.category_id)} disabled={props.menuMutationPending} onMove={props.onReorderMenuItems}/>}<MenuItemVisual item={item} className="mini-food"/><span><b>{item.name}</b><small>{item.category} · {item.quick_allowed ? "Quick pickup" : "Prepared"}{item.addon_name ? ` · Extra: ${item.addon_name} (+${money(item.addon_price_paisa ?? 0)})` : ""}</small></span></div><form className="price-edit" onSubmit={(event) => { event.preventDefault(); props.onPrice(item, event.currentTarget); }}><span>Rs</span><input aria-label={`Price for ${item.name}`} name="price" type="number" min="0" step="1" defaultValue={Math.round(item.price_paisa / 100)} disabled={!canManage || props.menuMutationPending}/><button disabled={!canManage || props.menuMutationPending}>Save</button></form><AvailabilitySwitch item={item} disabled={!canToggle || props.availabilityPending.includes(item.id)} onToggle={props.onToggle}/><button type="button" className="menu-edit-icon" disabled={!canManage || props.menuMutationPending} aria-label={`Edit ${item.name}`} title="Edit menu item" onClick={() => setEditingMenuItemId(item.id)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5 3 3M4 16l3.5-.8L16 6.7a1.4 1.4 0 0 0-2-2l-8.5 8.5L4 16Z"/></svg></button>{editingMenuItemId === item.id && <div className="menu-edit-scrim" onClick={() => setEditingMenuItemId(null)}><section className="menu-edit-modal" role="dialog" aria-modal="true" aria-labelledby="menu-edit-title" onClick={(event) => event.stopPropagation()}><header><div><span className="section-kicker">MENU ITEM</span><h2 id="menu-edit-title">Edit {item.name}</h2></div><button type="button" aria-label="Close edit form" onClick={() => setEditingMenuItemId(null)}>×</button></header><MenuItemEditForm item={item} categories={categories} saving={props.menuMutationPending} onCancel={() => setEditingMenuItemId(null)} onSave={props.onUpdateItem} /></section></div>}{canManage && (removeConfirmId === item.id ? <div className="menu-remove-confirm" role="group" aria-label={`Confirm removing ${item.name}`}><span>Remove <b>{item.name}</b>? Orders stay in history.</span><button type="button" className="menu-remove-cancel" disabled={props.menuMutationPending} onClick={() => setRemoveConfirmId(null)}>Cancel</button><button type="button" className="menu-remove-confirm-button" disabled={props.menuMutationPending} onClick={() => { void props.onRemoveItem(item).then((removed) => { if (removed) setRemoveConfirmId(null); }); }}>{props.menuMutationPending ? "Removing…" : "Confirm remove"}</button></div> : <button type="button" className="menu-remove-trigger" disabled={props.menuMutationPending} aria-label={`Remove ${item.name} from menu`} onClick={() => setRemoveConfirmId(item.id)} title={`Remove ${item.name}`}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2m2 0-.7 10H6.7L6 6m2.5 2.5v5m3-5v5"/></svg></button>)}</div>)}{!items.length && <p className="panel-empty">No menu items yet.</p>}</section><div className="owner-form-stack"><section className="owner-panel form-panel"><span className="section-kicker">ADD TO MENU</span><h2>New item</h2>{canManage ? <form className="owner-form" onSubmit={(event) => void props.onAddItem(event)}><label>Item name<input name="name" required maxLength={120} placeholder="e.g. Chicken burger"/></label><label>Category<select name="category_id" required defaultValue="">{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Description<textarea name="description" rows={2} placeholder="What should students know?"/></label><label>Price in PKR<input name="price" type="number" min="0" step="1" required placeholder="350"/></label><label>Optional add-on name<input name="addon_name" maxLength={80} placeholder="e.g. Fries, extra cheese, sauce"/></label><label>Add-on extra price (PKR)<input name="addon_price" type="number" min="0" step="1" placeholder="e.g. 150"/><small>Charged on top of the item price only when the student chooses it.</small></label><div className="check-row"><label><input type="checkbox" name="quick"/> Quick pickup</label><label><input type="checkbox" name="scheduled" defaultChecked/> Prepared order</label></div><label>Preparation time (minutes)<input name="prep_minutes" type="number" min="0" max="240" placeholder="Optional"/></label><label>Item image (optional)<input ref={itemImageInput} type="file" accept="image/*" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; const version = ++itemImageLoadVersion.current; setNewItemImageError(""); if (!file) { setNewItemImage(""); setNewItemImageLoading(false); return; } setNewItemImageLoading(true); void resizeMenuImage(file).then((image) => { if (version === itemImageLoadVersion.current) setNewItemImage(image); }).catch((error) => { if (version === itemImageLoadVersion.current) { setNewItemImageError(error instanceof Error ? error.message : "This image could not be loaded."); input.value = ""; } }).finally(() => { if (version === itemImageLoadVersion.current) setNewItemImageLoading(false); }); }}/><small>Choose a photo to display on the student menu. It will be resized automatically.</small></label>{newItemImageLoading && <p className="form-message" role="status">Preparing image…</p>}{newItemImage && <div className="item-image-preview"><img src={newItemImage} alt="Preview of the menu item"/><button type="button" onClick={() => { itemImageLoadVersion.current += 1; setNewItemImage(""); setNewItemImageLoading(false); if (itemImageInput.current) itemImageInput.current.value = ""; }}>Remove image</button></div>}<input type="hidden" name="image_data" value={newItemImage}/>{newItemImageError && <p className="form-message error-message" role="alert">{newItemImageError}</p>}{props.itemMessage && <p className="form-message">{props.itemMessage}</p>}<button className="blue-button" disabled={props.itemAddPending || props.menuMutationPending || newItemImageLoading}>{newItemImageLoading ? "Preparing image…" : props.itemAddPending ? "Adding…" : "Add menu item"}</button></form> : <p className="panel-empty">Only menu managers can add or edit menu items.</p>}</section><section className="owner-panel form-panel"><span className="section-kicker">ORGANISE MENU</span><h2>New category</h2>{canManage ? <form className="inline-category" onSubmit={(event) => { event.preventDefault(); props.onAddCategory(event.currentTarget); }}><input name="category" required maxLength={80} placeholder="e.g. Hot drinks"/><button className="blue-button" disabled={props.menuMutationPending}>Add category</button></form> : <p className="panel-empty">Manager access required.</p>}<div className="category-manage-list"><span className="section-kicker">EXISTING CATEGORIES</span>{props.canSortMenu && <p className="menu-sort-help">Use the arrows to set the category sequence shown on the student menu and counter.</p>}{categories.map((category) => <div className="category-manage-row" key={category.id}>{props.canSortMenu && <CategorySortControls category={category} categories={categories} disabled={props.menuMutationPending} onMove={props.onReorderMenuCategories}/>}<div className="category-manage-copy"><b>{category.name}</b><small>{category.items.length} {category.items.length === 1 ? "menu item" : "menu items"}</small></div>{canManage && (removeCategoryConfirmId === category.id ? <div className="category-remove-confirm" role="group" aria-label={`Confirm removing ${category.name} category`}><span>{category.items.length ? `Move ${category.items.length} ${category.items.length === 1 ? "item" : "items"} before removing this category.` : "Remove this empty category?"}</span>{category.items.length > 0 && <label>Move items to<select aria-label={`Move ${category.name} items to`} value={removeCategoryTargetId ?? ""} onChange={(event) => setRemoveCategoryTargetId(Number(event.target.value) || null)}><option value="">Choose category</option>{categories.filter((target) => target.id !== category.id).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>}<button type="button" onClick={() => { setRemoveCategoryConfirmId(null); setRemoveCategoryTargetId(null); }} disabled={props.menuMutationPending}>Cancel</button><button type="button" className="confirm" disabled={props.menuMutationPending || (category.items.length > 0 && removeCategoryTargetId == null)} onClick={() => { void props.onRemoveCategory(category, category.items.length > 0 ? removeCategoryTargetId ?? undefined : undefined).then((removed) => { if (removed) { setRemoveCategoryConfirmId(null); setRemoveCategoryTargetId(null); } }); }}>{props.menuMutationPending ? "Saving…" : "Remove"}</button></div> : <button type="button" className="category-remove-trigger" disabled={props.menuMutationPending || categories.length <= 1} aria-label={`Remove ${category.name} category`} title={categories.length <= 1 ? "At least one category must remain" : "Remove category"} onClick={() => { setRemoveCategoryConfirmId(category.id); setRemoveCategoryTargetId(categories.find((target) => target.id !== category.id)?.id ?? null); }}>Remove</button>)}{categories.length <= 1 && <small className="category-remove-hint">Keep at least one category.</small>}</div>)}</div></section></div></div><p className="sample-reminder">Menu items and prices are shared with the student ordering page and counter.</p></section>}
      {tab === "Deals" && <section className="owner-content"><div className="owner-columns"><section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">PROMOTIONS</span><h2>Featured deals</h2></div></div>{deals.map((deal) => <div className="deal-admin-row" key={deal.id}><span className="deal-admin-icon">✦</span><span><b>{deal.title}</b><small>{deal.description}</small></span><button className={deal.active ? "deal-switch enabled" : "deal-switch"} onClick={() => props.onDealToggle(deal.id)}>{deal.active ? "Shown" : "Hidden"}</button></div>)}</section><section className="owner-panel form-panel"><span className="section-kicker">CREATE A PROMOTION</span><h2>New deal</h2><p className="sample-reminder">Choose the menu items to include. Prices stay at their listed amounts.</p>{canManage ? <form className="owner-form" onSubmit={props.onDeal}><label>Deal title<input name="title" required maxLength={80} placeholder="e.g. Break-time bundle"/></label><label>Short description<textarea name="description" required rows={3} maxLength={220} placeholder="What’s included?"/></label><fieldset className="deal-item-picker"><legend>Items in this deal</legend>{props.items.filter((item) => item.available).map((item) => <label key={item.id}><input type="checkbox" name="item_ids" value={item.id}/><span>{item.name}</span><small>{item.quick_allowed ? "Quick" : "Scheduled"} · {item.price_display}</small></label>)}</fieldset>{props.dealMessage && <p className="form-message">{props.dealMessage}</p>}<button className="blue-button">Add offer</button></form> : <p className="panel-empty">Manager access required.</p>}</section></div></section>}
      {tab === "Wallet top-ups" && props.canTopUp && <section className="owner-content"><div className="owner-columns"><section className="owner-panel form-panel"><span className="section-kicker">CASH RECEIVED AT COUNTER</span><h2>Credit a student wallet</h2><p className="sample-reminder">Accept the cash first, then enter the student ID and amount. {user?.role === "DEMO_CANTEEN" ? "Credits are saved to the shared wallet ledger with your staff account and time." : "Each credit is saved to the shared wallet ledger with your staff account and time."}</p><form className="owner-form" onSubmit={(event) => { event.preventDefault(); void props.onCashTopUp(event.currentTarget); }}><label>7-digit student ID<input name="student_id" inputMode="numeric" pattern="[0-9]{7}" minLength={7} maxLength={7} required placeholder="Enter Cedar student ID"/></label><label>Cash received (PKR)<input name="amount" type="number" min="50" max="5000" step="1" required placeholder="e.g. 500"/></label><label>Note (optional)<input name="note" maxLength={160} placeholder="Cash received at counter"/></label>{props.walletMessage && <p className="form-message" role="status">{props.walletMessage}</p>}<button className="blue-button" disabled={props.walletPending}>{props.walletPending ? "Recording…" : "Record cash and top up"}</button></form></section><section className="owner-panel"><span className="section-kicker">HOW THIS CREDIT WORKS</span><h2>Recorded to one student</h2><p>{user?.role === "DEMO_CANTEEN" ? "The seven-digit ID matches the student account. The credit appears in the student wallet after sign-in." : "The seven-digit ID is matched to the student’s Cedar email account. The credit appears in their wallet activity and balance after they sign in. The server records the staff account, amount, and timestamp."}</p><p className="sample-reminder">Use this only after cash has actually been received. Credits are permanent ledger entries; corrections should be handled through an audited adjustment process.</p></section></div></section>}
      {tab === "Wallet top-up history" && props.canTopUp && <section className="owner-content"><div className="panel-heading"><div><span className="section-kicker">WALLET LEDGER</span><h2>Wallet top-up history</h2></div><button onClick={props.onLoadWalletTopUpHistory} disabled={props.walletHistoryLoading}>{props.walletHistoryLoading ? "Loading…" : "↻ Refresh history"}</button></div>{props.walletHistoryError ? <div className="panel-empty large" role="alert"><b>History could not be loaded.</b><p>{props.walletHistoryError}</p><button className="blue-button" onClick={props.onLoadWalletTopUpHistory} disabled={props.walletHistoryLoading}>Try again</button></div> : props.walletHistoryLoading ? <div className="panel-empty large" role="status">Loading recorded wallet top-ups…</div> : props.walletTopUpHistory.length ? <div className="queue-list">{props.walletTopUpHistory.map((entry) => <article className="queue-item history-item" key={entry.id}><div className="queue-number">ID {entry.student_id}<small>Student account</small></div><div className="queue-details"><div><b>{entry.label || "Wallet top-up"}</b><small>{new Date(entry.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} · {entry.method ? human(entry.method) : "Cash at counter"} · {entry.recorded_by || "cashier"}</small><small>{(entry.status === "PAYMENT_NOT_RECEIVED" || entry.recorded_by === "student dashboard") ? "Payment not received" : entry.status === "REFUNDED" ? "Wallet refund issued" : "Cash recorded"}</small></div></div><div className="queue-amount">+{money(entry.amount_paisa)}</div></article>)}</div> : <div className="panel-empty large">No wallet top-ups have been recorded yet.</div>}<p className="sample-reminder">Online transfers are not verified by CedarBite. Do not treat a selected provider as confirmation that funds were received.</p></section>}
      {tab === "Staff passwords" && props.station === "order_manager" && <section className="owner-content"><div className="owner-columns"><section className="owner-panel form-panel"><span className="section-kicker">STAFF ACCESS</span><h2>Reset a station password</h2><p>Set a new password for Counter, Cash desk, or Kitchen monitor. Only an order manager can do this. The staff member will need to sign in again on their device with the new password.</p><ResetStationPasswordForm onReset={props.onResetPassword}/></section><section className="owner-panel"><span className="section-kicker">YOUR ACCOUNT</span><h2>Change the order manager password</h2><p>Use the “Change password” control at the top of this page while signed in. If you have forgotten the manager password, update <code>CANTEEN_DASHBOARD_PASSWORD</code> in Netlify, then sign in again.</p></section></div></section>}
      </>}
      {receiptRequest && <ReceiptPrintView order={receiptRequest.order}/>}
    </div></div>;
}

function PickupLookup({ queue, pendingIds, onConfirm }: { queue: Order[]; pendingIds: string[]; onConfirm: (order: Order) => void }) {
  const [value, setValue] = useState("");
  const [searched, setSearched] = useState("");
  const match = searched ? queue.find((order) => order.pickup_code.toUpperCase() === searched) : undefined;
  return <section className="pickup-lookup"><div><span className="section-kicker">COLLECTION CHECK</span><h3>Enter pickup ID</h3><p>Find the matching order before handing it over.</p></div><form onSubmit={(event) => { event.preventDefault(); setSearched(value.trim().toUpperCase()); }}><label htmlFor="pickup-id">Pickup ID</label><div><input id="pickup-id" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Enter the number shown to the student" required/><button className="blue-button" type="submit">Find order</button></div></form>{searched && (match ? <div className="pickup-match" role="status"><b>Order {match.pickup_code} · {human(match.status)}</b><span>{orderCustomerLabel(match)}</span><span>{match.items.map((item) => `${item.quantity} × ${item.name}`).join(" · ")}</span>{match.status === "READY" ? <button className="blue-button" disabled={pendingIds.includes(String(match.id))} onClick={() => onConfirm(match)}>{pendingIds.includes(String(match.id)) ? "Confirming…" : "Confirm pickup"}</button> : <small>Pickup can be confirmed after the order is marked ready.</small>}</div> : <p className="pickup-not-found" role="status">No active order matches pickup ID {searched}. Refresh the queue and check the number.</p>)}</section>;
}

function StationDirectory({ onNavigate, onBack }: { onNavigate: (page: Page) => void; onBack: () => void }) {
  const stations: { title: string; path: Page; description: string; icon: string }[] = [
    { title: "Counter", path: "counter", description: "Place in-person orders for students and send them into the shared queue.", icon: "01" },
    { title: "Cash desk", path: "cashdesk", description: "Record wallet cash top-ups and cash received for pay-at-pickup orders.", icon: "02" },
    { title: "Order manager", path: "order-manager", description: "Accept orders, manage preparation progress, menu availability, and order history.", icon: "03" },
    { title: "Kitchen monitor", path: "kitchen", description: "Show only orders that the order manager has marked as preparing.", icon: "04" },
  ];
  return <main className="stations-page"><button className="back-to-store" onClick={onBack}>← Student menu</button><span className="section-kicker">CEDARBITE STAFF</span><h1>Choose your station.</h1><p>Each station has its own sign-in and only the tools needed for that role.</p><div className="station-cards">{stations.map((station) => <button className="station-card" key={station.path} onClick={() => onNavigate(station.path)}><span>{station.icon}</span><h2>{station.title}</h2><p>{station.description}</p><b>Open station <i>↗</i></b></button>)}</div></main>;
}

function ChangePasswordForm({ station, onChange }: { station: string; onChange: (password: string) => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  if (station === "order_manager") return <details className="staff-password-panel"><summary>Change password</summary><p>Update <code>CANTEEN_DASHBOARD_PASSWORD</code> in Netlify environment variables, then redeploy. This keeps the manager account’s recovery path available.</p></details>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const password = String(data.get("new_password") ?? "");
    if (password !== String(data.get("confirm_password") ?? "")) { setMessage("The new passwords do not match."); return; }
    setSaving(true); setMessage("");
    try { await onChange(password); form.reset(); setMessage("Password changed. Use the new password next time you sign in."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Password could not be changed."); }
    finally { setSaving(false); }
  }
  return <details className="staff-password-panel"><summary>Change password</summary><form className="owner-form" onSubmit={(event) => void submit(event)}><label>New password<input name="new_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label><label>Confirm new password<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label>{message && <p className="form-message" role="status">{message}</p>}<button className="blue-button" disabled={saving}>{saving ? "Saving…" : "Save new password"}</button></form></details>;
}

function ResetStationPasswordForm({ onReset }: { onReset: (station: string, password: string) => Promise<void> }) {
  const [message, setMessage] = useState(""); const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const station = String(data.get("station") ?? ""); const password = String(data.get("new_password") ?? "");
    if (password !== String(data.get("confirm_password") ?? "")) { setMessage("The new passwords do not match."); return; }
    setSaving(true); setMessage("");
    try { await onReset(station, password); form.reset(); setMessage("Password reset. Give the new password directly to that station’s staff member."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Password could not be reset."); }
    finally { setSaving(false); }
  }
  return <form className="owner-form" onSubmit={(event) => void submit(event)}><label>Staff station<select name="station" required defaultValue="order_taker"><option value="order_taker">Counter</option><option value="cashier">Cash desk</option><option value="kitchen">Kitchen monitor</option></select></label><label>New password<input name="new_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label><label>Confirm new password<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label>{message && <p className="form-message" role="status">{message}</p>}<button className="blue-button" disabled={saving}>{saving ? "Resetting…" : "Reset station password"}</button></form>;
}

function StationSwitchPrompt({ activeStation, activeUser, targetStation, onSignOut, onReturn }: { activeStation: string | null; activeUser: User | null; targetStation: string; onSignOut: () => void; onReturn: () => void }) {
  const activeName = stationName(activeStation, activeUser);
  return <div className="station-switch-scrim"><section className="station-switch-dialog" role="dialog" aria-modal="true" aria-labelledby="station-switch-title"><div className="station-switch-icon" aria-hidden="true">↔</div><span className="section-kicker">ACCOUNT ALREADY SIGNED IN</span><h2 id="station-switch-title">Sign out before switching?</h2><p>This browser is signed in to <b>{activeName}</b>. Sign out before entering credentials for <b>{stationName(targetStation)}</b> to avoid a session conflict.</p><button className="blue-button" onClick={onSignOut}>Sign out and continue</button><button className="station-switch-return" onClick={onReturn}>Return to {activeName}</button></section></div>;
}

function CounterStation({ user, categories, items, windows, pending, darkMode, onToggleTheme, onSignIn, onSignOut, onReturnToActive, onChangePassword, onCreate }: { user: User | null; categories: Category[]; items: Item[]; windows: PickupWindow[]; pending: boolean; darkMode: boolean; onToggleTheme: () => void; onSignIn: (username: string, password: string) => Promise<void>; onSignOut: () => void; onReturnToActive: () => void; onChangePassword: (password: string) => Promise<void>; onCreate: (customer: { customer_type: "STUDENT" | "TEACHER"; student_id: string | null; customer_name: string | null }, quantities: Record<number, number>, addonSelections: Record<number, boolean>, mode: "QUICK" | "SCHEDULED", windowId: string) => Promise<Order> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [addonSelections, setAddonSelections] = useState<Record<number, boolean>>({});
  const [customerType, setCustomerType] = useState<"STUDENT" | "TEACHER">("STUDENT");
  const [mode, setMode] = useState<"QUICK" | "SCHEDULED">("QUICK");
  const [windowId, setWindowId] = useState("");
  const [pickupId, setPickupId] = useState("");
  const [success, setSuccess] = useState("");
  const [receiptRequest, setReceiptRequest] = useState<{ order: Order; key: string } | null>(null);
  useAutoPrintReceipt(receiptRequest);
  const stationUser = user?.role === "DEMO_CANTEEN" && sessionStorage.getItem(CANTEEN_ROLE_KEY) === "order_taker";
  const activeStation = sessionStorage.getItem(CANTEEN_ROLE_KEY);
  const stationConflict = Boolean((activeStation && activeStation !== "order_taker") || (user && (user.role !== "DEMO_CANTEEN" || activeStation !== "order_taker")));
  const visibleCategories = categories.map((category) => ({ ...category, items: category.items.filter((item) => item.available && (mode === "QUICK" ? item.quick_allowed : item.scheduled_allowed)) })).filter((category) => category.items.length > 0);
  function chooseMode(nextMode: "QUICK" | "SCHEDULED") {
    setMode(nextMode);
    if (nextMode === "QUICK") setWindowId("");
    setQuantities((current) => Object.fromEntries(Object.entries(current).filter(([id]) => {
      const item = items.find((entry) => entry.id === Number(id));
      return item && (nextMode === "QUICK" ? item.quick_allowed : item.scheduled_allowed);
    })));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSuccess("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const studentId = String(form.get("student_id") ?? "").trim();
    const teacherName = String(form.get("teacher_name") ?? "").trim();
    if (customerType === "STUDENT" && !/^\d{7}$/.test(studentId)) { setError("Enter the student’s 7-digit Cedar ID."); return; }
    if (customerType === "TEACHER" && (!teacherName || teacherName.length > 100)) { setError("Enter the teacher’s name (up to 100 characters)."); return; }
    const selected = items.filter((item) => quantities[item.id] > 0);
    if (selected.some((item) => mode === "QUICK" ? !item.quick_allowed : !item.scheduled_allowed)) { setError("Some selected items require the other order mode. Review the highlighted menu items."); return; }
    const customer = { customer_type: customerType, student_id: customerType === "STUDENT" ? studentId : null, customer_name: customerType === "TEACHER" ? teacherName : null };
    try { const order = await onCreate(customer, quantities, addonSelections, mode, windowId); setPickupId(order.pickup_code); setSuccess("In-person order sent to the canteen queue."); setReceiptRequest({ order, key: crypto.randomUUID() }); setQuantities({}); setAddonSelections({}); setWindowId(""); formElement.reset(); setCustomerType("STUDENT"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The order could not be placed."); }
  }
  return <><main className="stations-page station-workspace"><div className="station-topline"><a href="/stations">← All staff stations</a><div className="station-top-actions">{stationUser && <ChangePasswordForm station="order_taker" onChange={onChangePassword}/>}{stationUser && <button onClick={onSignOut}>Sign out</button>}<button type="button" className="theme-toggle station-theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${darkMode ? "light" : "dark"} mode`} title={darkMode ? "Switch to light mode" : "Switch to dark mode"}><span aria-hidden="true">{darkMode ? "☀" : "☾"}</span></button></div></div><span className="section-kicker">COUNTER · IN-PERSON ORDERS</span><h1>Counter station</h1>{stationConflict ? <StationSwitchPrompt activeStation={activeStation} activeUser={user} targetStation="order_taker" onSignOut={onSignOut} onReturn={onReturnToActive}/> : !stationUser ? <form className="owner-lock station-login" onSubmit={(event) => { event.preventDefault(); setError(""); void onSignIn(username, password).catch((reason) => setError(reason instanceof Error ? reason.message : "Sign-in failed.")); }}><h2>Staff sign-in</h2><label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} required placeholder="counter" autoComplete="username"/></label><label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} required type="password" autoComplete="current-password"/></label>{error && <p className="form-message error-message">{error}</p>}<button className="blue-button">Open counter</button><p className="password-help">Forgot your password? Ask the order manager to reset the counter password.</p></form> : <><form className="counter-order-form" onSubmit={(event) => void submit(event)}><label>Order placed for<select name="customer_type" value={customerType} onChange={(event) => setCustomerType(event.target.value as "STUDENT" | "TEACHER")}><option value="STUDENT">Student</option><option value="TEACHER">Teacher</option></select></label>{customerType === "STUDENT" ? <label>Student ID<input name="student_id" required inputMode="numeric" pattern="[0-9]{7}" minLength={7} maxLength={7} placeholder="7-digit Cedar student ID"/></label> : <label>Teacher name<input name="teacher_name" required maxLength={100} autoComplete="name" placeholder="Enter the teacher’s name"/></label>}<div className="counter-mode"><button type="button" className={mode === "QUICK" ? "selected" : ""} onClick={() => chooseMode("QUICK")}>Quick Order</button><button type="button" className={mode === "SCHEDULED" ? "selected" : ""} onClick={() => chooseMode("SCHEDULED")}>Scheduled Order</button></div>{mode === "SCHEDULED" && <label>Pickup window<select value={windowId} onChange={(event) => setWindowId(event.target.value)} required><option value="">Choose an available 10-minute slot</option>{windows.slice(0, 6).map((slot) => <option value={String(slot.id)} key={slot.id}>{new Date(slot.start_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" })}–{new Date(slot.end_at).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" })}</option>)}</select></label>}<div className="counter-items-heading"><div><h2>Choose items</h2><p>Select the items the student or teacher is ordering.</p></div><span>{Object.values(quantities).reduce((sum, count) => sum + count, 0)} selected</span></div><div className="counter-category-list">{visibleCategories.map((category) => <section className="counter-menu-category" key={category.id}><h3>{category.name}</h3><div className="counter-item-list">{category.items.map((item) => <article className={`counter-item-card ${(quantities[item.id] ?? 0) > 0 ? "is-selected" : ""}`} key={item.id}><div className="counter-item-picture"><MenuItemVisual item={item} className="counter-item-visual"/><span className="counter-item-mode">{item.quick_allowed && item.scheduled_allowed ? "QUICK + SCHEDULED" : item.quick_allowed ? "QUICK ONLY" : "SCHEDULED ONLY"}</span></div><div className="counter-item-card-info"><div><b>{item.name}</b><strong>{item.price_display}</strong></div><small>{item.description || (item.prep_minutes ? `Ready in about ${item.prep_minutes} minutes` : "Cedar canteen menu item")}</small>{item.addon_name && <label className="counter-addon-option"><input type="checkbox" checked={addonSelections[item.id] ?? false} onChange={(event) => setAddonSelections((current) => ({ ...current, [item.id]: event.target.checked }))}/> Add {item.addon_name} · +{money(item.addon_price_paisa ?? 0)}</label>}<div className="counter-quantity-control"><button type="button" disabled={(quantities[item.id] ?? 0) <= 0} onClick={() => setQuantities((current) => ({ ...current, [item.id]: Math.max(0, (current[item.id] ?? 0) - 1) }))} aria-label={`Remove one ${item.name}`}>−</button><input type="number" min="0" max="20" disabled={!(mode === "QUICK" ? item.quick_allowed : item.scheduled_allowed)} value={quantities[item.id] ?? 0} onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: Math.min(20, Math.max(0, Number(event.target.value))) }))} aria-label={`Quantity for ${item.name}`}/><button type="button" disabled={(quantities[item.id] ?? 0) >= 20 || !(mode === "QUICK" ? item.quick_allowed : item.scheduled_allowed)} onClick={() => setQuantities((current) => ({ ...current, [item.id]: Math.min(20, (current[item.id] ?? 0) + 1) }))} aria-label={`Add one ${item.name}`}>+</button></div></div></article>)}</div></section>)}</div><div className="counter-total"><span>Order total</span><strong>{money(items.reduce((sum, item) => sum + (item.price_paisa + (addonSelections[item.id] && item.addon_name ? item.addon_price_paisa ?? 0 : 0)) * (quantities[item.id] ?? 0), 0))}</strong></div>{error && <p className="form-message error-message" role="alert">{error}</p>}{success && <div className="counter-order-success" role="status"><b>{success}</b><span>Pickup number: <strong>{pickupId}</strong></span><small>Payment due in cash at pickup.</small></div>}<button className="blue-button" disabled={pending}>{pending ? "Sending order…" : "Place in-person order"}</button></form></>}</main>{receiptRequest && <ReceiptPrintView order={receiptRequest.order}/>}</>;
}

function KitchenStation({ user, queue, pendingIds, darkMode, onToggleTheme, onSignIn, onSignOut, onReturnToActive, onChangePassword }: { user: User | null; queue: Order[]; pendingIds: string[]; darkMode: boolean; onToggleTheme: () => void; onSignIn: (username: string, password: string) => Promise<void>; onSignOut: () => void; onReturnToActive: () => void; onChangePassword: (password: string) => Promise<void> }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  const stationUser = user?.role === "DEMO_CANTEEN" && sessionStorage.getItem(CANTEEN_ROLE_KEY) === "kitchen";
  const activeStation = sessionStorage.getItem(CANTEEN_ROLE_KEY);
  const stationConflict = Boolean((activeStation && activeStation !== "kitchen") || (user && (user.role !== "DEMO_CANTEEN" || activeStation !== "kitchen")));
  return <main className="kitchen-screen"><header><div><a className="kitchen-back-link" href="/stations">← All staff stations</a><span className="section-kicker">CEDARBITE · KITCHEN</span><h1>Preparing now</h1><p>Only orders in the Preparing stage appear here.</p></div><div className="station-top-actions">{stationUser && <ChangePasswordForm station="kitchen" onChange={onChangePassword}/>}{stationUser && <button onClick={onSignOut}>Sign out</button>}<button type="button" className="theme-toggle station-theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${darkMode ? "light" : "dark"} mode`} title={darkMode ? "Switch to light mode" : "Switch to dark mode"}><span aria-hidden="true">{darkMode ? "☀" : "☾"}</span></button></div></header>{stationConflict ? <StationSwitchPrompt activeStation={activeStation} activeUser={user} targetStation="kitchen" onSignOut={onSignOut} onReturn={onReturnToActive}/> : !stationUser ? <form className="owner-lock station-login" onSubmit={(event) => { event.preventDefault(); setError(""); void onSignIn(username, password).catch((reason) => setError(reason instanceof Error ? reason.message : "Sign-in failed.")); }}><h2>Kitchen monitor sign-in</h2><label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} required placeholder="kitchenmonitor" autoComplete="username"/></label><label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} required type="password" autoComplete="current-password"/></label>{error && <p className="form-message error-message">{error}</p>}<button className="blue-button">Open kitchen monitor</button><p className="password-help">Forgot your password? Ask the order manager to reset the kitchen password.</p></form> : <>{queue.length ? <div className="kitchen-ticket-grid">{queue.filter((order) => order.status === "PREPARING").map((order) => <article className="kitchen-ticket" key={order.id}><span>PREPARING</span><h2>{order.pickup_code}</h2><small>{order.mode === "SCHEDULED" && order.pickup_window ? new Date(order.pickup_window.start_at).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" }) : "Quick pickup"}</small><ul>{order.items.map((item, index) => <li key={`${item.name}-${index}`}><b>{item.quantity}×</b> {item.name}</li>)}</ul>{pendingIds.includes(String(order.id)) && <small>Updating…</small>}</article>)}</div> : <div className="kitchen-empty">No orders are being prepared right now.</div>}</>}</main>;
}

function AvailabilitySwitch({ item, disabled, onToggle }: { item: Item; disabled: boolean; onToggle: (item: Item) => void }) { return <button type="button" className={`availability-switch ${item.available ? "is-on" : "is-off"}`} disabled={disabled} onClick={() => onToggle(item)} aria-pressed={item.available} aria-label={`${disabled ? "Saving availability for" : item.available ? "Mark unavailable" : "Mark available"}: ${item.name}`} title={disabled ? "Saving availability…" : item.available ? "Click to mark unavailable" : "Click to mark available"}><span aria-hidden="true">{disabled ? "…" : item.available ? "✓" : "×"}</span><small>{disabled ? "Saving…" : item.available ? "Available · click to pause" : "Unavailable · click to enable"}</small></button>; }
function CategorySortControls({ category, categories, disabled, onMove }: { category: Category; categories: Category[]; disabled: boolean; onMove: (sourceId: number, targetId: number) => void }) {
  const index = categories.findIndex((entry) => entry.id === category.id);
  return <div className="menu-sort-arrows category-sort-arrows" aria-label={`Reorder ${category.name} category`}><button type="button" disabled={disabled || index <= 0} onClick={() => onMove(category.id, categories[index - 1].id)} aria-label={`Move ${category.name} category up`} title="Move category up">↑</button><button type="button" disabled={disabled || index < 0 || index >= categories.length - 1} onClick={() => onMove(category.id, categories[index + 1]?.id)} aria-label={`Move ${category.name} category down`} title="Move category down">↓</button></div>;
}
function MenuSortHandle({ item, items, disabled, onMove }: { item: Item; items: Item[]; disabled: boolean; onMove: (sourceId: number, targetId: number) => void }) {
  const index = items.findIndex((entry) => entry.id === item.id);
  return <div className="menu-sort-controls" aria-label={`Reorder ${item.name}`}>
    <button type="button" className="menu-drag-handle" draggable={!disabled} disabled={disabled} aria-label={`Drag ${item.name} to reorder`} title="Drag to reorder" onDragStart={(event) => { event.dataTransfer.setData("text/plain", String(item.id)); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={(event) => { event.currentTarget.blur(); }}>⠿</button>
    <span className="menu-sort-arrows"><button type="button" disabled={disabled || index <= 0} onClick={() => onMove(item.id, items[index - 1].id)} aria-label={`Move ${item.name} up`} title="Move up">↑</button><button type="button" disabled={disabled || index < 0 || index >= items.length - 1} onClick={() => onMove(item.id, items[index + 1]?.id)} aria-label={`Move ${item.name} down`} title="Move down">↓</button></span>
  </div>;
}
function QueueItem({ order, onAdvance, onDelete, pending = false }: { order: Order; onAdvance: (order: Order) => void; onDelete?: (order: Order) => void; pending?: boolean }) {
  const next: Record<string, string> = { SUBMITTED: "Accept order", ACCEPTED: "Mark order ready", PREPARING: "Mark order ready", READY: "Mark collected" };
  return <article className="queue-item"><div className="queue-number" aria-label={`Pickup number ${order.pickup_code}`}>{order.pickup_code}<small>Pickup number</small></div><div className="queue-details"><div><b>{human(order.status)}</b><small>{order.mode === "QUICK" ? "Quick pickup" : order.pickup_window ? `Pickup ${new Date(order.pickup_window.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Scheduled"} · {order.waiting_minutes ?? 0} min</small><small className="queue-student-id">{orderCustomerLabel(order)}</small></div><p>{order.items.map((line, index) => <span key={`${line.name}-${index}`}>{line.quantity} × {line.name}</span>)}</p></div><div className="queue-amount">{order.total_display}</div><div className="queue-actions">{next[order.status] && <button type="button" className="blue-button queue-action" disabled={pending} onClick={() => onAdvance(order)}>{pending ? "Saving…" : `${next[order.status]} →`}</button>}{onDelete && order.status === "SUBMITTED" && <button type="button" className="queue-delete-button" disabled={pending} onClick={() => onDelete(order)} aria-label={`Delete new order ${order.pickup_code}`} title="Delete accidental order"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2m2 0-.7 10H6.7L6 6m2.5 2.5v5m3-5v5"/></svg></button>}</div></article>;
}
