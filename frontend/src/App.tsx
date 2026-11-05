import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { availablePickupWindows as filterPickupWindows, formatPickupTime, samplePickupWindows, type PickupWindow } from "./pickupWindows";

type User = { email: string; role: string; email_verified: boolean; student_id: string | null; permissions: string[]; csrf_token: string };
type Item = { id: number; category_id: number; name: string; description: string; price_paisa: number; price_display: string; available: boolean; quick_allowed: boolean; scheduled_allowed: boolean; prep_minutes: number | null };
type Category = { id: number; name: string; items: Item[] };
type Order = { id: string | number; status: string; mode: string; total_display?: string; pickup_code: string; created_at: string; pickup_window?: { start_at: string; end_at: string } | null; items: { item_id?: number; name: string; quantity: number }[]; waiting_minutes?: number; student_id?: string | null };
type Deal = { id: string; title: string; description: string; active: boolean; item_ids?: number[] };
type Page = "menu" | "orders" | "owner" | "about" | "privacy" | "contact" | "team" | "confirmation";
type OrderMode = "quick" | "scheduled";
type WalletEntry = { id: string | number; label: string; amount: number; kind: "credit" | "debit"; created_at: string; method: string };

function pageForPath(path: string): Page {
  if (path.startsWith("/owner")) return "owner";
  if (path.startsWith("/my-orders")) return "orders";
  if (path === "/order-confirmation") return "confirmation";
  if (path === "/about") return "about";
  if (path === "/privacy-policy") return "privacy";
  if (path === "/contact-us") return "contact";
  if (path === "/team") return "team";
  return "menu";
}

const money = (paisa: number) => `Rs ${(paisa / 100).toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const human = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (x) => x.toUpperCase());
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
const DEMO_ORDERS_KEY = "cedarbite-demo-orders";
const CANTEEN_SESSION_KEY = "cedarbite-canteen-session";
const SHARED_DATA_URL = "/.netlify/functions/shared-data";
const walletKey = (email: string) => `cedarbite-demo-wallet:${email}`;
function CedarMark() {
  return <svg className="cedar-mark" viewBox="0 0 64 64" role="img" aria-label="CedarBite logo mark"><path d="M9 25C15 14 24 9 32 8v13C24 22 18 26 14 33z" fill="#ffc928"/><path d="M55 25C49 14 40 9 32 8v13c8 1 14 5 18 12z" fill="#102b4c"/><path d="M12 36h40v5H12z" fill="#102b4c"/><path d="M19 34a13 13 0 0 1 26 0z" fill="#102b4c"/><path d="M20 44v11h5V44m7 0v11h5V44m7 0v11h5V44" fill="#ffc928"/><circle cx="49" cy="49" r="9" fill="#fff" stroke="#102b4c" strokeWidth="3"/><path d="m45 49 3 3 5-6" fill="none" stroke="#ffc928" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [csrf, setCsrf] = useState("");
  const [canteenPassword, setCanteenPassword] = useState(() => sessionStorage.getItem(CANTEEN_SESSION_KEY) || "");
  const [categories, setCategories] = useState<Category[]>([]);
  const [demoMenuReady, setDemoMenuReady] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderConfirmation, setOrderConfirmation] = useState<Order | null>(() => {
    try { const saved = JSON.parse(localStorage.getItem(DEMO_ORDERS_KEY) || "[]") as Order[]; return Array.isArray(saved) ? saved[0] ?? null : null; }
    catch { return null; }
  });
  const [queue, setQueue] = useState<Order[]>([]);
  const [queuePendingIds, setQueuePendingIds] = useState<string[]>([]);
  const queueLoadInFlightRef = useRef(false);
  const queueRefreshRequestedRef = useRef(false);
  const queueRevisionRef = useRef(0);
  const queueRefreshRef = useRef<() => void>(() => {});
  const queueMutationPendingRef = useRef(new Set<string>());
  const [availabilityPending, setAvailabilityPending] = useState<number[]>([]);
  const availabilityPendingRef = useRef(new Set<number>());
  const availabilityVersionRef = useRef(new Map<number, number>());
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
  const [walletMessage, setWalletMessage] = useState("");
  const [cashTopUpPending, setCashTopUpPending] = useState(false);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [toast, setToast] = useState("");
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
    if (canteenPassword && path.startsWith(SHARED_DATA_URL)) headers.set("X-Canteen-Password", canteenPassword);
    const response = await fetch(path, { ...init, headers, credentials: "include" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
    return body as T;
  }, [canteenPassword, csrf]);

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
    const versionsAtRequest = new Map(availabilityVersionRef.current);
    const pendingAtRequest = new Set(availabilityPendingRef.current);
    try {
      const result = await request<{ availability: Record<string, boolean> }>(`${SHARED_DATA_URL}?scope=availability`);
      setCategories((current) => current.map((category) => ({ ...category, items: category.items.map((item) => {
        const id = item.id;
        if (pendingAtRequest.has(id) || availabilityPendingRef.current.has(id) || (availabilityVersionRef.current.get(id) ?? 0) !== (versionsAtRequest.get(id) ?? 0)) return item;
        return { ...item, available: result.availability[String(id)] ?? item.available };
      }) })));
    } catch { /* The static menu remains usable if shared availability is temporarily unavailable. */ }
  }, [request]);

  const loadMenu = useCallback(async (manage = false) => {
    if (user?.role.startsWith("DEMO_")) {
      try {
        const shared = await request<{ categories: Category[] | null }>(`${SHARED_DATA_URL}?scope=menu`, { cache: "no-store" });
        if (shared.categories?.length) {
          setCategories(shared.categories);
          localStorage.setItem("cedarbite-demo-menu", JSON.stringify(shared.categories));
          setMenuError("");
          void loadSharedAvailability();
          return;
        }
      } catch { /* Continue with the saved or built-in menu if shared storage is unavailable. */ }
      const saved = localStorage.getItem("cedarbite-demo-menu");
      if (saved) { try { setCategories(JSON.parse(saved) as Category[]); setMenuError(""); void loadSharedAvailability(); } catch { localStorage.removeItem("cedarbite-demo-menu"); } return; }
      if (user.role === "DEMO_CANTEEN") { void loadSharedAvailability(); return; }
    }
    try { const result = await request<{ categories: Category[] }>(manage ? "/api/menu/manage" : "/api/menu"); setCategories(result.categories); setMenuError(""); void loadSharedAvailability(); }
    catch { setCategories(sampleMenu); setMenuError(""); void loadSharedAvailability(); }
  }, [loadSharedAvailability, request, user]);
  const loadQueue = useCallback(async () => {
    if (queueLoadInFlightRef.current) { queueRefreshRequestedRef.current = true; return; }
    queueLoadInFlightRef.current = true;
    const revision = queueRevisionRef.current;
    try {
      const path = user?.role === "DEMO_CANTEEN" ? `${SHARED_DATA_URL}?scope=queue` : "/api/queue";
      const result = await request<{ orders: Order[] }>(path, { cache: "no-store" });
      if (revision === queueRevisionRef.current) setQueue(result.orders);
    } catch (error) { if (page === "owner") setToast(error instanceof Error ? error.message : "Queue unavailable."); }
    finally {
      queueLoadInFlightRef.current = false;
      if (queueRefreshRequestedRef.current) {
        queueRefreshRequestedRef.current = false;
        queueRefreshRef.current();
      }
    }
  }, [page, request, user]);
  queueRefreshRef.current = () => { void loadQueue(); };
  const loadOrders = useCallback(async () => {
    try { const result = await request<{ orders: Order[] }>("/api/orders"); setOrders(result.orders); }
    catch (error) { setToast(error instanceof Error ? error.message : "Orders unavailable."); }
  }, [request]);
  const loadWallet = useCallback(async () => {
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
    try { setOrders(JSON.parse(localStorage.getItem(DEMO_ORDERS_KEY) || "[]") as Order[]); } catch { setOrders([]); }
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
    if (user?.role === "DEMO_CANTEEN") { void loadQueue(); void loadSharedAvailability(); return; }
    if (user?.role === "DEMO_STUDENT") { try { setOrders(JSON.parse(localStorage.getItem(DEMO_ORDERS_KEY) || "[]") as Order[]); } catch { setOrders([]); } return; }
    if (user?.permissions.includes("queue.view")) void loadQueue();
    if (user?.permissions.includes("orders.view_own")) void loadOrders();
    if (user?.role === "student" || user?.role === "staff_customer") void loadWallet();
    if (user?.permissions.includes("menu.manage") || user?.permissions.includes("availability.toggle")) void loadMenu(true);
  }, [user, page, loadMenu, loadOrders, loadQueue, loadWallet]);
  useEffect(() => { localStorage.setItem("cedarbite-preview-deals", JSON.stringify(deals)); }, [deals]);
  useEffect(() => { if (user?.role === "DEMO_CANTEEN") { const saved = localStorage.getItem("cedarbite-demo-menu"); if (saved) try { setCategories(JSON.parse(saved) as Category[]); } catch { localStorage.removeItem("cedarbite-demo-menu"); } setDemoMenuReady(true); } else { setDemoMenuReady(false); if (user?.role === "DEMO_STUDENT") { try { const saved = JSON.parse(localStorage.getItem(walletKey(user.email)) || "null"); setWalletBalance(saved?.balance ?? 0); setWalletEntries(saved?.entries ?? []); } catch { setWalletBalance(0); setWalletEntries([]); } } } }, [user]);
  useEffect(() => { if (user?.role === "DEMO_CANTEEN" && demoMenuReady && categories.length) localStorage.setItem("cedarbite-demo-menu", JSON.stringify(categories)); }, [categories, user, demoMenuReady]);
  useEffect(() => {
    if (page !== "owner" || user?.role !== "DEMO_CANTEEN") return;
    const refreshQueue = () => { if (!document.hidden) void loadQueue(); };
    const timer = window.setInterval(refreshQueue, 2_000);
    window.addEventListener("focus", refreshQueue);
    document.addEventListener("visibilitychange", refreshQueue);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshQueue); document.removeEventListener("visibilitychange", refreshQueue); };
  }, [loadQueue, page, user?.role]);
  useEffect(() => {
    if (page !== "menu" && page !== "owner") return;
    void loadSharedAvailability();
    const timer = window.setInterval(() => {
      if (user?.role === "DEMO_STUDENT") void loadMenu();
      else void loadSharedAvailability();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadMenu, loadSharedAvailability, page, user?.role]);

  const canManage = user?.permissions.includes("menu.manage") ?? false;
  const canToggle = user?.permissions.includes("availability.toggle") ?? false;
  const canQueue = user?.permissions.includes("queue.view") ?? false;
  const canSeeOrders = user?.permissions.includes("orders.view_own") ?? false;
  const items = useMemo(() => categories.flatMap((category) => category.items.map((item) => ({ ...item, category: category.name }))), [categories]);
  const modeCategories = categories.map((category) => ({ ...category, items: category.items.filter((item) => orderMode === "quick" ? item.quick_allowed : item.scheduled_allowed) }));
  const shownCategories = (categoryFilter === "All" ? modeCategories : modeCategories.filter((category) => category.name === categoryFilter)).filter((category) => category.items.length > 0);
  const cartCount = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
  const cartTotal = Object.entries(cart).reduce((sum, [id, quantity]) => sum + (items.find((item) => item.id === Number(id))?.price_paisa ?? 0) * quantity, 0);

  function navigate(next: Page) {
    setPage(next);
    if (next === "menu") setDealsActive(false);
    setMobileMenuOpen(false);
    const url = next === "owner" ? "/owner" : next === "orders" ? "/my-orders" : next === "confirmation" ? "/order-confirmation" : next === "about" ? "/about" : next === "privacy" ? "/privacy-policy" : next === "contact" ? "/contact-us" : next === "team" ? "/team" : "/";
    window.history.pushState({}, "", url);
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    localStorage.setItem(DEMO_USER_KEY, JSON.stringify(demoUser)); setUser(demoUser); setCsrf(demoUser.csrf_token); loginDialog.current?.close(); if (role === "DEMO_STUDENT") { try { const saved = JSON.parse(localStorage.getItem(walletKey(email)) || "null"); setWalletBalance(saved?.balance ?? 0); setWalletEntries(saved?.entries ?? []); } catch { setWalletBalance(0); setWalletEntries([]); } setToast(""); } else setToast("Canteen workspace opened.");
  }
  async function demoStaffSignIn(username: string, password: string) {
    try {
      const response = await fetch(SHARED_DATA_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "login", username: username.trim(), password }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Sign in failed (${response.status}).`);
    } catch (error) { throw new Error(error instanceof Error ? error.message : "Canteen sign-in could not be verified."); }
    const demoUser: User = { email: "demo-canteen@local", role: "DEMO_CANTEEN", email_verified: true, student_id: null, permissions: ["orders.view_own", "queue.view", "menu.manage", "availability.toggle"], csrf_token: "demo-local" };
    sessionStorage.setItem(CANTEEN_SESSION_KEY, password); setCanteenPassword(password); localStorage.setItem(DEMO_USER_KEY, JSON.stringify(demoUser)); setUser(demoUser); setCsrf(demoUser.csrf_token); setToast("Canteen workspace opened.");
  }
  async function signOut() { if (user?.role.startsWith("DEMO_")) { localStorage.removeItem(DEMO_USER_KEY); if (user.role === "DEMO_CANTEEN") { sessionStorage.removeItem(CANTEEN_SESSION_KEY); setCanteenPassword(""); setQueue([]); } setUser(null); setCsrf(""); setToast("You are signed out."); return; } try { await request("/api/auth/logout", { method: "POST" }); setUser(null); setCsrf(""); setToast("You are signed out."); } catch (error) { setToast(error instanceof Error ? error.message : "Sign out failed."); } }
  async function cashWalletTopUp(form: HTMLFormElement) {
    const data = new FormData(form);
    const student_id = String(data.get("student_id") ?? "").trim();
    const amount = Number(data.get("amount"));
    const note = String(data.get("note") ?? "").trim();
    if (!/^\d{7}$/.test(student_id)) { setWalletMessage("Enter the student’s 7-digit Cedar ID."); return; }
    if (!Number.isFinite(amount) || amount < 50 || amount > 5000) { setWalletMessage("Enter a cash amount from Rs 50 to Rs 5,000."); return; }
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
  function addToCart(id: number, amount = 1) { setCart((current) => { const next = { ...current, [id]: Math.max(0, (current[id] ?? 0) + amount) }; if (!next[id]) delete next[id]; return next; }); }
  function saveWallet(balance: number, entries: WalletEntry[]) { if (user?.email) localStorage.setItem(walletKey(user.email), JSON.stringify({ balance, entries })); setWalletBalance(balance); setWalletEntries(entries); }
  function demoTopUp() {
    const amount = Math.round(Number(topUpAmount) * 100);
    if (user?.role !== "DEMO_STUDENT") { setToast("Sign in with your Cedar email to use the wallet."); return; }
    if (!Number.isFinite(amount) || amount < 10000 || amount > 500000) { setToast("Choose a top-up amount between Rs 100 and Rs 5,000."); return; }
    const entry: WalletEntry = { id: crypto.randomUUID(), label: "Wallet top-up (practice)", amount, kind: "credit", created_at: new Date().toISOString(), method: `${topUpMethod}  · practice` };
    saveWallet(walletBalance + amount, [entry, ...walletEntries]); setWalletOpen(false); setToast(`Wallet practice credit added ${money(amount)} using ${topUpMethod} practice credit.`);
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
    if (paymentMethod === "wallet" && walletBalance < cartTotal) { setToast("Your wallet balance is too low. Add practice credit to continue."); setWalletOpen(true); return; }
    orderSubmittingRef.current = true;
    setOrderSubmitting(true);
    setOrderError("");
    setToast("");
    const entry = paymentMethod === "wallet" ? { id: crypto.randomUUID(), label: "Order payment (practice)", amount: cartTotal, kind: "debit" as const, created_at: new Date().toISOString(), method: "CedarBite practice wallet" } : null;
    let pickupCode = "";
    do { pickupCode = `CB${crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`; } while (orders.some((existing) => existing.pickup_code === pickupCode));
    const order: Order = { id: crypto.randomUUID(), status: "SUBMITTED", mode: orderMode === "quick" ? "QUICK" : "SCHEDULED", student_id: user.student_id, total_display: money(cartTotal), pickup_code: pickupCode, created_at: new Date().toISOString(), pickup_window: selectedPickupWindow ? { start_at: selectedPickupWindow.start_at, end_at: selectedPickupWindow.end_at } : null, items: Object.entries(cart).flatMap(([id, quantity]) => { const item = items.find((candidate) => candidate.id === Number(id)); return item ? [{ item_id: item.id, name: item.name.replace("[DEV SAMPLE] ", ""), quantity }] : []; }), waiting_minutes: 0 };
    try {
      const result = await request<{ order?: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "create-order", order }) });
      const confirmedOrder = result.order;
      if (!confirmedOrder?.pickup_code) throw new Error("The canteen did not confirm this order. Your bucket is still here; check My Orders before trying again.");
      if (entry) saveWallet(walletBalance - cartTotal, [entry, ...walletEntries]);
      const nextOrders = [confirmedOrder, ...orders.filter((existing) => existing.id !== confirmedOrder.id)];
      localStorage.setItem(DEMO_ORDERS_KEY, JSON.stringify(nextOrders));
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
    setCart((current) => Object.fromEntries(Object.entries(current).filter(([id]) => {
      const item = items.find((entry) => entry.id === Number(id));
      return item && (nextMode === "quick" ? item.quick_allowed : item.scheduled_allowed);
    })));
    setSelectedWindow("");
  }

  async function toggleAvailability(item: Item) {
    if (user?.role === "DEMO_CANTEEN") {
      if (availabilityPendingRef.current.has(item.id)) return;
      const available = !item.available;
      availabilityPendingRef.current.add(item.id);
      availabilityVersionRef.current.set(item.id, (availabilityVersionRef.current.get(item.id) ?? 0) + 1);
      setAvailabilityPending((current) => [...current, item.id]);
      setCategories((current) => current.map((category) => ({ ...category, items: category.items.map((entry) => entry.id === item.id ? { ...entry, available } : entry) })));
      try {
        const result = await request<{ item_id: number; available: boolean }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-availability", item_id: item.id, available }) });
        setCategories((current) => current.map((category) => ({ ...category, items: category.items.map((entry) => entry.id === result.item_id ? { ...entry, available: result.available } : entry) })));
        setToast(`${item.name} marked ${available ? "available" : "unavailable"} for everyone.`);
      } catch (error) {
        setCategories((current) => current.map((category) => ({ ...category, items: category.items.map((entry) => entry.id === item.id ? { ...entry, available: item.available } : entry) })));
        setToast(error instanceof Error ? error.message : "Availability could not be saved. The previous setting was restored.");
      } finally {
        availabilityPendingRef.current.delete(item.id);
        setAvailabilityPending((current) => current.filter((id) => id !== item.id));
        void loadSharedAvailability();
      }
      return;
    }
    try { await request(`/api/menu/items/${item.id}/availability`, { method: "PATCH", body: JSON.stringify({ is_available: !item.available }) }); await loadMenu(true); setToast(`${item.name} is now ${item.available ? "unavailable" : "available"}.`); }
    catch (error) { setToast(error instanceof Error ? error.message : "Could not update availability."); }
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
  async function saveDemoMenu(nextCategories: Category[]) {
    const result = await request<{ categories: Category[] }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-menu", categories: nextCategories }) });
    setCategories(result.categories);
    localStorage.setItem("cedarbite-demo-menu", JSON.stringify(result.categories));
    return result.categories;
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
  async function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    if (user?.role === "DEMO_CANTEEN") {
      const category_id = Number(data.get("category_id"));
      const name = String(data.get("name") ?? "").trim();
      const description = String(data.get("description") ?? "").trim();
      const price = Number(data.get("price"));
      const quick_allowed = data.get("quick") === "on";
      const scheduled_allowed = data.get("scheduled") === "on";
      if (!categories.some((category) => category.id === category_id)) { setItemMessage("Choose a valid menu category."); return; }
      if (!name || !Number.isFinite(price) || price < 0 || (!quick_allowed && !scheduled_allowed)) { setItemMessage("Enter a name and valid price, then choose at least one pickup type."); return; }
      let id = -Date.now();
      while (items.some((item) => item.id === id)) id -= 1;
      const price_paisa = Math.round(price * 100);
      const prepValue = String(data.get("prep_minutes") ?? "").trim();
      const newItem: Item = { id, category_id, name, description, price_paisa, price_display: money(price_paisa), available: true, quick_allowed, scheduled_allowed, prep_minutes: prepValue ? Number(prepValue) : null };
      const next = categories.map((category) => category.id === category_id ? { ...category, items: [...category.items, newItem] } : category);
      setItemMessage("Saving to the shared menu…");
      try { await saveDemoMenu(next); form.reset(); setItemMessage(`${name} is now on the shared menu.`); }
      catch (error) { setItemMessage(error instanceof Error ? error.message : "Item was not added. Try again."); }
      return;
    }
    try {
      await request("/api/menu/items", { method: "POST", body: JSON.stringify({ category_id: Number(data.get("category_id")), name: String(data.get("name")), description: String(data.get("description")), price_paisa: Math.round(Number(data.get("price")) * 100), quick_allowed: data.get("quick") === "on", scheduled_allowed: data.get("scheduled") === "on", prep_minutes: Number(data.get("prep_minutes")) || null }) });
      await loadMenu(true); form.reset(); setItemMessage("Added to the canteen menu.");
    } catch (error) { setItemMessage(error instanceof Error ? error.message : "Item was not added."); }
  }
  async function advanceOrder(order: Order) {
    const next: Record<string, string> = { SUBMITTED: "ACCEPTED", ACCEPTED: "PREPARING", PREPARING: "READY", READY: "COLLECTED" };
    if (!next[order.status]) return;
    if (user?.role === "DEMO_CANTEEN") {
      const orderId = String(order.id);
      if (queueMutationPendingRef.current.has(orderId)) return;
      queueMutationPendingRef.current.add(orderId);
      setQueuePendingIds((current) => [...current, orderId]);
      queueRevisionRef.current += 1;
      try {
        const result = await request<{ order: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-status", order_id: orderId, status: next[order.status] }) });
        queueRevisionRef.current += 1;
        setQueue((current) => result.order.status === "COLLECTED" ? current.filter((entry) => String(entry.id) !== orderId) : [result.order, ...current.filter((entry) => String(entry.id) !== orderId)]);
        setToast(`Order ${order.pickup_code} updated.`);
      } catch (error) {
        queueRevisionRef.current += 1;
        setToast(error instanceof Error ? error.message : "Order status was not changed.");
      } finally {
        queueMutationPendingRef.current.delete(orderId);
        setQueuePendingIds((current) => current.filter((id) => id !== orderId));
        void loadQueue();
      }
      return;
    }
    try { await request(`/api/orders/${order.id}/status`, { method: "POST", body: JSON.stringify({ to: next[order.status] }) }); await loadQueue(); setToast(`Order ${order.pickup_code} updated.`); }
    catch (error) { setToast(error instanceof Error ? error.message : "Order status was not changed."); }
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
    const currentItems = items.filter((item) => (cart[item.id] ?? 0) > 0);
    if (currentItems.some((item) => targetMode === "quick" ? !item.quick_allowed : !item.scheduled_allowed)) { setToast("Your bucket has items for a different pickup style. Remove them before adding this deal."); return; }
    setOrderMode(targetMode);
    setCart((current) => ({ ...current, ...Object.fromEntries(dealItems.map((item) => [item.id, (current[item.id] ?? 0) + 1])) }));
    setSelectedDeal(null); setCartOpen(true);
  }

  if (page === "owner") return <OwnerApp user={user} googleReady={googleReady} categories={categories} items={items} queue={queue} queuePendingIds={queuePendingIds} deals={deals} darkMode={darkMode} onToggleTheme={() => setDarkMode((dark) => !dark)} canManage={canManage} canToggle={canToggle} availabilityPending={availabilityPending} canQueue={canQueue} canTopUp={user?.role === "DEMO_CANTEEN" || (user?.permissions.includes("wallet.cash_topup") ?? false)} walletMessage={walletMessage} walletPending={cashTopUpPending} onCashTopUp={cashWalletTopUp} itemMessage={itemMessage} dealMessage={dealMessage} onSignIn={startSignIn} onDemoStaff={demoStaffSignIn} onSignOut={() => void signOut()} onBack={() => navigate("menu")} onToggle={toggleAvailability} onPrice={(item, form) => void changePrice(item, form)} onAddCategory={(form) => void addCategory(form)} onAddItem={(event) => void addItem(event)} onAdvance={(order) => void advanceOrder(order)} onToggleOrdering={() => void toggleOrdering()} onDeal={saveDeal} onDealToggle={(id) => setDeals((current) => current.map((deal) => deal.id === id ? { ...deal, active: !deal.active } : deal))} onRefresh={() => { void loadMenu(true); void loadQueue(); void loadWallet(); void loadSharedAvailability(); }} orderingReason={orderingReason} />;
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
      {selectedDeal && <div className="deal-modal-scrim" onClick={() => setSelectedDeal(null)}><section className="deal-modal" role="dialog" aria-modal="true" aria-labelledby="deal-modal-title" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setSelectedDeal(null); }}><button className="deal-modal-close" autoFocus onClick={() => setSelectedDeal(null)} aria-label="Close deal details">×</button><span className="section-kicker">FEATURED DEAL</span><h2 id="deal-modal-title">{selectedDeal.title}</h2><p>{selectedDeal.description}</p><div className="deal-modal-items">{dealItemsFor(selectedDeal).map((item) => <div key={item.id}><span>{item.name}</span><b>{item.price_display}</b></div>)}{!dealItemsFor(selectedDeal).length && <p>Items in this offer are currently unavailable.</p>}</div><small>Items are added at their listed menu prices.</small><button className="blue-button deal-add-button" disabled={!dealItemsFor(selectedDeal).length} onClick={() => addDealToBucket(selectedDeal)}>Add deal to bucket <span>→</span></button></section></div>}<section className="menu-area" id="menu"><div className="menu-intro"><div><span className="section-kicker">THE CANTEEN MENU</span><h2>Find your <span>favourite.</span></h2></div><div className="menu-live"><i className="live-dot"/> Menu availability from canteen service</div></div><div className="menu-layout"><nav className="category-sidebar" aria-label="Menu categories"><button className={categoryFilter === "All" ? "active" : ""} onClick={() => setCategoryFilter("All")}>All items</button>{categories.map((category) => <button className={categoryFilter === category.name ? "active" : ""} key={category.id} onClick={() => setCategoryFilter(category.name)}>{category.name}</button>)}</nav><div className="menu-results">{}
      {menuError ? <div className="empty-state error-state"><h2>Menu didn’t load</h2><p>{menuError}</p></div> : !items.length ? <div className="empty-state"><span>🍽️</span><h2>Menu being prepared</h2><p>Menu items will appear here when they are available.</p></div> : shownCategories.map((category) => <div className="menu-category" key={category.id}><div className="category-title"><h3>{category.name}</h3><span>{category.items.length} items</span></div><div className="food-grid">{category.items.map((item, index) => <FoodCard key={item.id} item={item} index={index} onAdd={() => { addToCart(item.id); setCartOpen(true); }} />)}</div></div>)}</div></div></section>
      <section className="how-it-works"><div><span className="section-kicker">TWO WAYS TO ORDER</span><h2>Made for <span>your day.</span></h2><p className="section-subcopy">Different food, different pickup. The canteen chooses which items and times it can support.</p></div><div className="ordering-modes"><article><span className="mode-icon">↗</span><div><small>01 · READY TO SELL</small><h3>Quick Order</h3><p>Choose a ready-made item, add it to your bucket, and move it through the canteen queue. No pickup slot is needed.</p></div></article><article><span className="mode-icon blue">◷</span><div><small>02 · MADE FRESH</small><h3>Scheduled Order</h3><p>For food that needs preparation, choose from pickup windows supported by the canteen.</p></div></article></div></section>      <section className="payment-note"><div><span className="section-kicker">CEDARBITE WALLET</span><h2>Top up. <span>Order. Enjoy.</span></h2><p>Top up your CedarBite wallet and choose a payment method at checkout. Practice credits are stored only in this browser; no money is transferred.</p><button className="blue-button" onClick={() => user?.role === "DEMO_STUDENT" ? setWalletOpen(true) : loginDialog.current?.showModal()}>Open wallet <span>→</span></button></div><div className="payment-pills"><span>EasyPaisa</span><span>JazzCash</span><span>Bank transfer</span><span>Card</span><span>Cash at pickup</span></div></section>
    </main>}
    <footer className="store-footer"><div className="footer-main"><div><button className="wordmark footer-mark" onClick={() => navigate("menu")}><CedarMark/><span>Cedar<span>Bite</span></span></button><p>Queue · Order · Enjoy<br/>A Cedar College portfolio project in discovery.</p></div><div><b>Explore</b><button onClick={() => navigate("menu")}>Menu</button><button onClick={() => { navigate("menu"); setDealsActive(true); setTimeout(() => document.getElementById("deals")?.scrollIntoView({ behavior:"smooth" }),0); }}>Deals</button><button onClick={() => navigate("about")}>About us</button><button onClick={() => navigate("owner")}>Canteen dashboard</button></div><div><b>Help & information</b><button onClick={() => navigate("contact")}>Contact us</button><button onClick={() => navigate("privacy")}>Privacy policy</button></div><div><b>Team behind CedarBite</b><button className="team-footer-link" onClick={() => navigate("team")}>Meet the team <span aria-hidden="true">↗</span></button></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} CedarBite. All rights reserved.</span></div></footer>
    {cartOpen && <div className="cart-scrim" onClick={() => setCartOpen(false)}><aside className="cart-drawer" onClick={(event) => event.stopPropagation()} aria-label="Your bucket"><div className="cart-head"><div><span className="section-kicker">YOUR ORDER</span><h2>Your bucket <small>({cartCount})</small></h2></div><button onClick={() => setCartOpen(false)} aria-label="Close bucket">×</button></div><div className="cart-service"><b>Pickup</b><span>{orderMode === "quick" ? "Quick Order · no slot required" : "Scheduled Order · choose a slot"}</span></div>{orderMode === "scheduled" && <label className="bucket-window">Choose your pickup slot<select value={selectedWindow} onChange={(event) => setSelectedWindow(event.target.value)}><option value="">{availablePickupWindows.length ? "Choose from the next available pickup slots" : "No pickup slots are available right now"}</option>{availablePickupWindows.slice(0, 6).map((window) => <option key={window.id} value={window.id}>{new Date(window.start_at).toLocaleString("en-PK", { timeZone:"Asia/Karachi", weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" })} – {formatPickupTime(window.end_at)}</option>)}</select></label>}<div className="cart-lines">{Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => { const item = items.find((entry) => entry.id === Number(id)); if (!item) return null; return <div className="cart-line" key={id}><div><b>{item.name.replace("[DEV SAMPLE] ", "")}</b><small>{item.price_display} each</small></div><div className="quantity-controls"><button onClick={() => addToCart(item.id, -1)} aria-label={`Remove one ${item.name}`}>−</button><b>{quantity}</b><button onClick={() => addToCart(item.id, 1)} aria-label={`Add one ${item.name}`}>+</button></div><strong>{money(item.price_paisa * quantity)}</strong></div>; })}{!cartCount && <div className="cart-empty"><span>▣</span><h3>Your bucket is empty</h3><p>Add a menu item to start building your order.</p><button className="blue-button" onClick={() => { setCartOpen(false); document.getElementById("menu")?.scrollIntoView({behavior:"smooth"}); }}>Browse menu</button></div>}</div><div className="cart-bottom"><div className="cart-total"><span>Subtotal</span><b>{money(cartTotal)}</b></div><label className="demo-payment">Payment method<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="wallet">CedarBite wallet · {money(walletBalance)}</option><option value="easypaisa">EasyPaisa</option><option value="jazzcash">JazzCash</option><option value="bank">Bank transfer</option><option value="card">Card</option><option value="cash">Cash at pickup</option></select></label><p className="checkout-hint">Review your items and pickup details before placing the order.</p>{orderError && <p className="order-error" role="alert">{orderError}</p>}<button className="checkout-button" disabled={!cartCount || orderSubmitting || user?.role !== "DEMO_STUDENT" || (orderMode === "scheduled" && !selectedWindow)} onClick={placeDemoOrder}>{orderSubmitting ? "Sending order…" : user?.role === "DEMO_STUDENT" ? "Place demo order" : "Sign in to place an order"}</button>{user?.role !== "DEMO_STUDENT" && <button className="cart-signin" onClick={() => loginDialog.current?.showModal()}>Sign in with your Cedar email</button>}</div></aside></div>}
    <dialog className="signin-dialog" ref={loginDialog}><button className="dialog-x" onClick={() => loginDialog.current?.close()} aria-label="Close sign in">×</button><CedarMark/><span className="section-kicker">WELCOME TO CEDARBITE</span><h2>Sign in with your<br/><span>cedar email</span></h2><p>Use a Cedar College email to create a presentation profile saved in this browser. No password or Google credentials are requested.</p>{googleReady ? <button className="google-button" onClick={startSignIn}><GoogleIcon/> Sign in with Google account</button> : <form className="demo-signin-form" onSubmit={(event) => { event.preventDefault(); demoSignIn(demoEmail); }}><label>Cedar email<input type="email" required value={demoEmail} onChange={(event) => setDemoEmail(event.target.value)} placeholder="your.email@cedar.edu.pk"/></label><button className="google-button">Continue with Cedar email</button><small>Presentation sign-in · use a Cedar email</small></form>}<small className="secure-hint">Profile and practice wallet are saved in this browser only.</small></dialog>
    {walletOpen && <div className="wallet-scrim" onClick={() => setWalletOpen(false)}><section className="wallet-panel" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={(event) => event.stopPropagation()}><div className="cart-head"><div><span className="section-kicker">CEDARBITE WALLET</span><h2 id="wallet-title">Your wallet</h2></div><button onClick={() => setWalletOpen(false)} aria-label="Close wallet">×</button></div><div className="wallet-balance"><span>Available balance</span><b>{money(walletBalance)}</b><small>{user?.role === "DEMO_STUDENT" ? "Practice balance kept in this browser" : user?.role === "student" || user?.role === "staff_customer" ? "Shared account balance" : "Sign in with your Cedar account to view your wallet"}</small></div>{user?.role === "DEMO_STUDENT" ? <><label className="demo-payment">Top-up amount (PKR)<input type="number" min="100" max="5000" step="50" value={topUpAmount} onChange={(event) => setTopUpAmount(event.target.value)}/></label><label className="demo-payment">Top up using<select value={topUpMethod} onChange={(event) => setTopUpMethod(event.target.value)}><option value="easypaisa">EasyPaisa</option><option value="jazzcash">JazzCash</option><option value="bank">Bank transfer</option><option value="card">Card</option></select></label><p className="wallet-note">Practice credit only. No payment provider is contacted and no money is transferred.</p><button className="blue-button wallet-topup" onClick={demoTopUp}>Add practice credit</button></> : <p className="wallet-note">To add cash to this wallet, give the money to canteen staff and ask them to record it against your student ID.</p>}<h3>Recent wallet activity</h3>{walletEntries.length ? <div className="wallet-history">{walletEntries.slice(0,5).map((entry) => <div key={entry.id}><span><b>{entry.label}</b><small>{new Date(entry.created_at).toLocaleString()} · {entry.method}</small></span><strong className={entry.kind}>{entry.kind === "credit" ? "+" : "−"}{money(entry.amount)}</strong></div>)}</div> : <p className="wallet-empty">No wallet activity yet.</p>}</section></div>}
    {showOrderConfirmation && orderConfirmation && <div className="order-confirmation-scrim"><section className="order-confirmation" role="dialog" aria-modal="true" aria-labelledby="order-success-title" aria-describedby="order-success-description"><CedarMark/><div className="confirmation-check" aria-hidden="true">✓</div><span className="section-kicker">ORDER PLACED SUCCESSFULLY</span><h2 id="order-success-title">Your order is confirmed.</h2><p id="order-success-description">Show this pickup number to the canteen staff when you collect your order.</p><div className="confirmation-pickup"><small>PICKUP NUMBER</small><strong>{orderConfirmation.pickup_code}</strong></div><button className="blue-button" autoFocus onClick={() => { setShowOrderConfirmation(false); navigate("menu"); }}>Return to menu</button></section></div>}
    {toast && <div className="toast-message" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </div>;
}

function GoogleIcon() { return <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.25 5.48-4.73 7.18l7.35 5.7c4.29-3.96 7.42-9.8 7.42-17.35z"/><path fill="#FBBC05" d="M10.54 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a23.94 23.94 0 0 0 0 21.56l7.98-6.19z"/><path fill="#34A853" d="M24 48c6.47 0 11.9-2.13 15.86-6.1l-7.35-5.7c-2.04 1.38-4.65 2.2-8.51 2.2-6.26 0-11.57-4.22-13.46-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>; }

function TeamPage() {
  const members = [
    { name: "Eshwar Das", initials: "ED", role: "LEAD DEVELOPER", description: "Lead Developer for CedarBite, working with the team on the campus ordering experience." },
    { name: "Muhammad Eyad Imran", initials: "ME", role: "BACKEND DEVELOPER · SAMPLE ROLE", description: "Collaborating on the data and shared order experience for CedarBite." },
    { name: "Mudassir", initials: "M", role: "FRONTEND DEVELOPER · SAMPLE ROLE", description: "Helping shape the student and canteen interfaces as CedarBite develops." },
    { name: "Rayan", initials: "R", role: "PRODUCT & TESTING · SAMPLE ROLE", description: "Exploring the student and staff experience and helping review the ordering flow." },
  ];
  return <main className="team-page">
    <section className="team-hero"><span className="section-kicker">THE PEOPLE BEHIND THE PROJECT</span><h1>Four students.<br/><span>One shared idea.</span></h1><p>CedarBite is being shaped by a student team exploring a smoother way to order and collect food on campus.</p><div className="team-hero-orbit" aria-hidden="true"><span><CedarMark/></span><i/><b/></div></section>
    <section className="team-roster" aria-labelledby="team-roster-title"><div className="team-section-heading"><div><span className="section-kicker">MEET THE TEAM</span><h2 id="team-roster-title">Built together at Cedar.</h2></div><span className="team-count">04 <small>COLLABORATORS</small></span></div><div className="team-member-list">{members.map((member, index) => <article className="team-member-row" key={member.name} style={{ "--team-index": index } as React.CSSProperties}><div className="team-member-visual"><div className="team-member-orbit" aria-hidden="true"><i/></div><div className="team-member-avatar" role="img" aria-label={`${member.initials} initials portrait for ${member.name}`}><span>{member.initials}</span></div><span className="team-member-index">0{index + 1}</span></div><div className="team-member-copy"><span className="team-role">{member.role}</span><h3>{member.name}</h3><p>{member.description}</p></div><span className="team-row-arrow" aria-hidden="true">↗</span></article>)}</div></section>
  </main>;
}

function InfoPage({ page }: { page: "about" | "privacy" | "contact" }) {
  if (page === "about") return <main className="info-page"><span className="section-kicker">ABOUT CEDARBITE</span><h1>More time for your break.</h1><p className="info-lead">CedarBite is a student portfolio project exploring whether a clearer digital menu and ordering flow could make the Cedar College canteen experience easier.</p><div className="info-callout"><b>Built around a smoother break.</b><p>This student project explores a simpler menu, pickup, and wallet experience for Cedar College.</p></div><h2>Two ways to order</h2><p><b>Quick Order</b> is for ready-to-sell items, with a ready notification concept and no later pickup slot. <b>Scheduled Order</b> lets students choose a pickup window for items that need preparation. The canteen dashboard can edit sample prices and availability and move demo orders through the queue.</p><h2>Our approach</h2><p>The model is designed to help students, canteen staff, and college leaders discuss a practical ordering experience before decisions about a live service.</p></main>;
  if (page === "privacy") return <main className="info-page"><span className="section-kicker">PRIVACY INFORMATION</span><h1>Privacy policy</h1><div className="draft-banner">PRESENTATION VERSION · SAMPLE DATA</div><p className="info-lead">Pickup orders are shared with the canteen dashboard. Wallet balances and payment provider connections are not shared or live.</p><h2>Demo profile</h2><p>Demo sign-in accepts a Cedar College email address and creates a local profile. The email and derived numeric student ID are stored in this browser’s local storage for the demo. No password or Google credentials are requested.</p><h2>Orders and wallet</h2><p>Pickup orders, including student ID, item list, pickup code, and order time, are stored in CedarBite shared storage so the canteen dashboard can display them on another device. Only a manager who signs in with the configured canteen password can view the shared queue. Orders are retained until manually removed by the project operator. Student profiles and practice wallet credits remain in this browser. Do not use real student records or payment details until the college has approved the service and identity checks are configured.</p><h2>Payment details</h2><p>EasyPaisa, JazzCash, bank, and card are shown as payment-method examples. No provider is contacted and no funds are transferred. Cash is shown as a demo payment choice.</p><h2>Live service</h2><p>Before a real service is introduced, this page should be replaced with the college-approved privacy notice covering data handling, retention, contact, and payment providers.</p></main>;
  return <main className="info-page"><span className="section-kicker">CONTACT</span><h1>Talk to the CedarBite team.</h1><p className="info-lead">Use this page to present how students and canteen staff can find support information.</p><div className="info-callout"><b>Contact channel placeholder</b><p>Add the Cedar College or canteen contact details here when they are selected. No support requests are sent from this presentation model.</p></div><h2>For the presentation</h2><p>Try a sample Cedar email, place an order, and explore the wallet and canteen console. No live orders or payment transactions are created.</p></main>;
}

function FoodCard({ item, index, onAdd }: { item: Item; index: number; onAdd: () => void }) {
  const icon = /drink|water|juice|soda/i.test(item.name) ? "🥤" : /fries|chips/i.test(item.name) ? "🍟" : /rice|biryani/i.test(item.name) ? "🍛" : /wrap|roll/i.test(item.name) ? "🌯" : /cake|cookie|sweet/i.test(item.name) ? "🧁" : /sandwich|toast/i.test(item.name) ? "🥪" : /samosa/i.test(item.name) ? "🥟" : /burger/i.test(item.name) ? "🍔" : "🍽️";
  return <article className={`food-card ${!item.available ? "sold-out" : ""}`}><div className={`food-picture picture-${index % 4}`}><span className="food-emoji">{icon}</span><span className="food-tag">{item.quick_allowed ? "QUICK PICKUP" : "PREPARED FRESH"}</span></div><div className="food-info"><div className="food-name-price"><h4>{item.name.replace("[DEV SAMPLE] ", "")}</h4><b>{item.price_display}</b></div><p>{item.description || (item.prep_minutes ? `Made to order · about ${item.prep_minutes} minutes` : "A canteen favourite. Sample menu item.")}</p><div className="food-bottom"><span className={item.available ? "stock-yes" : "stock-no"}><i/> {item.available ? "Available" : "Sold out"}</span><button onClick={onAdd} disabled={!item.available} aria-label={`Add ${item.name} to basket`}>Add <span>+</span></button></div></div></article>;
}

function OrderCard({ order }: { order: Order }) { return <article className="order-row"><div className="order-row-top"><b>Pickup number: {order.pickup_code}</b><span className="order-status">{human(order.status)}</span><span className="order-date">{new Date(order.created_at).toLocaleString()}</span></div><p>{order.items.map((line, index) => <span key={`${line.name}-${index}`}>{line.quantity} × {line.name}</span>)}</p><div className="order-row-bottom"><span>{human(order.mode)}{order.pickup_window ? ` · ${new Date(order.pickup_window.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " · Quick pickup"}</span><b>{order.total_display}</b></div></article>; }

type OwnerProps = { user: User | null; googleReady: boolean; categories: Category[]; items: (Item & { category: string })[]; queue: Order[]; queuePendingIds: string[]; deals: Deal[]; darkMode: boolean; onToggleTheme: () => void; canManage: boolean; canToggle: boolean; availabilityPending: number[]; canQueue: boolean; canTopUp: boolean; walletMessage: string; walletPending: boolean; onCashTopUp: (form: HTMLFormElement) => void; itemMessage: string; dealMessage: string; orderingReason: string; onSignIn: () => void; onDemoStaff: (username: string, password: string) => Promise<void>; onSignOut: () => void; onBack: () => void; onToggle: (item: Item) => void; onPrice: (item: Item, form: HTMLFormElement) => void; onAddCategory: (form: HTMLFormElement) => void; onAddItem: (event: FormEvent<HTMLFormElement>) => void; onAdvance: (order: Order) => void; onToggleOrdering: () => void; onDeal: (event: FormEvent<HTMLFormElement>) => void; onDealToggle: (id: string) => void; onRefresh: () => void };
function OwnerApp(props: OwnerProps) {
  const [tab, setTab] = useState("Overview");
  const [demoUsername, setDemoUsername] = useState("");
  const [demoPassword, setDemoPassword] = useState("");
  const [demoLoginError, setDemoLoginError] = useState("");
  const { user, categories, items, queue, deals, canManage, canToggle, canQueue } = props;
  const waiting = queue.filter((order) => ["SUBMITTED", "ACCEPTED", "PREPARING"].includes(order.status)).length;
  return <div className="owner-app"><aside className="owner-sidebar"><button className="owner-logo" onClick={props.onBack}><CedarMark/><span>Cedar<span>Bite</span><small>CANTEEN CONSOLE</small></span></button><span className="sidebar-label">WORKSPACE</span>{["Overview", "Orders", "Menu", "Deals", ...(props.canTopUp ? ["Wallet top-ups"] : [])].map((name) => <button key={name} className={`sidebar-link ${tab === name ? "active" : ""}`} onClick={() => setTab(name)}><span>{({Overview:"⌂",Orders:"▤",Menu:"☷",Deals:"✦", "Wallet top-ups":"＋"} as Record<string,string>)[name]}</span>{name}{name === "Orders" && waiting > 0 && <i>{waiting}</i>}</button>)}<div className="sidebar-spacer"/><div className="service-state"><span className="state-dot"/> <span><b>Canteen service</b><small>{props.orderingReason}</small></span></div><button className="back-store" onClick={props.onBack}>← Back to student menu</button></aside>
    <div className="owner-main"><header className="owner-topbar"><div><span className="owner-crumb">CEDARBITE <span>/</span> CANTEEN</span><h1>{tab === "Overview" ? "Canteen overview" : tab === "Orders" ? "Order management" : tab === "Menu" ? "Menu management" : tab === "Wallet top-ups" ? "Student wallet top-ups" : "Deals & offers"}</h1></div><div className="owner-top-actions"><button className="refresh-link" onClick={props.onRefresh}>↻ Refresh</button>{user ? <button className="owner-user" onClick={props.onSignOut}><span>{user.email.slice(0,1).toUpperCase()}</span>{user.email} · Sign out</button> : <button className="sign-button" onClick={props.onSignIn}>Sign in</button>}<button className="theme-toggle owner-theme-toggle" onClick={props.onToggleTheme} aria-label={`Switch to ${props.darkMode ? "light" : "dark"} mode`} title={props.darkMode ? "Switch to light mode" : "Switch to dark mode"}><span aria-hidden="true">{props.darkMode ? "☀" : "☾"}</span></button></div></header>
    {!user ? <section className="owner-lock"><div className="lock-emblem"><CedarMark/></div><span className="section-kicker">CANTEEN DASHBOARD</span><h2>Welcome to the<br/><span>canteen console.</span></h2><p>Sign in with the canteen dashboard username and password to explore menu controls, deals, and order management.</p><form className="demo-signin-form" onSubmit={(event) => { event.preventDefault(); setDemoLoginError(""); void props.onDemoStaff(demoUsername, demoPassword).catch((error) => setDemoLoginError(error instanceof Error ? error.message : "Sign-in failed.")); }}><label>Username<input autoComplete="username" required value={demoUsername} onChange={(event) => setDemoUsername(event.target.value)} placeholder="manager"/></label><label>Password<input type="password" autoComplete="current-password" required value={demoPassword} onChange={(event) => setDemoPassword(event.target.value)} placeholder="••••••••"/></label>{demoLoginError && <p className="form-message error-message">{demoLoginError}</p>}<button className="blue-button">Log in to dashboard</button><small>Use the canteen credentials configured for this site. Shared orders and student IDs require a manager sign-in.</small></form><button className="back-to-store" onClick={props.onBack}>← Return to student menu</button></section> : !(canManage || canToggle || canQueue) ? <section className="owner-lock"><span className="section-kicker">STAFF WORKSPACE</span><h2>This account<br/><span>doesn’t have staff access.</span></h2><p>Use the separate canteen dashboard demo login to explore owner tools.</p><button className="blue-button" onClick={props.onSignOut}>Sign out and use canteen login</button><button className="back-to-store" onClick={props.onBack}>Return to student menu</button></section> : <>
      <div className="owner-banner"><div><b>Canteen workspace · shared queue and availability</b><span>Pickup orders, menu items, prices, and availability sync across devices. Deals remain local. Payments are not processed.</span></div><button onClick={props.onToggleOrdering}>{props.orderingReason.includes("paused") ? "Resume ordering" : "Pause ordering"}</button></div>
      {tab === "Overview" && <section className="owner-content"><div className="metric-grid"><article><span>ACTIVE MENU ITEMS</span><b>{items.length}</b><small>Across {categories.length} menu categories</small></article><article><span>ORDERS TO FULFIL</span><b>{waiting}</b><small>{canQueue ? "Needs canteen attention" : "Queue access is restricted"}</small></article><article><span>AVAILABLE ITEMS</span><b>{items.filter((item) => item.available).length}</b><small>{items.filter((item) => !item.available).length} currently unavailable</small></article></div><div className="owner-columns"><section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">LIVE WORK</span><h2>Current orders</h2></div><button onClick={() => setTab("Orders")}>View all →</button></div>{canQueue ? queue.slice(0,4).map((order) => <QueueItem key={order.id} order={order} pending={props.queuePendingIds.includes(String(order.id))} onAdvance={props.onAdvance}/> ) : <p className="panel-empty">Your account doesn’t have queue access.</p>}{canQueue && !queue.length && <p className="panel-empty">No active orders yet.</p>}</section><section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">MENU STATUS</span><h2>Availability</h2></div><button onClick={() => setTab("Menu")}>Manage menu →</button></div>{items.slice(0,5).map((item) => <div className="mini-menu-row" key={item.id}><span className="mini-food">{item.name.toLowerCase().includes("burger") ? "🍔" : item.name.toLowerCase().includes("drink") ? "🥤" : "🍽️"}</span><span><b>{item.name.replace("[DEV SAMPLE] ", "")}</b><small>{item.price_display}</small></span><AvailabilitySwitch item={item} disabled={!canToggle || props.availabilityPending.includes(item.id)} onToggle={props.onToggle}/></div>)}</section></div><div className="owner-tip"><b>Getting started</b><span>Use the menu tab to add items and manage prices. Menu items and prices are examples for this presentation and should be confirmed with the canteen before any live service.</span></div></section>}
      {tab === "Orders" && <section className="owner-content"><div className="panel-heading"><div><span className="section-kicker">KITCHEN QUEUE</span><h2>Orders in progress</h2></div><span className="queue-live"><i/> Live updates · checks every 2 seconds</span></div>{canQueue && <PickupLookup queue={queue} pendingIds={props.queuePendingIds} onConfirm={props.onAdvance}/>} {canQueue ? queue.length ? <div className="queue-list">{queue.map((order) => <QueueItem key={order.id} order={order} pending={props.queuePendingIds.includes(String(order.id))} onAdvance={props.onAdvance}/>)}</div> : <div className="panel-empty large">The queue is clear. Place an order from the student menu to see it appear here.</div> : <div className="panel-empty large">Queue access is not enabled for your account.</div>}</section>}
      {tab === "Menu" && <section className="owner-content"><div className="owner-columns"><section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">CATALOGUE</span><h2>Menu items</h2></div><span className="queue-live">{items.length} items</span></div>{items.map((item) => <div className="menu-admin-row" key={item.id}><div className="menu-admin-name"><span className="mini-food">{item.name.toLowerCase().includes("burger") ? "🍔" : item.name.toLowerCase().includes("drink") ? "🥤" : "🍽️"}</span><span><b>{item.name}</b><small>{item.category} · {item.quick_allowed ? "Quick pickup" : "Prepared"}</small></span></div><form className="price-edit" onSubmit={(event) => { event.preventDefault(); props.onPrice(item, event.currentTarget); }}><span>Rs</span><input aria-label={`Price for ${item.name}`} name="price" type="number" min="0" step="1" defaultValue={Math.round(item.price_paisa / 100)} disabled={!canManage}/><button disabled={!canManage}>Save</button></form><AvailabilitySwitch item={item} disabled={!canToggle || props.availabilityPending.includes(item.id)} onToggle={props.onToggle}/></div>)}{!items.length && <p className="panel-empty">No menu items yet.</p>}</section><div className="owner-form-stack"><section className="owner-panel form-panel"><span className="section-kicker">ADD TO MENU</span><h2>New item</h2>{canManage ? <form className="owner-form" onSubmit={(event) => void props.onAddItem(event)}><label>Item name<input name="name" required maxLength={120} placeholder="e.g. Chicken burger"/></label><label>Category<select name="category_id" required defaultValue="">{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Description<textarea name="description" rows={2} placeholder="What should students know?"/></label><label>Price in PKR<input name="price" type="number" min="0" step="1" required placeholder="350"/></label><div className="check-row"><label><input type="checkbox" name="quick"/> Quick pickup</label><label><input type="checkbox" name="scheduled" defaultChecked/> Prepared order</label></div><label>Preparation time (minutes)<input name="prep_minutes" type="number" min="0" max="240" placeholder="Optional"/></label>{props.itemMessage && <p className="form-message">{props.itemMessage}</p>}<button className="blue-button">Add menu item</button></form> : <p className="panel-empty">Only menu managers can add or edit menu items.</p>}</section><section className="owner-panel form-panel"><span className="section-kicker">ORGANISE MENU</span><h2>New category</h2>{canManage ? <form className="inline-category" onSubmit={(event) => { event.preventDefault(); props.onAddCategory(event.currentTarget); }}><input name="category" required maxLength={80} placeholder="e.g. Hot drinks"/><button className="blue-button">Add category</button></form> : <p className="panel-empty">Manager access required.</p>}</section></div></div><p className="sample-reminder">Menu names, ingredients, and prices shown here are examples. Replace them with the confirmed canteen list before live use.</p></section>}
      {tab === "Deals" && <section className="owner-content"><div className="owner-columns"><section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">PROMOTIONS</span><h2>Featured deals</h2></div></div>{deals.map((deal) => <div className="deal-admin-row" key={deal.id}><span className="deal-admin-icon">✦</span><span><b>{deal.title}</b><small>{deal.description}</small></span><button className={deal.active ? "deal-switch enabled" : "deal-switch"} onClick={() => props.onDealToggle(deal.id)}>{deal.active ? "Shown" : "Hidden"}</button></div>)}</section><section className="owner-panel form-panel"><span className="section-kicker">CREATE A PROMOTION</span><h2>New deal</h2><p className="sample-reminder">Choose the items students can add from this deal. Prices stay at the listed menu price.</p>{canManage ? <form className="owner-form" onSubmit={props.onDeal}><label>Deal title<input name="title" required maxLength={80} placeholder="e.g. Break-time bundle"/></label><label>Short description<textarea name="description" required rows={3} maxLength={220} placeholder="What’s included?"/></label><fieldset className="deal-item-picker"><legend>Items in this deal</legend>{props.items.filter((item) => item.available).map((item) => <label key={item.id}><input type="checkbox" name="item_ids" value={item.id}/><span>{item.name}</span><small>{item.quick_allowed ? "Quick" : "Scheduled"} · {item.price_display}</small></label>)}</fieldset>{props.dealMessage && <p className="form-message">{props.dealMessage}</p>}<button className="blue-button">Add offer</button></form> : <p className="panel-empty">Manager access required.</p>}</section></div></section>}
      {tab === "Wallet top-ups" && props.canTopUp && <section className="owner-content"><div className="owner-columns"><section className="owner-panel form-panel"><span className="section-kicker">CASH RECEIVED AT COUNTER</span><h2>Credit a student wallet</h2><p className="sample-reminder">Accept the cash first, then enter the student ID and amount. {user?.role === "DEMO_CANTEEN" ? "This presentation login saves the test credit in this browser only." : "Each credit is saved to the shared wallet ledger with your staff account and time."}</p><form className="owner-form" onSubmit={(event) => { event.preventDefault(); void props.onCashTopUp(event.currentTarget); }}><label>7-digit student ID<input name="student_id" inputMode="numeric" pattern="[0-9]{7}" minLength={7} maxLength={7} required placeholder="Enter Cedar student ID"/></label><label>Cash received (PKR)<input name="amount" type="number" min="50" max="5000" step="1" required placeholder="e.g. 500"/></label><label>Note (optional)<input name="note" maxLength={160} placeholder="Cash received at counter"/></label>{props.walletMessage && <p className="form-message" role="status">{props.walletMessage}</p>}<button className="blue-button" disabled={props.walletPending}>{props.walletPending ? "Recording…" : "Record cash and top up"}</button></form></section><section className="owner-panel"><span className="section-kicker">HOW THIS CREDIT WORKS</span><h2>Recorded to one student</h2><p>{user?.role === "DEMO_CANTEEN" ? "The seven-digit ID maps to the student's Cedar email. To view the test balance, sign in as that student in the same browser. This browser-only record does not sync to other devices." : "The seven-digit ID is matched to the student’s Cedar email account. The credit appears in their wallet activity and balance after they sign in. The server records the staff account, amount, and timestamp."}</p><p className="sample-reminder">Use this only after cash has actually been received. Credits are permanent ledger entries; corrections should be handled through an audited adjustment process.</p></section></div></section>}
      </>}
    </div></div>;
}

function PickupLookup({ queue, pendingIds, onConfirm }: { queue: Order[]; pendingIds: string[]; onConfirm: (order: Order) => void }) {
  const [value, setValue] = useState("");
  const [searched, setSearched] = useState("");
  const match = searched ? queue.find((order) => order.pickup_code.toUpperCase() === searched) : undefined;
  return <section className="pickup-lookup"><div><span className="section-kicker">COLLECTION CHECK</span><h3>Enter pickup ID</h3><p>Find the matching order before handing it over.</p></div><form onSubmit={(event) => { event.preventDefault(); setSearched(value.trim().toUpperCase()); }}><label htmlFor="pickup-id">Pickup ID</label><div><input id="pickup-id" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Enter the number shown to the student" required/><button className="blue-button" type="submit">Find order</button></div></form>{searched && (match ? <div className="pickup-match" role="status"><b>Order {match.pickup_code} · {human(match.status)}</b><span>Student ID: {match.student_id || "Not available"}</span><span>{match.items.map((item) => `${item.quantity} × ${item.name}`).join(" · ")}</span>{match.status === "READY" ? <button className="blue-button" disabled={pendingIds.includes(String(match.id))} onClick={() => onConfirm(match)}>{pendingIds.includes(String(match.id)) ? "Confirming…" : "Confirm pickup"}</button> : <small>Pickup can be confirmed after the order is marked ready.</small>}</div> : <p className="pickup-not-found" role="status">No active order matches pickup ID {searched}. Refresh the queue and check the number.</p>)}</section>;
}

function AvailabilitySwitch({ item, disabled, onToggle }: { item: Item; disabled: boolean; onToggle: (item: Item) => void }) { return <button type="button" className={`availability-switch ${item.available ? "is-on" : ""}`} disabled={disabled} onClick={() => onToggle(item)} aria-label={`${item.available ? "Mark unavailable" : "Mark available"}: ${item.name}`}><span/><small>{disabled ? "Saving…" : item.available ? "Available" : "Unavailable"}</small></button>; }
function QueueItem({ order, onAdvance, pending = false }: { order: Order; onAdvance: (order: Order) => void; pending?: boolean }) {
  const next: Record<string, string> = { SUBMITTED: "Accept order", ACCEPTED: "Start preparing", PREPARING: "Mark ready", READY: "Mark collected" };
  return <article className="queue-item"><div className="queue-number" aria-label={`Pickup number ${order.pickup_code}`}>{order.pickup_code}<small>Pickup number</small></div><div className="queue-details"><div><b>{human(order.status)}</b><small>{order.mode === "QUICK" ? "Quick pickup" : order.pickup_window ? `Pickup ${new Date(order.pickup_window.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Scheduled"} · {order.waiting_minutes ?? 0} min</small><small className="queue-student-id">Student ID: {order.student_id || "Not available"}</small></div><p>{order.items.map((line, index) => <span key={`${line.name}-${index}`}>{line.quantity} × {line.name}</span>)}</p></div><div className="queue-amount">{order.total_display}</div>{next[order.status] && <button type="button" className="blue-button queue-action" disabled={pending} onClick={() => onAdvance(order)}>{pending ? "Saving…" : `${next[order.status]} →`}</button>}</article>;
}
