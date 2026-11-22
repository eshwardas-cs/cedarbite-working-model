import { FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { availablePickupWindows as filterPickupWindows, formatPickupTime, samplePickupWindows, type PickupWindow } from "./pickupWindows";
import { OrderSubmissionUncertainError, submitOrderWithRecovery } from "./orderSubmission";
import { fetchMenuFromSupabase } from "./menuApi";
import { signInWithGoogle, signOutOfSupabase, takeSignInErrorFromUrl, userFromSession } from "./authApi";
import { supabase, supabaseConfigured } from "./supabaseClient";

type User = { email: string; role: string; email_verified: boolean; student_id: string | null; permissions: string[]; csrf_token: string; source?: "supabase"; full_name?: string | null };
type MenuOption = { id: string; name: string; available: boolean };
type Item = { id: number; category_id: number; name: string; description: string; price_paisa: number; price_display: string; available: boolean; quick_allowed: boolean; scheduled_allowed: boolean; prep_minutes: number | null; image_data?: string | null; addon_name?: string | null; addon_price_paisa?: number; options?: MenuOption[] };
type Category = { id: number; name: string; items: Item[] };
type MenuItemEditValues = Pick<Item, "category_id" | "name" | "description" | "price_paisa" | "quick_allowed" | "scheduled_allowed" | "prep_minutes" | "image_data" | "addon_name" | "addon_price_paisa" | "options">;
type Order = { id: string | number; status: string; mode: string; source?: string; total_paisa?: number; total_display?: string; deal_discount_paisa?: number; pickup_code: string; created_at: string; ready_at?: string; completed_at?: string; cancelled_at?: string; voided_at?: string; voided_by?: string; void_reason?: string; refunded_at?: string; refund_method?: string; refund_status?: string; refund_amount_paisa?: number; pickup_window?: { start_at: string; end_at: string } | null; items: { item_id?: number; option_id?: string; name: string; quantity: number; unit_price_paisa?: number }[]; waiting_minutes?: number; student_id?: string | null; customer_type?: "STUDENT" | "TEACHER" | "GUEST" | "NON_STUDENT"; customer_name?: string | null; payment_method?: string; payment_status?: string; deal_ids?: string[] };
type StudentLookup = { student_id: string; full_name: string | null; source: "profile" | "counter" | "missing"; profile_exists: boolean };
type HeroSlide = { id: string; kicker: string; title: string; highlight: string; description: string; image_data: string; active: boolean };
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
type Weekday = typeof WEEKDAYS[number];
const CANTEEN_OPEN_DAYS: ReadonlySet<Weekday> = new Set(["monday", "tuesday", "wednesday", "thursday"]);
type ItemOfDayEntry = { item: Item; days: Weekday[] };
type SalesSummary = { date: string; generated_at: string; orders_placed: number; placed_order_value_paisa: number; pending_payment_orders: number; paid_orders: number; paid_sales_paisa: number; units_sold: number; items_sold: { name: string; quantity: number }[]; payment_methods: { method: string; count: number; amount_paisa: number }[]; hourly_sales: { hour: number; amount_paisa: number }[] };
type MonthlySalesSummary = { month: string; generated_at: string; orders_placed: number; placed_order_value_paisa: number; pending_payment_orders: number; paid_orders: number; paid_sales_paisa: number; refunds: number; refunds_paisa: number; net_sales_paisa: number; units_sold: number; items_sold: { name: string; quantity: number }[]; payment_methods: { method: string; count: number; amount_paisa: number }[]; daily_breakdown: { date: string; orders_placed: number; paid_orders: number; paid_sales_paisa: number; units_sold: number; pending_payment_orders: number }[] };
type Page = "menu" | "orders" | "owner" | "developer" | "stations" | "counter" | "cashdesk" | "order-manager" | "kitchen" | "about" | "privacy" | "terms" | "contact" | "team" | "confirmation";
type OrderMode = "quick" | "scheduled";
type WalletEntry = { id: string | number; label: string; amount: number; kind: "credit" | "debit"; created_at: string; method: string };
type WalletTopUpHistoryEntry = { id: string; student_id: string; amount_paisa: number; kind?: "credit" | "debit"; label: string; created_at: string; recorded_by?: string; method?: string; status?: string };
type DeveloperExportPayload = { period: { from: string; to: string; timezone: string; generated_at: string }; orders: Record<string, unknown>[]; sales_by_day: SalesSummary[]; sales_by_month: MonthlySalesSummary[]; wallet_entries: Record<string, unknown>[]; menu_items: Record<string, unknown>[] };
class ApiResponseError extends Error {
  constructor(message: string, readonly status: number, readonly localServiceUnavailable = false) { super(message); this.name = "ApiResponseError"; }
}

const DEFAULT_COLD_DRINK_OPTIONS: MenuOption[] = [
  { id: "drink-pepsi", name: "Pepsi", available: true },
  { id: "drink-diet-pepsi", name: "Diet Pepsi", available: true },
  { id: "drink-7up", name: "7UP", available: true },
  { id: "drink-mirinda", name: "Mirinda", available: true },
];

const defaultHeroSlides: HeroSlide[] = [
  { id: "cedarbite-hero-1", kicker: "CEDAR COLLEGE · DHA CAMPUS", title: "Make your break", highlight: "count.", description: "Find a canteen favourite, add it to your bucket, and collect when it’s ready.", image_data: "/assets/hero-posters/cedarbite-break-poster.svg", active: true },
  { id: "cedarbite-hero-2", kicker: "FRESH FROM THE CANTEEN", title: "A good lunch", highlight: "starts here.", description: "Browse the menu and choose a pickup time for food that needs preparation.", image_data: "/assets/hero-posters/cedarbite-pickup-poster.svg", active: true },
  { id: "cedarbite-hero-3", kicker: "QUICK BITES · COLD DRINKS", title: "Find your", highlight: "favourite.", description: "See what’s on the menu today and make your next campus break easier.", image_data: "/assets/hero-posters/cedarbite-canteen-poster.svg", active: true },
];

const defaultHeroPosterById: Record<string, string> = {
  "cedarbite-hero-1": "/assets/hero-posters/cedarbite-break-poster.svg",
  "cedarbite-hero-2": "/assets/hero-posters/cedarbite-pickup-poster.svg",
  "cedarbite-hero-3": "/assets/hero-posters/cedarbite-canteen-poster.svg",
};

function replaceLegacyHeroPhotos(slides: HeroSlide[]) {
  return slides.map((slide) => {
    const poster = defaultHeroPosterById[slide.id];
    return poster && slide.image_data.startsWith("/assets/menu-images/")
      ? { ...slide, image_data: poster }
      : slide;
  });
}

function ensureColdDrinkOptions(categories: Category[]): Category[] {
  return categories.map((category) => ({
    ...category,
    items: category.items.map((item) => item.name.trim().toLocaleLowerCase() === "cold drink" && !item.options?.length
      ? { ...item, options: DEFAULT_COLD_DRINK_OPTIONS }
      : item),
  }));
}

function makeCartLineKey(itemId: number, optionId?: string, withAddon = false) {
  return `${itemId}${optionId ? `:option:${encodeURIComponent(optionId)}` : ""}${withAddon ? ":addon" : ""}`;
}
function readCartLineKey(key: string) {
  const [rawItemId, ...parts] = key.split(":");
  const optionIndex = parts.indexOf("option");
  const optionId = optionIndex >= 0 ? decodeURIComponent(parts[optionIndex + 1] ?? "") : undefined;
  return { itemId: Number(rawItemId), optionId, withAddon: parts.includes("addon") };
}
function readMenuOptions(value: FormDataEntryValue | null): MenuOption[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(String(value)); } catch { throw new Error("Check the item choices and try again."); }
  if (!Array.isArray(parsed) || parsed.length > 25) throw new Error("An item can have at most 25 choices.");
  const names = new Set<string>();
  return parsed.map((entry) => {
    const name = String(entry?.name ?? "").trim();
    const key = name.toLocaleLowerCase();
    if (!name || name.length > 80 || names.has(key)) throw new Error("Each choice needs a unique name of up to 80 characters.");
    names.add(key);
    return { id: String(entry?.id || createUuid()), name, available: entry?.available !== false };
  });
}

// Netlify serves this frontend and shared-data functions; FastAPI's /api
// routes are not deployed there. Anything that is not this computer counts as
// hosted, including the custom domain (cedarbite.me), not only *.netlify.app.
const IS_NETLIFY_HOSTED = !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
const LOCAL_COUNTER_STUDENT_DIRECTORY_KEY = "cedarbite-local-counter-students";

function readLocalCounterStudentDirectory(): Record<string, string> {
  try {
    const parsed = JSON.parse(storageGet("local", LOCAL_COUNTER_STUDENT_DIRECTORY_KEY) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch { storageRemove("local", LOCAL_COUNTER_STUDENT_DIRECTORY_KEY); }
  return {};
}

function localStudentDirectoryName(studentId: string): string | null {
  const directory = readLocalCounterStudentDirectory();
  if (!directory["2028246"]) {
    directory["2028246"] = "Eshwar Das";
    storageSet("local", LOCAL_COUNTER_STUDENT_DIRECTORY_KEY, JSON.stringify(directory));
  }
  return directory[studentId]?.trim() || null;
}

function pageForPath(path: string): Page {
  if (path === "/developeraccess") return "developer";
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
  if (path === "/terms-and-conditions") return "terms";
  if (path === "/contact-us") return "contact";
  if (path === "/team") return "team";
  return "menu";
}

type BrowserStorage = "local" | "session";
function storageGet(area: BrowserStorage, key: string): string | null {
  try { return (area === "local" ? window.localStorage : window.sessionStorage).getItem(key); }
  catch { return null; }
}
function storageSet(area: BrowserStorage, key: string, value: string): boolean {
  try { (area === "local" ? window.localStorage : window.sessionStorage).setItem(key, value); return true; }
  catch { return false; }
}
function storageRemove(area: BrowserStorage, key: string): void {
  try { (area === "local" ? window.localStorage : window.sessionStorage).removeItem(key); }
  catch { /* Storage can be disabled by browser privacy settings. */ }
}
type PendingOrderAttempt = { order: Order; signature: string };
const pendingOrderStorageKey = (email: string) => `cedarbite-pending-order:${email.trim().toLowerCase()}`;
function orderAttemptSignature(order: Order) {
  return JSON.stringify({
    mode: order.mode,
    payment_method: order.payment_method,
    pickup_start_at: order.pickup_window?.start_at ?? null,
    total_display: order.total_display ?? "",
    items: order.items.map((item) => ({ item_id: item.item_id ?? null, option_id: item.option_id ?? null, name: item.name, quantity: item.quantity, unit_price_paisa: item.unit_price_paisa ?? null })),
  });
}
function readPendingOrderAttempt(email: string): PendingOrderAttempt | null {
  try {
    const parsed = JSON.parse(storageGet("local", pendingOrderStorageKey(email)) || "null") as Partial<PendingOrderAttempt> | null;
    if (!parsed?.order || typeof parsed.signature !== "string" || typeof parsed.order.id !== "string" || typeof parsed.order.pickup_code !== "string" || !Array.isArray(parsed.order.items)) return null;
    return { order: parsed.order as Order, signature: parsed.signature };
  } catch { storageRemove("local", pendingOrderStorageKey(email)); return null; }
}
type SavedBucket = { items: Record<string, number> };
const GUEST_BUCKET_KEY = "cedarbite-bucket:guest";
const accountBucketKey = (email: string) => `cedarbite-bucket:${email.trim().toLowerCase()}`;
function readSavedBucket(key: string): SavedBucket {
  try {
    const saved = JSON.parse(storageGet("local", key) || "null") as Partial<SavedBucket> | null;
    const items = Object.fromEntries(Object.entries(saved?.items ?? {}).filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0 && quantity <= 20));
    return { items };
  } catch { return { items: {} }; }
}
function mergeSavedBuckets(first: SavedBucket, second: SavedBucket): SavedBucket {
  const items = { ...first.items };
  for (const [key, quantity] of Object.entries(second.items)) items[key] = Math.min(20, (items[key] ?? 0) + quantity);
  return { items };
}
function stationForPage(page: Page) {
  return page === "developer" ? "developer" : page === "counter" ? "order_taker" : page === "cashdesk" ? "cashier" : page === "kitchen" ? "kitchen" : "order_manager";
}

function ThemeSwitch({ darkMode, onToggle, className = "" }: { darkMode: boolean; onToggle: () => void; className?: string }) {
  return <button type="button" className={`theme-toggle ${className}`} role="switch" aria-checked={darkMode} onClick={onToggle} aria-label={`Switch to ${darkMode ? "light" : "dark"} mode`} title={darkMode ? "Switch to light mode" : "Switch to dark mode"}>
    <span className="theme-toggle-icon" aria-hidden="true">{darkMode ? "☀" : "☾"}</span>
    <span className="theme-toggle-text">Dark mode</span>
    <span className="theme-switch-track" aria-hidden="true"><i/></span>
  </button>;
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
const orderCustomerLabel = (order: Order) => order.customer_type === "TEACHER" || order.customer_type === "NON_STUDENT" ? order.customer_name || "Name not provided" : order.customer_type === "GUEST" ? `Guest: ${order.customer_name || "Name not provided"}` : `${order.customer_name ? `${order.customer_name} · ` : ""}Student ID: ${order.student_id || "Not available"}`;
function useAutoPrintReceipt(request: { order: Order; key: string } | null) {
  useEffect(() => {
    if (!request) return;
    const timer = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(timer);
  }, [request?.key]);
}
function ReceiptPrintView({ order }: { order: Order }) {
  const pickupWindow = order.pickup_window ? `${new Date(order.pickup_window.start_at).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" })}–${new Date(order.pickup_window.end_at).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" })}` : "Quick pickup";
  const placedAt = Number.isFinite(Date.parse(order.created_at)) ? new Date(order.created_at) : new Date();
  return createPortal(<div className="receipt-print-root"><article className="receipt-print"><header><div className="receipt-brand"><ReceiptLogoMark/><b>CedarBite</b></div><span>CEDAR COLLEGE CANTEEN</span></header><div className="receipt-divider"/><h1>ORDER RECEIPT</h1><div className="receipt-pickup"><small>PICKUP NUMBER</small><strong>{order.pickup_code}</strong></div><div className="receipt-meta"><span>Customer</span><b>{orderCustomerLabel(order)}</b><span>Order type</span><b>{order.mode === "SCHEDULED" ? `Scheduled · ${pickupWindow}` : pickupWindow}</b><span>Placed</span><b>{placedAt.toLocaleString("en-PK", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" })}</b><span>Payment</span><b>{human(order.payment_method ?? "cash")} · {human(order.payment_status ?? "unpaid")}</b></div><div className="receipt-divider"/><div className="receipt-lines">{order.items.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}</span>{item.unit_price_paisa != null && <b>{money(item.unit_price_paisa * item.quantity)}</b>}</div>)}</div>{(order.deal_discount_paisa ?? 0) > 0 && <div className="receipt-deal-savings"><span>Deal savings</span><b>−{money(order.deal_discount_paisa ?? 0)}</b></div>}<div className="receipt-divider"/><div className="receipt-total"><span>TOTAL</span><strong>{order.total_display || "—"}</strong></div><footer>Keep this receipt and show the pickup number when collecting your order.<br/>Thank you for choosing CedarBite.</footer></article></div>, document.body);
}
const stationName = (station: string | null, user?: User | null) => station === "order_taker" ? "the counter station" : station === "cashier" ? "the cash desk" : station === "kitchen" ? "the kitchen monitor" : station === "order_manager" ? "the order manager station" : user?.email ? `the student account ${user.email}` : "another account";
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
async function loadFallbackMenu(): Promise<Category[]> {
  try {
    const { default: menuCatalog } = await import("./catalog.json");
    if (Array.isArray(menuCatalog.categories) && menuCatalog.categories.length) return menuCatalog.categories as Category[];
  } catch { /* Use the small built-in list if the catalog asset cannot be loaded. */ }
  return sampleMenu;
}
const DEMO_USER_KEY = "cedarbite-demo-user";
const LEGACY_DEMO_ORDERS_KEY = "cedarbite-demo-orders";
const CANTEEN_SESSION_KEY = "cedarbite-canteen-session";
const CANTEEN_USERNAME_KEY = "cedarbite-canteen-username";
const CANTEEN_ROLE_KEY = "cedarbite-canteen-role";
const SHARED_DATA_URL = "/.netlify/functions/shared-data";
const LOCAL_ORDER_QUEUE_KEY = "cedarbite-local-order-queue";
const walletKey = (email: string) => `cedarbite-demo-wallet:${email}`;
const demoOrdersKey = (email: string) => `cedarbite-demo-orders:${email.trim().toLowerCase()}`;
function readLocalOrderQueue(): Order[] {
  try {
    const parsed = JSON.parse(storageGet("local", LOCAL_ORDER_QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed as Order[] : [];
  } catch { storageRemove("local", LOCAL_ORDER_QUEUE_KEY); return []; }
}
function writeLocalOrderQueue(orders: Order[]) {
  return storageSet("local", LOCAL_ORDER_QUEUE_KEY, JSON.stringify(orders));
}
function loadDemoOrders(email: string, studentId: string | null): Order[] {
  const key = demoOrdersKey(email);
  try {
    const saved = storageGet("local", key);
    if (saved) {
      const orders = JSON.parse(saved) as Order[];
      return Array.isArray(orders) ? orders : [];
    }
    // Earlier preview versions stored orders in one shared list. Carry forward
    // only entries whose student ID matches this Cedar email's ID.
    const legacy = JSON.parse(storageGet("local", LEGACY_DEMO_ORDERS_KEY) || "[]") as Order[];
    const ownOrders = Array.isArray(legacy) && studentId
      ? legacy.filter((order) => String(order.student_id ?? "") === studentId)
      : [];
    storageSet("local", key, JSON.stringify(ownOrders));
    return ownOrders;
  } catch {
    return [];
  }
}
function cacheDemoMenu(categories: Category[]) {
  try { storageSet("local", "cedarbite-demo-menu", JSON.stringify(categories)); }
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
async function resizeHeroImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 12 * 1024 * 1024) throw new Error("Choose an image smaller than 12 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This image could not be prepared. Try another one.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL("image/jpeg", 0.76);
    if (imageData.length > 430_000) throw new Error("This image is still too large. Choose a smaller or simpler image.");
    return imageData;
  } finally { bitmap.close(); }
}
function itemIcon(item: Pick<Item, "name">) {
  return /drink|water|juice|soda/i.test(item.name) ? "🥤" : /fries|chips/i.test(item.name) ? "🍟" : /rice|biryani/i.test(item.name) ? "🍛" : /wrap|roll/i.test(item.name) ? "🌯" : /cake|cookie|sweet/i.test(item.name) ? "🧁" : /sandwich|toast/i.test(item.name) ? "🥪" : /samosa/i.test(item.name) ? "🥟" : /burger/i.test(item.name) ? "🍔" : "🍽️";
}
function MenuItemVisual({ item, className = "" }: { item: Item; className?: string }) {
  return item.image_data
    ? <img className={`menu-item-image ${className}`} src={item.image_data} alt={item.name} loading="eager" decoding="async" />
    : <span className={className}>{itemIcon(item)}</span>;
}
function CedarMark() {
  return <svg className="cedar-mark" viewBox="0 0 64 64" role="img" aria-label="CedarBite logo mark"><path d="M9 25C15 14 24 9 32 8v13C24 22 18 26 14 33z" fill="#ffc928"/><path d="M55 25C49 14 40 9 32 8v13c8 1 14 5 18 12z" fill="#102b4c"/><path d="M12 36h40v5H12z" fill="#102b4c"/><path d="M19 34a13 13 0 0 1 26 0z" fill="#102b4c"/><path d="M20 44v11h5V44m7 0v11h5V44m7 0v11h5V44" fill="#ffc928"/><circle cx="49" cy="49" r="9" fill="#fff" stroke="#102b4c" strokeWidth="3"/><path d="m45 49 3 3 5-6" fill="none" stroke="#ffc928" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function ReceiptLogoMark() {
  return <svg className="receipt-logo-mark" viewBox="0 0 48 48" role="img" aria-label="CedarBite serving cloche logo"><path fill="currentColor" d="M5 18C10 8 18 3 24 3v10c-6 2-10 5-13 12zm38 0C38 8 30 3 24 3v10c6 2 10 5 13 12zM12 27a12 12 0 0 1 24 0zM7 29h34v5H7zm6 8h6v8h-6zm11 0h6v8h-6zm11 0h6v8h-6z"/></svg>;
}
function AppLoadingScreen() {
  return <main className="boot-fallback" role="status"><section className="boot-fallback-card"><div className="boot-fallback-brand"><CedarMark/><span>Cedar<span>Bite</span></span></div><h1>CedarBite is loading</h1><p>Please wait a moment.</p></section></main>;
}
function createUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function vapidKeyBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
type ReadyAlertState = "checking" | "unsupported" | "not-configured" | "install-required" | "blocked" | "off" | "on";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  // Signed-in Cedar users can order; local preview accounts are enabled only on localhost.
  const canOrder = (user?.role === "DEMO_STUDENT" && !IS_NETLIFY_HOSTED) || user?.source === "supabase";
  const [csrf, setCsrf] = useState("");
  const [canteenPassword, setCanteenPassword] = useState(() => storageGet("session", CANTEEN_SESSION_KEY) || "");
  const [canteenUsername, setCanteenUsername] = useState(() => storageGet("session", CANTEEN_USERNAME_KEY) || "manager");
  const [canteenStation, setCanteenStation] = useState(() => {
    const routePage = pageForPath(window.location.pathname);
    if (["counter", "cashdesk", "order-manager", "kitchen", "developer"].includes(routePage)) return stationForPage(routePage);
    return storageGet("session", CANTEEN_ROLE_KEY) || "order_manager";
  });
  const canViewSales = canteenStation === "order_manager" || canteenStation === "developer";
  const [categories, setCategoriesState] = useState<Category[]>([]);
  const [menuLoadedRole, setMenuLoadedRoleState] = useState<string | null>(null);
  const setCategories = setCategoriesState;
  const [orders, setOrders] = useState<Order[]>([]);
  const [readyAlertState, setReadyAlertState] = useState<ReadyAlertState>("checking");
  const [readyAlertMessage, setReadyAlertMessage] = useState("");
  const [readyAlertBusy, setReadyAlertBusy] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [orderConfirmation, setOrderConfirmation] = useState<Order | null>(null);
  const [queue, setQueue] = useState<Order[]>([]);
  const [orderHistory, setOrderHistory] = useState<Order[]>([]);
  const [salesSummary, setSalesSummary] = useState<SalesSummary | null>(null);
  const [salesSummaryDates, setSalesSummaryDates] = useState<string[]>([]);
  const [salesSummaryLoading, setSalesSummaryLoading] = useState(false);
  const [salesSummaryError, setSalesSummaryError] = useState("");
  const [monthlySalesSummary, setMonthlySalesSummary] = useState<MonthlySalesSummary | null>(null);
  const [monthlySalesMonths, setMonthlySalesMonths] = useState<string[]>([]);
  const [monthlySalesLoading, setMonthlySalesLoading] = useState(false);
  const [monthlySalesError, setMonthlySalesError] = useState("");
  const [walletTopUpHistory, setWalletTopUpHistory] = useState<WalletTopUpHistoryEntry[]>([]);
  const [walletHistoryError, setWalletHistoryError] = useState("");
  const [walletHistoryLoading, setWalletHistoryLoading] = useState(false);
  const [queuePendingIds, setQueuePendingIds] = useState<string[]>([]);
  const queueLoadInFlightRef = useRef(false);
  const queueRefreshRequestedRef = useRef(false);
  const queueRevisionRef = useRef(0);
  const queueRefreshRef = useRef<() => void>(() => {});
  const lastMyOrdersRefreshAt = useRef(Date.now());
  const queueMutationPendingRef = useRef(new Set<string>());
  const [availabilityPending, setAvailabilityPending] = useState<number[]>([]);
  const [menuMutationPending, setMenuMutationPending] = useState(false);
  const menuMutationInFlightRef = useRef(false);
  const itemAddInFlightRef = useRef(false);
  const [itemAddPending, setItemAddPending] = useState(false);
  const availabilityPendingRef = useRef(new Set<number>());
  const availabilityVersionRef = useRef(new Map<number, number>());
  const menuRevisionRef = useRef(0);
  const menuLoadRequestRef = useRef(0);
  const orderSubmittingRef = useRef(false);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [showOrderConfirmation, setShowOrderConfirmation] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [pickupWindows, setPickupWindows] = useState<PickupWindow[]>([]);
  const pickupWindowsFromApiRef = useRef(false);
  const [scheduleClock, setScheduleClock] = useState(Date.now());
  const [businessClock, setBusinessClock] = useState(Date.now());
  const [selectedWindow, setSelectedWindow] = useState("");
  const [orderingReason, setOrderingReason] = useState("Ordering is open");
  const [orderingManagerPaused, setOrderingManagerPaused] = useState(false);
  const [temporaryOpening, setTemporaryOpening] = useState(false);
  const [temporaryOpeningExpiresAt, setTemporaryOpeningExpiresAt] = useState<string | null>(null);
  const [temporaryOpeningPending, setTemporaryOpeningPending] = useState(false);
  const operationCurrentlyOpen = isCanteenOpenNow(new Date(businessClock)) || temporaryOpening;
  const [showOrderingPausedPopup, setShowOrderingPausedPopup] = useState(false);
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
  const [cart, setCart] = useState<Record<string, number>>(() => readSavedBucket(GUEST_BUCKET_KEY).items);
  const [addOnPromptItem, setAddOnPromptItem] = useState<Item | null>(null);
  const [optionPromptItem, setOptionPromptItem] = useState<Item | null>(null);
  const [pendingOptionId, setPendingOptionId] = useState<string | undefined>();
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const nextOwner = user?.email?.trim().toLowerCase() ? accountBucketKey(user.email) : "guest";
    if (nextOwner === bucketOwnerRef.current) {
      bucketHydratedRef.current = true;
      return;
    }
    const currentOwner = bucketOwnerRef.current;
    if (bucketHydratedRef.current) {
      const currentKey = currentOwner === "guest" ? GUEST_BUCKET_KEY : currentOwner;
      storageSet("local", currentKey, JSON.stringify({ items: cart } satisfies SavedBucket));
    }
    let nextBucket = readSavedBucket(nextOwner === "guest" ? GUEST_BUCKET_KEY : nextOwner);
    if (nextOwner !== "guest") {
      nextBucket = mergeSavedBuckets(nextBucket, readSavedBucket(GUEST_BUCKET_KEY));
      storageSet("local", nextOwner, JSON.stringify(nextBucket satisfies SavedBucket));
      storageRemove("local", GUEST_BUCKET_KEY);
    } else {
      storageSet("local", GUEST_BUCKET_KEY, JSON.stringify(nextBucket satisfies SavedBucket));
    }
    bucketOwnerRef.current = nextOwner;
    bucketHydratedRef.current = true;
    skipBucketPersistRef.current = true;
    setCart(nextBucket.items);
  }, [user?.email, cart]);
  useEffect(() => {
    if (!bucketHydratedRef.current) return;
    if (skipBucketPersistRef.current) { skipBucketPersistRef.current = false; return; }
    const key = bucketOwnerRef.current === "guest" ? GUEST_BUCKET_KEY : bucketOwnerRef.current;
    storageSet("local", key, JSON.stringify({ items: cart } satisfies SavedBucket));
  }, [cart]);
  const [menuError, setMenuError] = useState("");
  const [googleReady, setGoogleReady] = useState(supabaseConfigured);
  const [page, setPage] = useState<Page>(() => pageForPath(window.location.pathname));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => storageGet("local", "cedarbite-color-mode") === "dark");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [cartOpen, setCartOpen] = useState(false);
  const [itemOfDaySchedule, setItemOfDaySchedule] = useState<ItemOfDayEntry[]>([]);
  const [itemOfDayMessage, setItemOfDayMessage] = useState("");
  const [itemOfDayPending, setItemOfDayPending] = useState(false);
  const [heroSlides, setHeroSlides] = useState<HeroSlide[]>(() => {
    if (IS_NETLIFY_HOSTED) return [];
    try {
      const saved = storageGet("local", "cedarbite-homepage-hero-slides");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length && parsed.some((slide) => slide?.active !== false)) return replaceLegacyHeroPhotos(parsed);
      }
    } catch { storageRemove("local", "cedarbite-homepage-hero-slides"); }
    return defaultHeroSlides;
  });
  const [heroSlidesLoaded, setHeroSlidesLoaded] = useState(!IS_NETLIFY_HOSTED);
  const [heroSlideIndex, setHeroSlideIndex] = useState(0);
  const [heroPaused, setHeroPaused] = useState(false);
  const [heroSlidesMessage, setHeroSlidesMessage] = useState("");
  const [heroSlidesPending, setHeroSlidesPending] = useState(false);
  const loginDialog = useRef<HTMLDialogElement>(null);
  const bucketOwnerRef = useRef("guest");
  const bucketHydratedRef = useRef(false);
  const skipBucketPersistRef = useRef(false);
  const cashTopUpRequest = useRef<{ signature: string; key: string } | null>(null);
  const pendingOrderAttemptRef = useRef<{ email: string; attempt: PendingOrderAttempt } | null>(null);
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
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new ApiResponseError(`Expected JSON from ${path}, received ${contentType || "an unknown response"}.`, response.status);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const serverMessage = typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
      const localServiceUnavailable = !IS_NETLIFY_HOSTED && /SUPABASE_SECRET_KEY/i.test(serverMessage);
      throw new ApiResponseError(localServiceUnavailable ? "Records are not connected in this local environment." : serverMessage, response.status, localServiceUnavailable);
    }
    return body as T;
  }, [canteenPassword, canteenStation, canteenUsername, csrf]);

  async function submitCounterOrder(order: Record<string, unknown>): Promise<Order> {
    if (!isCanteenOpenNow() && !temporaryOpening && (IS_NETLIFY_HOSTED || user?.role !== "DEMO_CANTEEN")) throw new Error("We are currently not accepting orders.");
    if (!IS_NETLIFY_HOSTED && user?.role === "DEMO_CANTEEN") {
      const createdAt = typeof order.created_at === "string" && Number.isFinite(Date.parse(order.created_at)) ? order.created_at : new Date().toISOString();
      const localOrder = { ...order, created_at: createdAt, source: "COUNTER", status: "SUBMITTED", payment_method: "cash", payment_status: "UNPAID" } as unknown as Order;
      writeLocalOrderQueue([localOrder, ...readLocalOrderQueue().filter((entry) => String(entry.id) !== String(localOrder.id))]);
      return localOrder;
    }
    const init: RequestInit = { method: "POST", body: JSON.stringify({ action: "create-counter-order", order }) };
    const orderId = String(order.id ?? "");
    let connectionError: TypeError | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await request<{ order?: Order }>(SHARED_DATA_URL, init);
        if (result.order) return result.order;
        throw new Error("The counter service did not return the saved order.");
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        connectionError = error;
      }

      // A timed-out response can mean the server saved the order but the
      // browser never received its confirmation. Check by id before retrying.
      await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
      try {
        const saved = await request<{ order: Order | null }>(`${SHARED_DATA_URL}?scope=counter-order&id=${encodeURIComponent(orderId)}`, { cache: "no-store" });
        if (saved.order) return saved.order;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        connectionError = error;
      }
    }
    throw new Error(connectionError
      ? "The counter service is not reachable right now. The same order was checked safely; please retry when the connection returns."
      : "The counter service could not confirm the saved order.");
  }

  async function submitStudentOrder(order: Order): Promise<Order> {
    if (!IS_NETLIFY_HOSTED && user?.role === "DEMO_STUDENT") {
      const localOrder: Order = {
        ...order,
        total_paisa: order.total_paisa ?? cartTotal,
        customer_type: "STUDENT",
        customer_name: user.full_name ?? null,
        source: "LOCAL",
        status: "SUBMITTED",
        payment_status: order.payment_method === "wallet" ? "PAID" : "UNPAID",
      };
      const queue = readLocalOrderQueue();
      if (!queue.some((entry) => String(entry.id) === String(localOrder.id))) writeLocalOrderQueue([localOrder, ...queue]);
      return localOrder;
    }
    return submitOrderWithRecovery(order, async (sameOrder) => {
      // The server works out who is ordering from this sign-in token, not from the order details.
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      return request<{ order?: Order }>(SHARED_DATA_URL, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: JSON.stringify({ action: "create-order", order: sameOrder }),
      });
    }, async (sameOrder) => request<{ order: Order | null }>(
      `${SHARED_DATA_URL}?scope=student-order&id=${encodeURIComponent(String(sameOrder.id))}&pickup_code=${encodeURIComponent(sameOrder.pickup_code)}`,
      { cache: "no-store" },
    ), (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
  }

  const loadPickupSchedule = useCallback(async () => {
    if (!IS_NETLIFY_HOSTED) {
      try {
        const result = await request<{ windows: PickupWindow[] }>("/api/pickup-windows", { cache: "no-store" });
        if (Array.isArray(result.windows)) return result.windows;
      } catch { /* Use the shared Netlify schedule when the API route is not deployed. */ }
    }
    const result = await request<{ windows: PickupWindow[] }>(`${SHARED_DATA_URL}?scope=pickup-windows`, { cache: "no-store" });
    if (!Array.isArray(result.windows)) throw new Error("Pickup schedule is unavailable.");
    return result.windows;
  }, [request]);

  const loadSharedAvailability = useCallback(async () => {
    if (user?.role !== "DEMO_CANTEEN" && user?.role !== "DEMO_STUDENT") return;
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
  }, [request, user?.role]);

  const userRole = user?.role;
  const loadOrderingStatus = useCallback(async () => {
    try {
      const result = IS_NETLIFY_HOSTED || userRole?.startsWith("DEMO_") || !userRole
        ? await request<{ paused: boolean; manual_paused?: boolean; closed?: boolean; temporary_open?: boolean; temporary_open_expires_at?: string | null }>(`${SHARED_DATA_URL}?scope=ordering-status`, { cache: "no-store" })
        : await request<{ accepting_orders: boolean }>("/api/ordering/status", { cache: "no-store" });
      const paused = "manual_paused" in result ? result.manual_paused === true : "paused" in result ? result.paused : !result.accepting_orders;
      const closed = "closed" in result && result.closed === true;
      const temporary = "temporary_open" in result && result.temporary_open === true;
      setOrderingManagerPaused(paused);
      setTemporaryOpening(temporary);
      setTemporaryOpeningExpiresAt("temporary_open_expires_at" in result ? result.temporary_open_expires_at ?? null : null);
      setOrderingReason(temporary ? "Open temporarily · all interfaces active" : paused ? "Online ordering is paused by the canteen." : closed ? "Closed · opens at 8:00 AM" : "Ordering is open");
    } catch {
      if (IS_NETLIFY_HOSTED || userRole?.startsWith("DEMO_") || !userRole) {
        try {
          const result = await request<{ paused: boolean; manual_paused?: boolean; closed?: boolean; temporary_open?: boolean; temporary_open_expires_at?: string | null }>(`${SHARED_DATA_URL}?scope=ordering-status`, { cache: "no-store" });
          const paused = result.manual_paused ?? result.paused;
          const temporary = result.temporary_open === true;
          setOrderingManagerPaused(paused);
          setTemporaryOpening(temporary);
          setTemporaryOpeningExpiresAt(result.temporary_open_expires_at ?? null);
          setOrderingReason(temporary ? "Open temporarily · all interfaces active" : paused ? "Online ordering is paused by the canteen." : result.closed ? "Closed · opens at 8:00 AM" : "Ordering is open");
        } catch { /* The order service still enforces its saved setting when an order is submitted. */ }
      }
    }
  }, [request, userRole]);
  useEffect(() => {
    if (!temporaryOpening || !temporaryOpeningExpiresAt) return;
    const delay = Date.parse(temporaryOpeningExpiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) { void loadOrderingStatus(); return; }
    const timer = window.setTimeout(() => void loadOrderingStatus(), delay + 1_000);
    return () => window.clearTimeout(timer);
  }, [loadOrderingStatus, temporaryOpening, temporaryOpeningExpiresAt]);

  const loadMenu = useCallback(async (manage = false) => {
    const revisionAtStart = menuRevisionRef.current;
    // Only the newest menu load may update the screen. A page first loads the menu as a
    // logged-out visitor, then again once the saved staff login is read; if the older visitor
    // load finished last it used to overwrite the staff one and leave the screen on "loading".
    const requestId = ++menuLoadRequestRef.current;
    const isLatest = () => requestId === menuLoadRequestRef.current;
    const setCategories = (next: Category[]) => { if (isLatest()) setCategoriesState(ensureColdDrinkOptions(next)); };
    const setMenuLoadedRole = (role: string) => { if (isLatest()) setMenuLoadedRoleState(role); };
    // The menu comes from Supabase first (when configured). The old sources below are the backup.
    try {
      const supabaseMenu = await fetchMenuFromSupabase();
      if (revisionAtStart === menuRevisionRef.current && availabilityPendingRef.current.size === 0) {
        setCategories(supabaseMenu);
        setMenuLoadedRole(userRole ?? "anonymous");
        setMenuError("");
        console.info(`Menu loaded from Supabase (${supabaseMenu.length} categories).`);
      }
      return;
    } catch (error) {
      console.warn("Could not load the menu from Supabase; falling back to the old menu sources.", error);
    }
    if (userRole?.startsWith("DEMO_") || !userRole) {
      try {
        const shared = await request<{ categories: Category[] | null }>(`${SHARED_DATA_URL}?scope=menu`);
        if (Array.isArray(shared.categories) && shared.categories.length > 0 && revisionAtStart === menuRevisionRef.current && availabilityPendingRef.current.size === 0) {
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
      const saved = storageGet("local", "cedarbite-demo-menu");
      if (saved) { try { const parsed: unknown = JSON.parse(saved); if (!Array.isArray(parsed)) throw new Error("Saved menu is invalid."); setCategories(parsed as Category[]); setMenuLoadedRole(userRole); setMenuError(""); void loadSharedAvailability(); } catch { storageRemove("local", "cedarbite-demo-menu"); } return; }
      if (userRole === "DEMO_CANTEEN") { setCategories(await loadFallbackMenu()); setMenuLoadedRole(userRole); void loadSharedAvailability(); return; }
    }
    if (IS_NETLIFY_HOSTED) {
      if (revisionAtStart === menuRevisionRef.current && availabilityPendingRef.current.size === 0) {
        setCategories(await loadFallbackMenu());
        setMenuLoadedRole(userRole ?? "anonymous");
        setMenuError("");
      }
      return;
    }
    try {
      const result = await request<{ categories: Category[] }>(manage ? "/api/menu/manage" : "/api/menu");
      if (revisionAtStart === menuRevisionRef.current && availabilityPendingRef.current.size === 0) {
        setCategories(Array.isArray(result.categories) && result.categories.length > 0 ? result.categories : await loadFallbackMenu());
        setMenuLoadedRole(userRole ?? "anonymous");
        setMenuError("");
      }
    }
    catch { if (revisionAtStart === menuRevisionRef.current && availabilityPendingRef.current.size === 0) { setCategories(await loadFallbackMenu()); setMenuLoadedRole(userRole ?? "anonymous"); setMenuError(""); } }
  }, [loadSharedAvailability, request, userRole]);
  const loadQueue = useCallback(async () => {
    if (canteenStation === "order_taker") return;
    if (queueLoadInFlightRef.current) { queueRefreshRequestedRef.current = true; return; }
    queueLoadInFlightRef.current = true;
    const revision = queueRevisionRef.current;
    try {
      if (!IS_NETLIFY_HOSTED && user?.role === "DEMO_CANTEEN") {
        const activeLocalOrders = readLocalOrderQueue().filter((order) => !["COLLECTED", "CANCELLED", "VOIDED"].includes(order.status));
        const localQueue = canteenStation === "cashier"
          ? activeLocalOrders.filter((order) => order.payment_method === "cash" && order.payment_status !== "PAID" && order.status !== "COLLECTED")
          : canteenStation === "kitchen"
            ? activeLocalOrders.filter((order) => order.status === "PREPARING")
            : activeLocalOrders;
        if (revision === queueRevisionRef.current) setQueue(localQueue);
        return;
      }
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
    if (user?.role !== "DEMO_CANTEEN" || (!canViewSales && canteenStation !== "cashier")) return;
    try {
      if (!IS_NETLIFY_HOSTED) {
        const completed = readLocalOrderQueue().filter((order) => order.status === "COLLECTED");
        setOrderHistory(completed.sort((a, b) => Date.parse(b.completed_at ?? b.created_at) - Date.parse(a.completed_at ?? a.created_at)));
        return;
      }
      const result = await request<{ orders: Order[] }>(`${SHARED_DATA_URL}?scope=history`, { cache: "no-store" });
      setOrderHistory(result.orders);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Order history could not be loaded.");
    }
  }, [canteenStation, canViewSales, request, user]);
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
    if (user?.role !== "DEMO_CANTEEN" || !canViewSales) return;
    try {
      const result = await request<{ dates: string[] }>(`${SHARED_DATA_URL}?scope=sales-dates`, { cache: "no-store" });
      setSalesSummaryDates(result.dates);
    } catch (error) {
      setSalesSummaryError(error instanceof Error ? error.message : "Daily summaries could not be loaded.");
    }
  }, [canteenStation, request, user]);
  const loadSalesSummary = useCallback(async (date = pakistanDay()) => {
    if (!isValidSalesDate(date) || user?.role !== "DEMO_CANTEEN" || !canViewSales) return;
    setSalesSummaryLoading(true);
    setSalesSummaryError("");
    try {
      const result = await request<{ report: SalesSummary }>(`${SHARED_DATA_URL}?scope=sales-summary&date=${encodeURIComponent(date)}`, { cache: "no-store" });
      setSalesSummary(result.report);
      setSalesSummaryDates((current) => [...new Set([date, ...current])].sort((a, b) => b.localeCompare(a)));
    } catch (error) {
      setSalesSummaryError(error instanceof Error ? error.message : "The daily summary could not be loaded.");
    } finally { setSalesSummaryLoading(false); }
  }, [canteenStation, canViewSales, request, user]);
  const loadMonthlySalesMonths = useCallback(async () => {
    if (user?.role !== "DEMO_CANTEEN" || !canViewSales) return;
    try {
      const result = await request<{ months: string[] }>(`${SHARED_DATA_URL}?scope=sales-months`, { cache: "no-store" });
      setMonthlySalesMonths(result.months);
    } catch (error) {
      setMonthlySalesError(error instanceof Error ? error.message : "Monthly sales periods could not be loaded.");
    }
  }, [canteenStation, canViewSales, request, user]);
  const loadMonthlySalesSummary = useCallback(async (month = pakistanDay().slice(0, 7)) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || user?.role !== "DEMO_CANTEEN" || !canViewSales) return;
    setMonthlySalesLoading(true);
    setMonthlySalesError("");
    try {
      const result = await request<{ report: MonthlySalesSummary }>(`${SHARED_DATA_URL}?scope=sales-month&month=${encodeURIComponent(month)}`, { cache: "no-store" });
      setMonthlySalesSummary(result.report);
      setMonthlySalesMonths((current) => [...new Set([month, ...current])].sort((a, b) => b.localeCompare(a)));
    } catch (error) {
      setMonthlySalesError(error instanceof Error ? error.message : "The monthly sales audit could not be loaded.");
    } finally { setMonthlySalesLoading(false); }
  }, [canteenStation, canViewSales, request, user]);
  const exportDeveloperData = useCallback((from: string, to: string) => request<DeveloperExportPayload>(
    `${SHARED_DATA_URL}?scope=developer-export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { cache: "no-store" },
  ), [request]);
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
  const loadMyOrders = useCallback(async () => {
    // Google (Supabase) users: the server returns only the signed-in person's own orders.
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    try {
      const result = await request<{ orders: Order[] }>(`${SHARED_DATA_URL}?scope=my-orders`, { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
      if (Array.isArray(result.orders)) { setOrders(result.orders); return result.orders; }
    } catch { /* Keep the orders already on screen; the next refresh tries again. */ }
  }, [request]);
  const checkReadyAlerts = useCallback(async () => {
    if (page !== "orders") return;
    if (user?.source !== "supabase") {
      setReadyAlertState("off");
      setReadyAlertMessage("Sign in with your Cedar Google account to enable alerts on this device.");
      return;
    }
    setReadyAlertMessage("");
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window) || !window.isSecureContext) {
      setReadyAlertState("unsupported"); return;
    }
    if (Notification.permission === "denied") { setReadyAlertState("blocked"); return; }
    try {
      const config = await request<{ enabled: boolean; public_key: string | null }>(`${SHARED_DATA_URL}?scope=push-config`, { cache: "no-store" });
      if (!config.enabled || !config.public_key) { setReadyAlertState("not-configured"); setReadyAlertMessage("Browser alerts are not configured on the live site yet."); return; }
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      if (ios && !standalone) { setReadyAlertState("install-required"); return; }
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription && Notification.permission === "granted") {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("Sign in again with your Cedar Google account to enable alerts.");
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(config.public_key) });
        await request(SHARED_DATA_URL, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "subscribe-push", subscription: subscription.toJSON() }) });
      }
      setReadyAlertState(subscription ? "on" : "off");
    } catch {
      setReadyAlertState("off");
      setReadyAlertMessage("We couldn’t check alert setup. Try turning alerts on again.");
    }
  }, [page, request, user?.source]);
  async function enableReadyAlerts() {
    if (readyAlertBusy) return;
    setReadyAlertBusy(true);
    setReadyAlertMessage("");
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window) || !window.isSecureContext) {
        setReadyAlertState("unsupported");
        setReadyAlertMessage("This browser or page does not support secure browser alerts.");
        return;
      }
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") {
        setReadyAlertState("blocked");
        setReadyAlertMessage("Your browser did not show a permission prompt because notifications are blocked for CedarBite. Change CedarBite notification permission in browser settings, then tap Try again.");
        return;
      }
      const config = await request<{ enabled: boolean; public_key: string | null }>(`${SHARED_DATA_URL}?scope=push-config`, { cache: "no-store" });
      if (!config.enabled || !config.public_key) { setReadyAlertState("not-configured"); setReadyAlertMessage("Browser alerts are not configured on the live site yet."); return; }
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in again with your Cedar Google account to enable alerts.");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(config.public_key) });
      await request(SHARED_DATA_URL, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "subscribe-push", subscription: subscription.toJSON() }) });
      setReadyAlertState("on");
      setReadyAlertMessage("Ready alerts are on for this device.");
    } catch (error) {
      setReadyAlertState("off");
      setReadyAlertMessage(error instanceof Error ? error.message : "Ready alerts could not be enabled.");
    } finally {
      setReadyAlertBusy(false);
    }
  }
  async function disableReadyAlerts() {
    setReadyAlertMessage("");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription && token) await request(SHARED_DATA_URL, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "unsubscribe-push", endpoint: subscription.endpoint }) });
      await subscription?.unsubscribe();
      setReadyAlertState("off");
      setReadyAlertMessage("Ready alerts are off for this device.");
    } catch (error) { setReadyAlertMessage(error instanceof Error ? error.message : "Ready alerts could not be turned off."); }
  }
  function askForReadyAlertsOnOrder() {
    if (user?.source !== "supabase" || !("Notification" in window) || !("serviceWorker" in navigator) || !window.isSecureContext || Notification.permission === "denied") return;
    // Start the permission prompt directly from the Place order gesture; declining never blocks the order.
    const permissionRequest = Notification.permission === "granted" ? Promise.resolve<NotificationPermission>("granted") : Notification.requestPermission();
    void permissionRequest.then(async (permission) => {
      if (permission !== "granted") { setReadyAlertState("blocked"); return; }
      const config = await request<{ enabled: boolean; public_key: string | null }>(`${SHARED_DATA_URL}?scope=push-config`, { cache: "no-store" });
      if (!config.enabled || !config.public_key) { setReadyAlertState("not-configured"); return; }
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(config.public_key) });
      await request(SHARED_DATA_URL, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "subscribe-push", subscription: subscription.toJSON() }) });
      setReadyAlertState("on");
    }).catch((error) => {
      setReadyAlertMessage(error instanceof Error ? error.message : "Ready alerts could not be enabled.");
    });
  }
  async function cancelMyOrder(order: Order) {
    if (cancellingOrderId) return;
    if (!window.confirm(`Cancel order ${order.pickup_code}? This can't be undone.`)) return;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) { setToast("Your sign-in has expired. Sign in again, then cancel the order."); return; }
    setCancellingOrderId(String(order.id));
    try {
      const result = await request<{ order: Order }>(SHARED_DATA_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "cancel-order", order_id: String(order.id) }),
      });
      setOrders((current) => current.map((entry) => String(entry.id) === String(order.id) ? result.order : entry));
      setToast(`Order ${order.pickup_code} has been cancelled.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The order could not be cancelled. Please try again.");
      void loadMyOrders(); // show the order's real status (e.g. the canteen just accepted it)
    } finally {
      setCancellingOrderId(null);
    }
  }
  const loadWallet = useCallback(async () => {
    if (user?.role === "DEMO_STUDENT") {
      try {
        const saved = JSON.parse(storageGet("local", walletKey(user.email)) || "null") as { balance?: number; entries?: WalletEntry[] } | null;
        let balance = Number(saved?.balance) || 0;
        let entries = Array.isArray(saved?.entries) ? saved.entries : [];
        const result = await request<{ entries: { id: string; label: string; amount_paisa: number; kind: "credit" | "debit"; created_at: string; method: string }[] }>(`${SHARED_DATA_URL}?scope=student-wallet`, { cache: "no-store" });
        const knownIds = new Set(entries.map((entry) => String(entry.id)));
        const unseenCredits = result.entries.filter((entry) => entry.kind === "credit" && !knownIds.has(String(entry.id)));
        for (const entry of unseenCredits) {
          balance += entry.amount_paisa;
          entries = [{ id: entry.id, label: entry.label, amount: entry.amount_paisa, kind: "credit", created_at: entry.created_at, method: entry.method }, ...entries];
        }
        if (unseenCredits.length) storageSet("local", walletKey(user.email), JSON.stringify({ balance, entries }));
        setWalletBalance(balance);
        setWalletEntries(entries);
      } catch { /* Keep the saved wallet available if shared storage is offline. */ }
      return;
    }
    if (!user || user.role.startsWith("DEMO_")) return;
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in again to view your CedarBite wallet.");
      const result = await request<{ balance_paisa: number; entries: { id: string; label: string; amount_paisa: number; kind: "credit" | "debit"; created_at: string; method: string }[] }>(`${SHARED_DATA_URL}?scope=student-wallet`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      setWalletBalance(result.balance_paisa);
      setWalletEntries(result.entries.map((entry) => ({ id: entry.id, label: entry.label, amount: entry.amount_paisa, kind: entry.kind, created_at: entry.created_at, method: entry.method })));
    } catch (error) {
      if (user.role === "student" || user.role === "staff_customer") setWalletMessage(error instanceof Error ? error.message : "Wallet could not be loaded.");
    }
  }, [request, user]);

  useEffect(() => {
    document.title = page === "owner" ? "CedarBite Canteen Console" : page === "confirmation" ? "Order confirmed · CedarBite" : page === "about" ? "About CedarBite" : page === "privacy" ? "Privacy Policy · CedarBite" : page === "terms" ? "Terms and Conditions · CedarBite" : page === "contact" ? "Contact CedarBite" : page === "team" ? "Team behind CedarBite" : "CedarBite — order your break";
    if (page === "menu") {
      if (isPickupPreviewOpen()) {
        void loadPickupSchedule().then((windows) => {
          pickupWindowsFromApiRef.current = true;
          setPickupWindows(windows);
        }).catch(() => {
          pickupWindowsFromApiRef.current = false;
          setPickupWindows(samplePickupWindows());
        });
      } else {
        pickupWindowsFromApiRef.current = false;
        setPickupWindows(samplePickupWindows());
      }
    }
    if (supabaseConfigured) {
      // Google sign-in goes through Supabase, so it is always available.
      setGoogleReady(true);
      const signInError = takeSignInErrorFromUrl();
      if (signInError) setToast(signInError);
    } else if (!IS_NETLIFY_HOSTED) {
      void request<{ configured: boolean }>("/api/auth/google/status").then((result) => setGoogleReady(result.configured)).catch(() => setGoogleReady(false));
    } else setGoogleReady(false);
    let savedDemoUser = storageGet("local", DEMO_USER_KEY);
    if (savedDemoUser) {
      try {
        const result = JSON.parse(savedDemoUser) as User;
        if ((IS_NETLIFY_HOSTED && result.role === "DEMO_STUDENT") || (result.role === "DEMO_CANTEEN" && !storageGet("session", CANTEEN_SESSION_KEY))) {
          storageRemove("local", DEMO_USER_KEY);
          savedDemoUser = null;
          setUser(null);
        } else {
          setUser(result);
          setCsrf(result.csrf_token);
        }
      } catch {
        storageRemove("local", DEMO_USER_KEY);
        savedDemoUser = null;
        setUser(null);
      }
    }
    // With Supabase on, the Supabase listener below fills in the signed-in person (if any).
    else if (!supabaseConfigured && !IS_NETLIFY_HOSTED) void request<User>("/api/auth/me").then((result) => { setUser(result); setCsrf(result.csrf_token); }).catch(() => { setUser(null); setCsrf(""); });
    else if (!supabaseConfigured) { setUser(null); setCsrf(""); }
    if (savedDemoUser) {
      try {
        const savedUser = JSON.parse(savedDemoUser) as User;
        setOrders(savedUser.role === "DEMO_STUDENT" ? loadDemoOrders(savedUser.email, savedUser.student_id) : []);
      } catch { setOrders([]); }
    } else setOrders([]);
    const params = new URLSearchParams(window.location.search);
    if (params.get("signin_error")) { setToast(params.get("signin_error") ?? "Cedar sign-in failed."); window.history.replaceState({}, "", window.location.pathname); }
  }, [loadPickupSchedule, page, request]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    storageSet("local", "cedarbite-color-mode", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    const timer = window.setInterval(() => setBusinessClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (temporaryOpening) { setOrderingReason("Open temporarily · all interfaces active"); return; }
    if (orderingManagerPaused) return;
    setOrderingReason(isCanteenOpenNow(new Date(businessClock)) ? "Ordering is open" : "Closed · opens at 8:00 AM");
  }, [businessClock, orderingManagerPaused, temporaryOpening, user?.role]);

  useEffect(() => {
    if (page !== "menu") return;
    let lastScheduleLoad = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      setScheduleClock(now);
      if (!pickupWindowsFromApiRef.current) setPickupWindows(samplePickupWindows(new Date(now)));
      if (!isPickupPreviewOpen(new Date(now))) return;
      const scheduleRefreshMs = 60_000;
      if (now - lastScheduleLoad < scheduleRefreshMs) return;
      lastScheduleLoad = now;
      void loadPickupSchedule().then((windows) => {
        pickupWindowsFromApiRef.current = true;
        setPickupWindows(windows);
      }).catch(() => {
        if (!pickupWindowsFromApiRef.current) setPickupWindows(samplePickupWindows(new Date(now)));
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadPickupSchedule, page]);

  useEffect(() => {
    if (selectedWindow && !availablePickupWindows.some((window) => String(window.id) === selectedWindow)) setSelectedWindow("");
  }, [availablePickupWindows, selectedWindow]);

  useEffect(() => {
    // Supabase users: menu from Supabase, their own orders from the server (the wallet comes in a later step).
    if (user?.source === "supabase") { void loadMenu(); return; }
    if (user?.role === "DEMO_CANTEEN") {
      if (page === "developer") return;
      if (page === "kitchen" || page === "cashdesk") { void loadQueue(); return; }
      void loadMenu(true);
      if (page !== "counter") void loadQueue();
      void loadSharedAvailability();
      return;
    }
    if (user?.role === "DEMO_STUDENT") { setOrders(loadDemoOrders(user.email, user.student_id)); void loadMenu(); void loadWallet(); return; }
    if (user?.permissions.includes("queue.view")) void loadQueue();
    if (user?.permissions.includes("orders.view_own")) void loadOrders();
    if (user?.role === "student" || user?.role === "staff_customer") void loadWallet();
    void loadMenu(Boolean(user?.permissions.includes("menu.manage") || user?.permissions.includes("availability.toggle")));
  }, [user, page, loadMenu, loadMyOrders, loadOrders, loadQueue, loadWallet, temporaryOpening]);
  const hasActiveOrders = orders.some((order) => !["COLLECTED", "CANCELLED", "VOIDED"].includes(order.status));
  useEffect(() => {
    // Keep order progress current while the student browses so a ready order can raise an in-site alert.
    if (user?.source !== "supabase") return;
    if (!hasActiveOrders && page !== "orders" && page !== "menu") return;
    let previous: Map<string, string> | null = null;
    const refresh = async () => {
      if (document.hidden || !operationCurrentlyOpen) return;
      const fresh = await loadMyOrders();
      if (!fresh) return;
      if (previous) {
        const ready = fresh.find((order) => order.status === "READY" && previous?.get(String(order.id)) !== "READY");
        if (ready && page !== "orders" && (!("Notification" in window) || Notification.permission !== "granted")) setToast(`Your order ${ready.pickup_code} is ready to collect!`);
      }
      previous = new Map(fresh.map((order) => [String(order.id), order.status]));
    };
    lastMyOrdersRefreshAt.current = Date.now();
    void refresh();
    const timer = operationCurrentlyOpen ? window.setInterval(() => {
      const refreshMs = hasActiveOrders ? 7_000 : 60_000;
      if (Date.now() - lastMyOrdersRefreshAt.current >= refreshMs) {
        lastMyOrdersRefreshAt.current = Date.now();
        void refresh();
      }
    }, 5_000) : null;
    document.addEventListener("visibilitychange", refresh);
    return () => { if (timer !== null) window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [hasActiveOrders, loadMyOrders, operationCurrentlyOpen, page, user?.source]);
  useEffect(() => { void checkReadyAlerts(); }, [checkReadyAlerts]);
  useEffect(() => {
    let stopped = false;
    const loadItemOfDay = async () => {
      if (!IS_NETLIFY_HOSTED) {
        try {
          const saved = storageGet("local", "cedarbite-demo-item-of-day");
          if (saved) {
            const schedule = JSON.parse(saved) as ItemOfDayEntry[];
            if (!stopped && Array.isArray(schedule)) setItemOfDaySchedule(schedule);
          }
        } catch { storageRemove("local", "cedarbite-demo-item-of-day"); }
        return;
      }
      try {
        const result = await request<{ schedule: ItemOfDayEntry[] | null }>(`${SHARED_DATA_URL}?scope=item-of-day`);
        if (!stopped && Array.isArray(result.schedule)) setItemOfDaySchedule(result.schedule);
      } catch { /* The menu remains usable if this optional setting is unavailable. */ }
    };
    void loadItemOfDay();
    return () => { stopped = true; };
  }, [request, user?.role]);
  useEffect(() => {
    if (!IS_NETLIFY_HOSTED) return;
    let stopped = false;
    let loading = false;
    const refreshSlides = async () => {
      if (stopped || loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const result = await request<{ slides: HeroSlide[] | null }>(`${SHARED_DATA_URL}?scope=hero-slides`);
        if (!stopped) {
          const updated = Array.isArray(result.slides) && result.slides.length && result.slides.some((slide) => slide?.active !== false) ? replaceLegacyHeroPhotos(result.slides) : defaultHeroSlides;
          setHeroSlides((current) => current.length === updated.length && current.every((slide, index) => {
            const next = updated[index];
            return slide.id === next.id && slide.kicker === next.kicker && slide.title === next.title && slide.highlight === next.highlight && slide.description === next.description && slide.image_data === next.image_data && slide.active === next.active;
          }) ? current : updated);
          setHeroSlidesLoaded(true);
        }
      } catch { /* Keep the current banner if shared settings are briefly unavailable. */ }
      finally { loading = false; }
    };
    void refreshSlides();
    const onVisible = () => { if (document.visibilityState === "visible") void refreshSlides(); };
    document.addEventListener("visibilitychange", onVisible);
    const timer = page === "menu" ? window.setInterval(() => { if (operationCurrentlyOpen) void refreshSlides(); }, 60_000) : null;
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [request, operationCurrentlyOpen, page]);
  useEffect(() => {
    const activeCount = heroSlides.filter((slide) => slide.active).length;
    if (page !== "menu" || heroPaused || activeCount < 2) return;
    const timer = window.setInterval(() => setHeroSlideIndex((current) => (current + 1) % activeCount), 3000);
    return () => window.clearInterval(timer);
  }, [heroPaused, heroSlides.length, page]);
  useEffect(() => { if (user?.role === "DEMO_STUDENT") { try { const saved = JSON.parse(storageGet("local", walletKey(user.email)) || "null"); setWalletBalance(saved?.balance ?? 0); setWalletEntries(saved?.entries ?? []); } catch { setWalletBalance(0); setWalletEntries([]); } } }, [user]);
  useEffect(() => {
    if (paymentMethod === "wallet" && !(user?.source === "supabase" && user.role === "student")) setPaymentMethod("cash");
  }, [paymentMethod, user?.role, user?.source]);
  useEffect(() => {
    if (!(["owner", "order-manager", "counter", "cashdesk", "kitchen"] as Page[]).includes(page) || user?.role !== "DEMO_CANTEEN") return;
    const refreshQueue = () => { if (!document.hidden) void loadQueue(); };
    const timer = operationCurrentlyOpen ? window.setInterval(refreshQueue, 3_000) : null;
    window.addEventListener("focus", refreshQueue);
    document.addEventListener("visibilitychange", refreshQueue);
    return () => { if (timer !== null) window.clearInterval(timer); window.removeEventListener("focus", refreshQueue); document.removeEventListener("visibilitychange", refreshQueue); };
  }, [loadQueue, operationCurrentlyOpen, page, user?.role]);
  useEffect(() => {
    if (page !== "menu" && page !== "orders" && !(["owner", "order-manager", "counter", "cashdesk", "kitchen", "developer"] as Page[]).includes(page)) return;
    const refreshAvailability = (includeMenuData = true) => {
      void loadOrderingStatus();
      if (page === "kitchen" || page === "cashdesk" || page === "developer" || page === "orders") return;
      if (!includeMenuData) return;
      if (user?.role === "DEMO_CANTEEN") void loadSharedAvailability();
      else if (user?.role === "DEMO_STUDENT") void loadMenu();
      else void loadMenu(Boolean(user?.permissions.includes("menu.manage") || user?.permissions.includes("availability.toggle")));
    };
    let lastRefreshAt = Date.now();
    void loadOrderingStatus();
    if (user?.role === "DEMO_CANTEEN" && page !== "kitchen" && page !== "cashdesk" && page !== "developer") void loadSharedAvailability();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (!operationCurrentlyOpen) { refreshAvailability(false); return; }
      const refreshMs = page === "menu" ? 30_000 : 15_000;
      if (Date.now() - lastRefreshAt < refreshMs) return;
      lastRefreshAt = Date.now();
      refreshAvailability();
    }, operationCurrentlyOpen ? 5_000 : 10 * 60_000);
    const refreshWhenVisible = () => {
      if (document.hidden) return;
      if (operationCurrentlyOpen) refreshAvailability();
      else refreshAvailability(false);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshWhenVisible); document.removeEventListener("visibilitychange", refreshWhenVisible); };
  }, [loadMenu, loadOrderingStatus, loadSharedAvailability, operationCurrentlyOpen, page, user]);

  const canManage = user?.permissions.includes("menu.manage") ?? false;
  const canToggle = user?.permissions.includes("availability.toggle") ?? false;
  const canQueue = user?.permissions.includes("queue.view") ?? false;
  const canSeeOrders = user?.source === "supabase" || (user?.permissions.includes("orders.view_own") ?? false);
  const items = useMemo(() => categories.flatMap((category) => category.items.map((item) => ({ ...item, category: category.name }))), [categories]);
  const sellableItems = useMemo(() => [...items, ...itemOfDaySchedule.map((entry) => entry.item)], [items, itemOfDaySchedule]);
  const counterSpecials = useMemo(() => itemOfDaySchedule.filter((entry) => entry.days.includes(pakistanWeekday(new Date(scheduleClock))) && entry.item.available).map((entry) => entry.item), [itemOfDaySchedule, scheduleClock]);
  const counterCategories = useMemo(() => counterSpecials.length ? [{ id: -1, name: "Items of the day", items: counterSpecials }, ...categories] : categories, [categories, counterSpecials]);
  const counterItems = useMemo(() => counterCategories.flatMap((category) => category.items), [counterCategories]);
  const menuReady = menuLoadedRole === (user?.role ?? "anonymous");
  const cartRequiresSchedule = Object.entries(cart).some(([key, quantity]) => { const item = sellableItems.find((entry) => entry.id === readCartLineKey(key).itemId); return quantity > 0 && Boolean(item?.scheduled_allowed && !item.quick_allowed); });
  const orderMode: OrderMode = cartRequiresSchedule ? "scheduled" : "quick";
  const availableModeCategories = useMemo(() => categories.map((category) => ({ ...category, items: category.items.filter((item) => item.quick_allowed || item.scheduled_allowed) })).filter((category) => category.items.length > 0), [categories]);
  useEffect(() => {
    if (!menuReady || page !== "menu" || !("IntersectionObserver" in window)) return;
    const sections = Array.from(document.querySelectorAll<HTMLElement>(".menu-category[data-category-id]"));
    if (!sections.length) return;
    const syncActiveCategory = () => {
      const guide = window.innerHeight * 0.28;
      const section = sections.find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.top <= guide && bounds.bottom > guide;
      }) ?? sections.find((candidate) => candidate.getBoundingClientRect().bottom > guide);
      const category = availableModeCategories.find((entry) => entry.id === Number(section?.dataset.categoryId));
      if (category) setCategoryFilter(category.name);
    };
    const observer = new IntersectionObserver(syncActiveCategory, { rootMargin: "-20% 0px -68% 0px", threshold: 0 });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [availableModeCategories, menuReady, page]);

  const quickOrdersOpen = (isCanteenOpenNow(new Date(businessClock)) || temporaryOpening) && !orderingManagerPaused;
  const cartCount = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
  const cartListTotal = Object.entries(cart).reduce((sum, [key, quantity]) => { const { itemId, withAddon } = readCartLineKey(key); const item = sellableItems.find((candidate) => candidate.id === itemId); return sum + (item ? item.price_paisa + (withAddon ? item.addon_price_paisa ?? 0 : 0) : 0) * quantity; }, 0);
  const cartTotal = cartListTotal;

  function navigate(next: Page) {
    setPage(next);
    setMobileMenuOpen(false);
    const url = next === "developer" ? "/developeraccess" : next === "owner" ? "/owner" : next === "stations" ? "/stations" : next === "counter" ? "/counter" : next === "cashdesk" ? "/cash-desk" : next === "order-manager" ? "/order-manager" : next === "kitchen" ? "/kitchen" : next === "orders" ? "/my-orders" : next === "confirmation" ? "/order-confirmation" : next === "about" ? "/about" : next === "privacy" ? "/privacy-policy" : next === "terms" ? "/terms-and-conditions" : next === "contact" ? "/contact-us" : next === "team" ? "/team" : "/";
    window.history.pushState({}, "", url);
    if (next === "menu") {
      window.requestAnimationFrame(() => document.getElementById("menu")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  function returnToActiveStation() {
    const active = storageGet("session", CANTEEN_ROLE_KEY);
    navigate(active === "developer" ? "developer" : active === "order_taker" ? "counter" : active === "cashier" ? "cashdesk" : active === "kitchen" ? "kitchen" : active === "order_manager" ? "order-manager" : "menu");
  }
  useEffect(() => {
    const onPop = () => setPage(pageForPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Supabase: keep the signed-in person in sync (page load, sign-in, sign-out, token refresh).
  useEffect(() => {
    if (!supabaseConfigured) return;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (storageGet("local", DEMO_USER_KEY)) return; // a demo account is in use; leave it alone
      if (event !== "INITIAL_SESSION" && event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
      // Run outside the listener (Supabase advises not to call it from inside its own callback).
      window.setTimeout(() => {
        void userFromSession(session).then((signedIn) => {
          setUser(signedIn);
          if (!signedIn) setOrders([]);
          setCsrf("");
          if (signedIn) loginDialog.current?.close();
        });
      }, 0);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  function startSignIn() {
    const returnPath = window.location.pathname || "/";
    if (!supabaseConfigured) { if (!googleReady) { setToast("Cedar Google sign-in has not been configured for this preview yet."); return; } window.location.assign(`/api/auth/google/start?next=${encodeURIComponent(returnPath)}`); return; }
    void signInWithGoogle(returnPath).catch((error) => setToast(error instanceof Error ? error.message : "Google sign-in could not start."));
  }
  function demoSignIn(emailValue: string, role: "DEMO_STUDENT" | "DEMO_CANTEEN" = "DEMO_STUDENT") {
    if (IS_NETLIFY_HOSTED) return;
    const email = emailValue.trim().toLowerCase();
    if (!email.endsWith("@cedar.edu.pk")) { setToast("Use a Cedar College email ending in @cedar.edu.pk."); return; }
    const localPart = email.split("@")[0];
    const student_id = /^\d{7}$/.test(localPart) ? localPart : null;
    const full_name = role === "DEMO_STUDENT" && student_id ? localStudentDirectoryName(student_id) : null;
    const demoUser: User = { email, role, email_verified: true, student_id, full_name, permissions: role === "DEMO_CANTEEN" ? ["orders.view_own", "queue.view", "menu.manage", "availability.toggle"] : ["orders.view_own"], csrf_token: "demo-local" };
    storageSet("local", DEMO_USER_KEY, JSON.stringify(demoUser)); setUser(demoUser); setCsrf(demoUser.csrf_token); loginDialog.current?.close(); if (role === "DEMO_STUDENT") { setOrders(loadDemoOrders(email, demoUser.student_id)); try { const saved = JSON.parse(storageGet("local", walletKey(email)) || "null"); setWalletBalance(saved?.balance ?? 0); setWalletEntries(saved?.entries ?? []); } catch { setWalletBalance(0); setWalletEntries([]); } setToast(""); } else setToast("Canteen workspace opened.");
  }
  async function demoStaffSignIn(username: string, password: string, station = "order_manager") {
    let localFallback = false;
    try {
      const response = await fetch(SHARED_DATA_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "login", station, username: username.trim(), password }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (!IS_NETLIFY_HOSTED && (response.status === 404 || response.status >= 500)) localFallback = true;
        else throw new Error(typeof result.error === "string" ? result.error : `Sign in failed (${response.status}).`);
      }
    } catch (error) {
      if (!IS_NETLIFY_HOSTED && error instanceof TypeError) localFallback = true;
      else throw new Error(error instanceof Error ? error.message : "Canteen sign-in could not be verified.");
    }
    if (station === "developer" && localFallback) throw new Error("Developer access needs a server connection and cannot be verified in this local preview.");
    if (!localFallback && IS_NETLIFY_HOSTED) throw new Error("Canteen sign-in could not be verified.");
    const permissions: Record<string, string[]> = {
      order_manager: ["queue.view", "menu.manage", "availability.toggle"],
      developer: ["developer.area", "sales.view", "customize.manage", "staff.passwords.manage", "data.export"],
      order_taker: ["counter.orders"],
      cashier: ["cashier.manage", "wallet.cash_topup"],
      kitchen: ["kitchen.view"],
    };
    const demoUser: User = { email: `${station}@canteen.local`, role: "DEMO_CANTEEN", email_verified: true, student_id: null, permissions: permissions[station] ?? [], csrf_token: "demo-local" };
    storageSet("session", CANTEEN_SESSION_KEY, password); storageSet("session", CANTEEN_USERNAME_KEY, username.trim()); storageSet("session", CANTEEN_ROLE_KEY, station); setCanteenPassword(password); setCanteenUsername(username.trim()); setCanteenStation(station); storageSet("local", DEMO_USER_KEY, JSON.stringify(demoUser)); setUser(demoUser); setCsrf(demoUser.csrf_token); setToast(station === "developer" ? "Developer area opened." : "Canteen workspace opened.");
  }
  async function changeStaffPassword(newPassword: string) {
    const station = canteenStation;
    await request(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "change-password", station, new_password: newPassword }) });
    storageSet("session", CANTEEN_SESSION_KEY, newPassword);
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
      if (!IS_NETLIFY_HOSTED && user?.role === "DEMO_CANTEEN") {
        const receivedAt = new Date().toISOString();
        const updated = { ...order, payment_status: "PAID", cash_received_at: receivedAt };
        writeLocalOrderQueue(readLocalOrderQueue().map((entry) => String(entry.id) === orderId ? updated : entry));
        queueRevisionRef.current += 1;
        setQueue((current) => current.filter((entry) => String(entry.id) !== orderId));
        setToast(`Cash received for order ${order.pickup_code}.`);
        return;
      }
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
    if (user?.source === "supabase") {
      try { await signOutOfSupabase(); setUser(null); setOrders([]); setCsrf(""); setToast("You are signed out."); }
      catch (error) { setToast(error instanceof Error ? error.message : "Sign out failed."); }
      return;
    }
    const demoUser = user?.role.startsWith("DEMO_") ?? false;
    const hasStationSession = Boolean(storageGet("session", CANTEEN_SESSION_KEY) || storageGet("session", CANTEEN_ROLE_KEY));
    if (demoUser) storageRemove("local", DEMO_USER_KEY);
    if (demoUser || (!user && hasStationSession)) {
      storageRemove("session", CANTEEN_SESSION_KEY);
      storageRemove("session", CANTEEN_USERNAME_KEY);
      storageRemove("session", CANTEEN_ROLE_KEY);
      setCanteenPassword(""); setCanteenUsername(""); setCanteenStation("order_manager"); setQueue([]);
      setUser(null); setCsrf(""); setToast("You are signed out."); return;
    }
    if (hasStationSession) {
      storageRemove("session", CANTEEN_SESSION_KEY);
      storageRemove("session", CANTEEN_USERNAME_KEY);
      storageRemove("session", CANTEEN_ROLE_KEY);
      setCanteenPassword(""); setCanteenUsername(""); setCanteenStation("order_manager"); setQueue([]);
    }
    if (!user) { setToast("You are signed out."); return; }
    try { await request("/api/auth/logout", { method: "POST" }); setUser(null); setCsrf(""); setToast("You are signed out."); }
    catch (error) { setToast(error instanceof Error ? error.message : "Sign out failed."); }
  }
  async function lookupStationStudent(student_id: string, station: "cashier" | "order_taker") {
    return request<{ student_id: string; full_name: string }>(SHARED_DATA_URL, {
      method: "POST",
      body: JSON.stringify({ action: "lookup-student", student_id, station }),
    });
  }
  async function lookupCounterStudent(student_id: string) {
    if (!IS_NETLIFY_HOSTED) {
      const full_name = localStudentDirectoryName(student_id);
      return { student_id, full_name, source: full_name ? "counter" as const : "missing" as const, profile_exists: false };
    }
    return request<StudentLookup>(SHARED_DATA_URL, {
      method: "POST",
      body: JSON.stringify({ action: "lookup-student", student_id, station: "order_taker" }),
    });
  }
  async function saveCounterStudentDirectoryName(student_id: string, full_name: string) {
    if (!IS_NETLIFY_HOSTED) {
      const directory = readLocalCounterStudentDirectory();
      directory[student_id] = full_name.trim().replace(/\s+/g, " ");
      if (!storageSet("local", LOCAL_COUNTER_STUDENT_DIRECTORY_KEY, JSON.stringify(directory))) throw new Error("This browser could not save the local student directory.");
      return { student_id, full_name: directory[student_id], source: "counter" as const, profile_exists: false };
    }
    return request<StudentLookup>(SHARED_DATA_URL, {
      method: "POST",
      body: JSON.stringify({ action: "save-counter-student-name", student_id, full_name }),
    });
  }
  async function cashWalletTopUp(form: HTMLFormElement): Promise<boolean> {
    const data = new FormData(form);
    const student_id = String(data.get("student_id") ?? "").trim();
    const amount = Number(data.get("amount"));
    const note = String(data.get("note") ?? "").trim();
    if (!/^\d{7}$/.test(student_id)) { setWalletMessage("Enter the student’s 7-digit Cedar ID."); return false; }
    if (data.get("student_confirmed") !== "on") { setWalletMessage("Check the student’s name and confirm before adding credit."); return false; }
    if (!Number.isFinite(amount) || amount < 50 || amount > 5000) { setWalletMessage("Enter a cash amount from Rs 50 to Rs 5,000."); return false; }
    if (user?.role === "DEMO_CANTEEN" && canteenStation === "cashier") {
      if (cashTopUpPending) return false;
      const signature = `${student_id}:${Math.round(amount * 100)}:${note}`;
      if (!cashTopUpRequest.current || cashTopUpRequest.current.signature !== signature) cashTopUpRequest.current = { signature, key: crypto.randomUUID() };
      setWalletMessage("Recording cash received…");
      setCashTopUpPending(true);
      try {
        const result = await request<{ student_id: string; full_name: string; balance_paisa: number }>(SHARED_DATA_URL, {
          method: "POST",
          body: JSON.stringify({ action: "cash-topup", student_id, amount_paisa: Math.round(amount * 100), note, idempotency_key: cashTopUpRequest.current.key }),
        });
        setWalletMessage(`Added ${money(Math.round(amount * 100))} for ${result.full_name} · ${result.student_id}. New balance: ${money(result.balance_paisa)}.`);
        cashTopUpRequest.current = null;
        form.reset();
        void loadWalletTopUpHistory();
        return true;
      } catch (error) { setWalletMessage(error instanceof Error ? error.message : "Cash top-up was not recorded."); return false; }
      finally { setCashTopUpPending(false); }
    }
    if (user?.role === "DEMO_CANTEEN") {
      const email = `${student_id}@cedar.edu.pk`;
      const amount_paisa = Math.round(amount * 100);
      try {
        const previous = JSON.parse(storageGet("local", walletKey(email)) || "null") as { balance?: number; entries?: WalletEntry[] } | null;
        const entry: WalletEntry = { id: crypto.randomUUID(), label: note || "Cash top-up at canteen counter", amount: amount_paisa, kind: "credit", created_at: new Date().toISOString(), method: "Cash at counter" };
        const entries = Array.isArray(previous?.entries) ? previous.entries : [];
        const balance = (Number(previous?.balance) || 0) + amount_paisa;
        storageSet("local", walletKey(email), JSON.stringify({ balance, entries: [entry, ...entries] }));
        setWalletMessage(`Added ${money(amount_paisa)} for student ${student_id}. Browser-only balance: ${money(balance)}. Sign in as that student in this same browser to view it.`);
        form.reset();
        return true;
      } catch {
        setWalletMessage("Could not save the browser-only top-up. Check that this browser allows site storage.");
        return false;
      }
    }
    if (cashTopUpPending) return false;
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
      return true;
    } catch (error) { setWalletMessage(error instanceof Error ? error.message : "Cash top-up was not recorded."); return false; }
    finally { setCashTopUpPending(false); }
  }
  function addToCart(id: number, amount = 1, withAddon = false, optionId?: string) { const key = makeCartLineKey(id, optionId, withAddon); setCart((current) => { const next = { ...current, [key]: Math.min(20, Math.max(0, (current[key] ?? 0) + amount)) }; if (!next[key]) delete next[key]; return next; }); if (amount > 0 && sellableItems.find((item) => item.id === id)?.scheduled_allowed && !sellableItems.find((item) => item.id === id)?.quick_allowed) setSelectedWindow(""); }
  function continueAddingItem(item: Item, optionId?: string) { setPendingOptionId(optionId); if (item.addon_name?.trim()) { setAddOnPromptItem(item); return; } addToCart(item.id, 1, false, optionId); setCartOpen(true); }
  function requestAddToCart(item: Item) { if (item.options?.length) { setOptionPromptItem(item); return; } continueAddingItem(item); }
  function saveWallet(balance: number, entries: WalletEntry[]) { if (user?.email) storageSet("local", walletKey(user.email), JSON.stringify({ balance, entries })); setWalletBalance(balance); setWalletEntries(entries); }
  async function demoTopUp() {
    const amount = Math.round(Number(topUpAmount) * 100);
    if (user?.role !== "DEMO_STUDENT") { setToast("Sign in with your Cedar email to use the wallet."); return; }
    if (topUpSubmitting) return;
    if (!Number.isFinite(amount) || amount < 10000 || amount > 500000) { setToast("Choose a top-up amount between Rs 100 and Rs 5,000."); return; }
    const student_id = user.student_id;
    if (!student_id || !/^\d{7}$/.test(student_id)) { setToast("Use a Cedar email with a 7-digit student ID before topping up your wallet."); return; }
    setTopUpSubmitting(true);
    try {
      const walletEntry: WalletEntry = { id: crypto.randomUUID(), label: "Wallet top-up", amount, kind: "credit", created_at: new Date().toISOString(), method: `${topUpMethod} · unverified` };
      saveWallet(walletBalance + amount, [walletEntry, ...walletEntries]);
      setWalletOpen(false);
      setToast(`Local preview balance updated by ${money(amount)}. No payment was received.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The wallet top-up could not be recorded.");
    } finally {
      setTopUpSubmitting(false);
    }
  }
  async function placeOrder() {
    if (orderSubmittingRef.current) return;
    if (!user || !canOrder) { setToast("Sign in with a Cedar email to place an order."); return; }
    if (!cartCount) return;
    if ((!isCanteenOpenNow() && !temporaryOpening) || orderingManagerPaused) { setShowOrderingPausedPopup(true); return; }
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
      const { itemId, optionId, withAddon } = readCartLineKey(key);
      const item = sellableItems.find((candidate) => candidate.id === itemId);
      const addon_selected = withAddon;
      if (!item) return [];
      const option = item.options?.find((entry) => entry.id === optionId);
      if (item.options?.length && (!option || !option.available)) return [];
      if (!item.options?.length && optionId) return [];
      const addonPrice = addon_selected ? item.addon_price_paisa ?? 0 : 0;
      return [{ item_id: item.id, ...(option ? { option_id: option.id } : {}), name: `${item.name.replace("[DEV SAMPLE] ", "")}${option ? ` · ${option.name}` : ""}`, quantity, addon_selected, unit_price_paisa: item.price_paisa + addonPrice }];
    });
    if (!cartEntries.length || orderItems.length !== cartEntries.length || orderItems.some((item) => !Number.isSafeInteger(item.item_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 || item.name.length > 120)) {
      const currentItemIds = new Set(sellableItems.map((item) => String(item.id)));
      setCart((current) => Object.fromEntries(Object.entries(current).filter(([key, quantity]) => currentItemIds.has(String(readCartLineKey(key).itemId)) && quantity > 0)));
      setOrderError("Your bucket had an item that is no longer on the current menu. It has been removed; please review the items and try again.");
      return;
    }
    const pendingEmail = user.email.trim().toLowerCase();
    const pendingKey = pendingOrderStorageKey(pendingEmail);
    const pendingAttempt = pendingOrderAttemptRef.current?.email === pendingEmail
      ? pendingOrderAttemptRef.current.attempt
      : readPendingOrderAttempt(pendingEmail);
    if (paymentMethod === "wallet" && !pendingAttempt && walletBalance < cartTotal) { setToast("Your wallet balance is too low. Add wallet balance to continue."); setWalletOpen(true); return; }
    let pickupCode = "";
    do { pickupCode = `CB${crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`; } while (orders.some((existing) => existing.pickup_code === pickupCode));
    const draftOrder: Order = { id: crypto.randomUUID(), status: "SUBMITTED", mode: orderMode === "quick" ? "QUICK" : "SCHEDULED", student_id: user.student_id, payment_method: paymentMethod, total_paisa: cartTotal, total_display: money(cartTotal), pickup_code: pickupCode, created_at: new Date().toISOString(), pickup_window: selectedPickupWindow ? { start_at: selectedPickupWindow.start_at, end_at: selectedPickupWindow.end_at } : null, items: orderItems, waiting_minutes: 0 };
    const draftSignature = orderAttemptSignature(draftOrder);
    if (pendingAttempt && pendingAttempt.signature !== draftSignature) {
      setOrderError("A previous order attempt is still being checked. Review My Orders before placing a different order.");
      return;
    }
    const attempt = pendingAttempt ?? { order: draftOrder, signature: draftSignature };
    askForReadyAlertsOnOrder();
    orderSubmittingRef.current = true;
    setOrderSubmitting(true);
    setOrderError("");
    setToast("");
    if (!pendingAttempt) storageSet("local", pendingKey, JSON.stringify(attempt));
    pendingOrderAttemptRef.current = { email: pendingEmail, attempt };
    try {
      const confirmedOrder = await submitStudentOrder(attempt.order);
      if (!confirmedOrder?.pickup_code) throw new Error("The canteen did not confirm this order. Your bucket is still here; check My Orders before trying again.");
      storageRemove("local", pendingKey);
      pendingOrderAttemptRef.current = null;
      if (confirmedOrder.payment_method === "wallet" && user.role === "DEMO_STUDENT") {
        const paidAmount = confirmedOrder.total_paisa ?? cartTotal;
        const entry = { id: crypto.randomUUID(), label: "Order payment", amount: paidAmount, kind: "debit" as const, created_at: new Date().toISOString(), method: "CedarBite wallet" };
        saveWallet(walletBalance - paidAmount, [entry, ...walletEntries]);
      }
      const nextOrders = [confirmedOrder, ...orders.filter((existing) => existing.id !== confirmedOrder.id)];
      storageSet("local", demoOrdersKey(user.email), JSON.stringify(nextOrders));
      setOrders(nextOrders);
      setQueue((current) => [confirmedOrder, ...current.filter((existing) => existing.id !== confirmedOrder.id)]);
      setOrderConfirmation(confirmedOrder);
      if (attempt.signature === draftSignature) setCart({});
      setCartOpen(false);
      setShowOrderConfirmation(true);
      if (confirmedOrder.payment_method === "wallet" && user.role !== "DEMO_STUDENT") void loadWallet();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not send this order to the canteen. Your bucket is unchanged.";
      const status = error instanceof Error ? Number((error as Error & { status?: unknown }).status) : 0;
      const uncertain = error instanceof OrderSubmissionUncertainError || error instanceof TypeError || status === 401 || status === 403 || status >= 500;
      if (!uncertain) {
        storageRemove("local", pendingKey);
        if (pendingOrderAttemptRef.current?.email === pendingEmail) pendingOrderAttemptRef.current = null;
      }
      if (message === "We are currently not accepting orders." || message === "Online ordering is paused by the canteen.") {
        setShowOrderingPausedPopup(true);
        setOrderError("");
        return;
      }
      setOrderError(message);
    }
    finally { orderSubmittingRef.current = false; setOrderSubmitting(false); }
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
      if (user?.role !== "DEMO_CANTEEN") void loadMenu(true);
    }
  }
  async function changePrice(item: Item, form: HTMLFormElement) {
    const price = Number(new FormData(form).get("price"));
    if (!Number.isFinite(price) || price < 0) { setToast("Enter a valid price."); return; }
    if (user?.role === "DEMO_CANTEEN") {
      const price_paisa = Math.round(price * 100);
      try { await saveMenuChange({ action: "set-price", item_id: item.id, price_paisa }); setToast(`Price updated for ${item.name}.`); }
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
      try {
        await saveMenuChange({ action: "remove-menu-item", item_id: item.id });
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

  // Staff menu changes go through the shared-data function, which checks the station
  // password and saves to Supabase. Each change is small and specific (one price, one item,
  // one category) so a screen showing an older menu cannot undo someone else's change.
  async function saveMenuChange(change: Record<string, unknown>) {
    if (menuMutationInFlightRef.current) throw new Error("A menu change is already saving. Wait for it to finish, then try again.");
    menuMutationInFlightRef.current = true;
    setMenuMutationPending(true);
    try {
      const result = await request<{ categories: Category[] }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify(change) });
      setCategories(result.categories);
      cacheDemoMenu(result.categories);
      return result.categories;
    } finally {
      menuMutationInFlightRef.current = false;
      setMenuMutationPending(false);
    }
  }
  // Reordering only: the server saves the new order of categories and items.
  const saveDemoMenu = (nextCategories: Category[]) => saveMenuChange({ action: "set-menu", categories: nextCategories });
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
      try { await saveMenuChange({ action: "add-category", name }); form.reset(); setToast(`Category ${name} added.`); }
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
      await saveMenuChange({ action: "remove-category", category_id: current.id, target_category_id: target?.id ?? null });
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
      let options: MenuOption[];
      try { options = readMenuOptions(data.get("options_json")); } catch (error) { setItemMessage(error instanceof Error ? error.message : "Check the item choices."); return; }
      if (!categories.some((category) => category.id === category_id)) { setItemMessage("Choose a valid menu category."); return; }
      if (!name || !Number.isFinite(price) || price < 0 || (!quick_allowed && !scheduled_allowed)) { setItemMessage("Enter a name and valid price, then choose at least one pickup type."); return; }
      const addonInputName = String(data.get("addon_name") ?? "").trim();
      const addonInputPrice = Number(data.get("addon_price") || 0);
      if (addonInputName && (!Number.isFinite(addonInputPrice) || addonInputPrice < 0)) { setItemMessage("Enter a valid non-negative price for the optional add-on."); return; }
      const price_paisa = Math.round(price * 100);
      const prepValue = String(data.get("prep_minutes") ?? "").trim();
      const addon_name = String(data.get("addon_name") ?? "").trim() || null;
      const addon_price_paisa = addon_name ? Math.round(Number(data.get("addon_price") || 0) * 100) : 0;
      const newItem = { category_id, name, description, price_paisa, addon_name, addon_price_paisa, options, quick_allowed, scheduled_allowed, prep_minutes: prepValue ? Number(prepValue) : null, image_data };
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
      let options: MenuOption[];
      try { options = readMenuOptions(data.get("options_json")); } catch (error) { setItemMessage(error instanceof Error ? error.message : "Check the item choices."); return; }
      await request("/api/menu/items", { method: "POST", body: JSON.stringify({ category_id: Number(data.get("category_id")), name: String(data.get("name")), description: String(data.get("description")), price_paisa: Math.round(Number(data.get("price")) * 100), quick_allowed: data.get("quick") === "on", scheduled_allowed: data.get("scheduled") === "on", prep_minutes: Number(data.get("prep_minutes")) || null, image_data: String(data.get("image_data") ?? "") || null, addon_name: String(data.get("addon_name") ?? "").trim() || null, addon_price_paisa: String(data.get("addon_name") ?? "").trim() ? Math.round(Number(data.get("addon_price") || 0) * 100) : 0, options }) });
      await loadMenu(true); form.reset(); setItemMessage("Added to the canteen menu.");
    } catch (error) { setItemMessage(error instanceof Error ? error.message : "Item was not added."); }
    finally { itemAddInFlightRef.current = false; setItemAddPending(false); }
  }
  async function advanceOrder(order: Order) {
    const next: Record<string, string> = { SUBMITTED: "PREPARING", ACCEPTED: "READY", PREPARING: "READY", READY: "COLLECTED" };
    const nextStatus = order.status === "SUBMITTED" && order.mode === "QUICK" ? "READY" : next[order.status];
    if (!nextStatus) return;
    const orderId = String(order.id);
    if (queueMutationPendingRef.current.has(orderId)) return;
    queueMutationPendingRef.current.add(orderId);
    queueRevisionRef.current += 1;
    setQueuePendingIds((current) => [...new Set([...current, orderId])]);
    try {
      if (user?.role === "DEMO_CANTEEN") {
        if (!IS_NETLIFY_HOSTED) {
          const localOrders = readLocalOrderQueue();
          const updated = localOrders.find((entry) => String(entry.id) === orderId);
          if (!updated || updated.status !== order.status) throw new Error("This order changed. Refresh the queue and try again.");
          const changedAt = new Date().toISOString();
          const saved = { ...updated, status: nextStatus, ...(nextStatus === "READY" ? { ready_at: changedAt } : {}), ...(nextStatus === "COLLECTED" ? { completed_at: changedAt, ...(updated.payment_method === "cash" ? { payment_status: "PAID", cash_received_at: changedAt } : {}) } : {}) };
          writeLocalOrderQueue(localOrders.map((entry) => String(entry.id) === orderId ? saved : entry));
          queueRevisionRef.current += 1;
          setQueue((current) => saved.status === "COLLECTED" ? current.filter((entry) => String(entry.id) !== orderId) : [saved, ...current.filter((entry) => String(entry.id) !== orderId)]);
          if (saved.status === "COLLECTED") setOrderHistory((current) => [saved, ...current.filter((entry) => String(entry.id) !== orderId)].slice(0, 100));
          setToast(`Order ${order.pickup_code} updated.`);
          return;
        }
        const result = await request<{ order: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-status", order_id: orderId, status: nextStatus }) });
        if (!result.order || result.order.status !== nextStatus) throw new Error("The canteen did not confirm this order update.");
        queueRevisionRef.current += 1;
        setQueue((current) => result.order.status === "COLLECTED" ? current.filter((entry) => String(entry.id) !== orderId) : [result.order, ...current.filter((entry) => String(entry.id) !== orderId)]);
        if (result.order.status === "COLLECTED") setOrderHistory((current) => [result.order, ...current.filter((entry) => String(entry.id) !== orderId)].slice(0, 100));
        setToast(`Order ${order.pickup_code} updated.`);
        return;
      }
      const result = await request<Order & { order?: Order }>(`/api/orders/${order.id}/status`, { method: "POST", body: JSON.stringify({ to: nextStatus }) });
      const savedOrder = result.order ?? (result.id != null ? result : undefined);
      if (!savedOrder || savedOrder.status !== nextStatus) throw new Error("The canteen did not confirm this order update.");
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
      if (nextStatus === "COLLECTED") void loadOrderHistory();
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
      setToast(`Order ${order.pickup_code} was removed from the queue and kept in the audit history.`);
      void loadOrderHistory();
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
    if (!window.confirm(`Remove order ${order.pickup_code} from the regular history view? Its record will remain in the audit history and can be restored.`)) return;
    const orderId = String(order.id);
    if (queueMutationPendingRef.current.has(orderId)) return;
    queueMutationPendingRef.current.add(orderId);
    setQueuePendingIds((current) => [...new Set([...current, orderId])]);
    try {
      const result = await request<{ order: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "delete-history-order", order_id: orderId }) });
      setOrderHistory((current) => current.map((entry) => String(entry.id) === orderId ? result.order : entry));
      setToast(`Order ${order.pickup_code} was voided. Its audit record remains available to restore.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Order was not removed from history.");
    } finally {
      queueMutationPendingRef.current.delete(orderId);
      setQueuePendingIds((current) => current.filter((id) => id !== orderId));
      void loadOrderHistory();
    }
  }
  async function restoreHistoryOrder(order: Order) {
    if (user?.role !== "DEMO_CANTEEN" || canteenStation !== "order_manager" || order.status !== "VOIDED") return;
    const orderId = String(order.id);
    if (queueMutationPendingRef.current.has(orderId)) return;
    queueMutationPendingRef.current.add(orderId);
    setQueuePendingIds((current) => [...new Set([...current, orderId])]);
    try {
      const result = await request<{ order: Order }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "restore-order", order_id: orderId }) });
      if (result.order.status === "SUBMITTED") {
        setOrderHistory((current) => current.filter((entry) => String(entry.id) !== orderId));
        setQueue((current) => [result.order, ...current.filter((entry) => String(entry.id) !== orderId)]);
      } else {
        setOrderHistory((current) => current.map((entry) => String(entry.id) === orderId ? result.order : entry));
      }
      setToast(`Order ${order.pickup_code} was restored to ${human(result.order.status).toLowerCase()}.`);
    } catch (error) { setToast(error instanceof Error ? error.message : "The order could not be restored."); }
    finally {
      queueMutationPendingRef.current.delete(orderId);
      setQueuePendingIds((current) => current.filter((id) => id !== orderId));
      void loadQueue();
      void loadOrderHistory();
    }
  }
  async function refundHistoryOrder(order: Order) {
    if (user?.role !== "DEMO_CANTEEN" || !["order_manager", "cashier"].includes(canteenStation) || order.refund_status === "REFUNDED") return;
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
      if (!IS_NETLIFY_HOSTED) {
        const refundedAt = new Date().toISOString();
        const updated = { ...order, refund_status: "REFUNDED", refund_method: isWallet ? "wallet" : "manual", refunded_at: refundedAt, refunded_by: canteenStation, refund_amount_paisa: order.total_paisa ?? 0 };
        writeLocalOrderQueue(readLocalOrderQueue().map((entry) => String(entry.id) === orderId ? updated : entry));
        setOrderHistory((current) => current.map((entry) => String(entry.id) === orderId ? updated : entry));
        if (isWallet && user.email) {
          const refundAmount = order.total_paisa ?? 0;
          const entry = { id: crypto.randomUUID(), label: `Refund · ${order.pickup_code}`, amount: refundAmount, kind: "credit" as const, created_at: refundedAt, method: "CedarBite wallet refund" };
          saveWallet(walletBalance + refundAmount, [entry, ...walletEntries]);
        }
        setToast(isWallet ? `Refund recorded for ${order.pickup_code}.` : `Manual refund recorded for ${order.pickup_code}.`);
        return;
      }
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
    const paused = !orderingManagerPaused;
    try {
      if (user?.role === "DEMO_CANTEEN") await request(`${SHARED_DATA_URL}`, { method: "POST", body: JSON.stringify({ action: "set-ordering", paused }) });
      else await request("/api/ordering/pause", { method: "POST", body: JSON.stringify({ paused }) });
      setOrderingManagerPaused(paused);
      setOrderingReason(paused ? "Online ordering is paused by the canteen." : operationCurrentlyOpen ? "Ordering is open" : "Closed · opens at 8:00 AM");
    }
    catch (error) { setToast(error instanceof Error ? error.message : "Ordering status was not changed."); }
  }
  async function toggleTemporaryOpening(enabled: boolean) {
    setTemporaryOpeningPending(true);
    try {
      const result = await request<{ temporary_open: boolean; temporary_open_expires_at: string | null }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-temporary-opening", enabled }) });
      setTemporaryOpening(result.temporary_open);
      setTemporaryOpeningExpiresAt(result.temporary_open_expires_at);
      await loadOrderingStatus();
      setToast(enabled ? "Canteen opened temporarily. All interfaces are active." : "Temporary opening ended.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The temporary opening setting could not be changed.");
    } finally { setTemporaryOpeningPending(false); }
  }
  async function saveItemOfDaySchedule(schedule: ItemOfDayEntry[]) {
    setItemOfDayPending(true);
    setItemOfDayMessage("");
    try {
      if (!IS_NETLIFY_HOSTED && user?.role === "DEMO_CANTEEN") {
        if (schedule.length > 20) throw new Error("Keep no more than 20 specials in the Item of the day list.");
        storageSet("local", "cedarbite-demo-item-of-day", JSON.stringify(schedule));
        setItemOfDaySchedule(schedule);
        setItemOfDayMessage("Item of the day schedule saved in this browser.");
        return;
      }
      const result = await request<{ schedule: ItemOfDayEntry[] }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-item-of-day", schedule }) });
      setItemOfDaySchedule(result.schedule);
      setItemOfDayMessage("Item of the day schedule saved and shared with the student and counter menus.");
    } catch (error) { setItemOfDayMessage(error instanceof Error ? error.message : "The schedule could not be saved."); }
    finally { setItemOfDayPending(false); }
  }

  async function saveHeroSlides(nextSlides: HeroSlide[]) {
    setHeroSlidesPending(true);
    setHeroSlidesMessage("");
    try {
      if (!IS_NETLIFY_HOSTED) {
        storageSet("local", "cedarbite-homepage-hero-slides", JSON.stringify(nextSlides));
        setHeroSlides(nextSlides);
        setHeroSlidesLoaded(true);
        setHeroSlideIndex(0);
        setHeroSlidesMessage("Banner slides saved in this browser.");
        return;
      }
      const result = await request<{ slides: HeroSlide[] }>(SHARED_DATA_URL, { method: "POST", body: JSON.stringify({ action: "set-hero-slides", slides: nextSlides }) });
      setHeroSlides(result.slides);
      setHeroSlidesLoaded(true);
      setHeroSlideIndex(0);
      setHeroSlidesMessage("Banner slides saved. They’re now shared on the student dashboard.");
    } catch (error) {
      setHeroSlidesMessage(error instanceof Error ? error.message : "Banner slides could not be saved.");
    } finally { setHeroSlidesPending(false); }
  }

  if (page === "menu" && !menuReady) return <AppLoadingScreen/>;
  if (page === "stations") return <StationDirectory onNavigate={(next) => navigate(next)} onBack={() => navigate("menu")} darkMode={darkMode} onToggleTheme={() => setDarkMode((dark) => !dark)}/>;
  if (page === "counter") return !menuReady ? <AppLoadingScreen/> : <CounterStation user={user} categories={counterCategories} items={counterItems} pending={orderSubmitting} darkMode={darkMode} onToggleTheme={() => setDarkMode((dark) => !dark)} onSignIn={(username, password) => demoStaffSignIn(username, password, "order_taker")} onSignOut={() => void signOut()} onReturnToActive={returnToActiveStation} onChangePassword={changeStaffPassword} onLookupStudent={lookupCounterStudent} onSaveStudentName={saveCounterStudentDirectoryName} onCreate={async (customer, lines) => {
    if (!lines.length) throw new Error("Add at least one menu item.");
    const total = lines.reduce((sum, line) => {
      const item = counterItems.find((entry) => entry.id === line.item_id);
      if (!item) return sum;
      return sum + (item.price_paisa + (line.addon_selected ? item.addon_price_paisa ?? 0 : 0)) * line.quantity;
    }, 0);
    const pickupCode = `CB${createUuid().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const order = { id: createUuid(), pickup_code: pickupCode, mode: "QUICK", ...customer, total_display: money(total), pickup_window: null, payment_method: "cash", items: lines.map((line) => { const item = counterItems.find((entry) => entry.id === line.item_id)!; const option = item.options?.find((entry) => entry.id === line.option_id); const addon_selected = Boolean(line.addon_selected && item.addon_name); const unit_price_paisa = item.price_paisa + (addon_selected ? item.addon_price_paisa ?? 0 : 0); return { item_id: item.id, ...(option ? { option_id: option.id } : {}), name: `${item.name}${option ? ` · ${option.name}` : ""}`, quantity: line.quantity, addon_selected, unit_price_paisa }; }) };
    return submitCounterOrder(order);
  }}/>
  if (["owner", "order-manager", "cashdesk", "developer"].includes(page)) return page !== "developer" && page !== "cashdesk" && !menuReady ? <AppLoadingScreen/> : <OwnerApp station={page === "developer" ? "developer" : page === "cashdesk" ? "cashier" : "order_manager"} user={user} googleReady={googleReady} categories={categories} items={items} queue={queue} orderHistory={orderHistory} salesSummary={salesSummary} salesSummaryDates={salesSummaryDates} salesSummaryError={salesSummaryError} salesSummaryLoading={salesSummaryLoading} onLoadSalesSummary={loadSalesSummary} onLoadSalesDates={() => void loadSalesSummaryDates()} onDeleteSalesSummary={deleteSalesSummary} monthlySalesSummary={monthlySalesSummary} monthlySalesMonths={monthlySalesMonths} monthlySalesError={monthlySalesError} monthlySalesLoading={monthlySalesLoading} onLoadMonthlySalesMonths={() => void loadMonthlySalesMonths()} onLoadMonthlySalesSummary={loadMonthlySalesSummary} walletTopUpHistory={walletTopUpHistory} walletHistoryError={walletHistoryError} walletHistoryLoading={walletHistoryLoading} onLoadHistory={() => void loadOrderHistory()} onLoadWalletTopUpHistory={() => void loadWalletTopUpHistory()} queuePendingIds={queuePendingIds} itemOfDaySchedule={itemOfDaySchedule} itemOfDayMessage={itemOfDayMessage} itemOfDayPending={itemOfDayPending} onSaveItemOfDaySchedule={saveItemOfDaySchedule} heroSlides={heroSlides} heroSlidesMessage={heroSlidesMessage} heroSlidesPending={heroSlidesPending} onSaveHeroSlides={saveHeroSlides} darkMode={darkMode} onToggleTheme={() => setDarkMode((dark) => !dark)} canManage={canManage} canSortMenu={user?.role === "DEMO_CANTEEN"} onReorderMenuItems={reorderMenuItems} onReorderMenuCategories={reorderMenuCategories} canToggle={canToggle} availabilityPending={availabilityPending} menuMutationPending={menuMutationPending} itemAddPending={itemAddPending} canQueue={canQueue} canTopUp={user?.permissions.includes("wallet.cash_topup") ?? false} walletMessage={walletMessage} walletPending={cashTopUpPending} onCashTopUp={cashWalletTopUp} onLookupStudent={(id) => lookupStationStudent(id, "cashier")} itemMessage={itemMessage} onSignIn={startSignIn} onDemoStaff={(username, password, station) => demoStaffSignIn(username, password, station)} onSignOut={() => void signOut()} onReturnToActive={returnToActiveStation} onBack={() => navigate("menu")} onToggle={toggleAvailability} onPrice={(item, form) => void changePrice(item, form)} onAddCategory={(form) => void addCategory(form)} onRemoveCategory={removeCategory} onAddItem={(event) => void addItem(event)} onRemoveItem={removeMenuItem} onUpdateItem={updateMenuItem} onAdvance={(order) => void advanceOrder(order)} onDeleteOrder={(order) => void deleteOrder(order)} onDeleteHistoryOrder={(order) => void deleteHistoryOrder(order)} onRestoreHistoryOrder={(order) => void restoreHistoryOrder(order)} onRefundHistoryOrder={(order) => void refundHistoryOrder(order)} onMarkCashPaid={markCashPaid} onChangePassword={changeStaffPassword} onResetPassword={resetStaffPassword} onToggleOrdering={() => void toggleOrdering()} onRefresh={() => { void loadMenu(user?.role !== "DEMO_CANTEEN"); void loadQueue(); void loadOrderHistory(); void loadWalletTopUpHistory(); void loadWallet(); if (user?.role === "DEMO_CANTEEN") void loadSharedAvailability(); }} orderingReason={orderingReason} temporaryOpening={temporaryOpening} temporaryOpeningExpiresAt={temporaryOpeningExpiresAt} temporaryOpeningPending={temporaryOpeningPending} onToggleTemporaryOpening={toggleTemporaryOpening} onExportData={exportDeveloperData} />;
  if (page === "kitchen") return <KitchenStation user={user} queue={queue} pendingIds={queuePendingIds} darkMode={darkMode} onToggleTheme={() => setDarkMode((dark) => !dark)} onSignIn={(username, password) => demoStaffSignIn(username, password, "kitchen")} onSignOut={() => void signOut()} onReturnToActive={returnToActiveStation} onChangePassword={changeStaffPassword}/>;
  if (page === "confirmation") return <main className="order-confirmation-page"><section className="order-confirmation-page-card"><div className="confirmation-check" aria-hidden="true">✓</div><span className="section-kicker">ORDER CONFIRMED</span><h1>Your order was placed successfully.</h1><div className="confirmation-pickup"><small>PICKUP NUMBER</small><strong>{orderConfirmation?.pickup_code ?? "—"}</strong></div><p className="receipt-email-note">{orderConfirmation?.mode === "SCHEDULED" ? "We’ll email your receipt when your scheduled order is ready." : "Your order is ready for collection. Show this pickup number to the canteen staff."}</p><button className="blue-button" onClick={() => navigate("menu")}>← Return to menu</button></section></main>;

  return <div className="storefront">
    <header className={`store-header ${mobileMenuOpen ? "menu-open" : ""}`}>
  <button className="wordmark" onClick={() => navigate("menu")}><CedarMark /><span className="wordmark-lockup"><span className="wordmark-title">Cedar<span>Bite</span></span><small>From the kitchen of Delfrio</small></span></button>
  <button type="button" className="mobile-menu-toggle" aria-controls="store-navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}><span aria-hidden="true">{mobileMenuOpen ? "×" : "☰"}</span>{mobileMenuOpen ? "Close" : "Menu"}</button>
  <div className={`header-menu ${mobileMenuOpen ? "is-open" : ""}`} id="store-navigation">
    <nav className="store-nav" aria-label="Main navigation"><span className="mobile-nav-heading">Explore CedarBite</span><button className={page === "menu" ? "selected" : ""} onClick={() => navigate("menu")}>Menu</button><button className={page === "about" ? "selected" : ""} onClick={() => navigate("about")}>About us</button><button className={page === "contact" ? "selected" : ""} onClick={() => navigate("contact")}>Contact</button>{canSeeOrders && <button className={page === "orders" ? "selected" : ""} onClick={() => navigate("orders")}>My orders</button>}</nav>
    <div className="header-actions"><button className="wallet-header" onClick={() => { setMobileMenuOpen(false); if (user?.role === "DEMO_STUDENT") setWalletOpen(true); else if (user) setToast("The wallet isn't connected yet. It moves to Supabase in a later step."); else loginDialog.current?.showModal(); }}><span>Wallet</span><b>{user?.role === "DEMO_STUDENT" ? money(walletBalance) : user ? "Soon" : "—"}</b></button><button className="basket-header" aria-label={`Open bucket, ${cartCount} items`} onClick={() => { setMobileMenuOpen(false); setCartOpen(true); }}><span className="basket-symbol">▣</span><span>Bucket</span><b>{cartCount}</b></button>{canManage && <button className="owner-entry" onClick={() => navigate("owner")}>Canteen console <span>↗</span></button>}{user ? <button className="sign-button" onClick={() => { setMobileMenuOpen(false); void signOut(); }}>{user.student_id ? `${user.full_name ? `${user.full_name} · ` : ""}ID ${user.student_id}` : user.full_name || human(user.role)} · Sign out</button> : <button className="sign-button" onClick={() => { setMobileMenuOpen(false); loginDialog.current?.showModal(); }}>Login <span>↗</span></button>}<ThemeSwitch darkMode={darkMode} onToggle={() => setDarkMode((dark) => !dark)} className="mobile-menu-theme-toggle"/></div>
  </div>
</header>
    {page === "orders" ? <main className="orders-page"><div className="page-kicker">YOUR CEDARBITE ACCOUNT</div><h1>My orders</h1><p className="page-lead">Orders appear here with their pickup code and progress.</p>{!("Notification" in window && Notification.permission === "granted") && <section className="ready-alert-settings"><div><b>Get an alert when your order is ready</b><p>{readyAlertMessage || (readyAlertState === "on" ? "Ready alerts are on for this device." : readyAlertState === "blocked" ? "Notifications are blocked for CedarBite. Change the permission in browser settings, then tap Try again." : readyAlertState === "unsupported" ? "This browser does not support ready alerts. Check My Orders for updates." : readyAlertState === "install-required" ? "On iPhone or iPad, add CedarBite to your Home Screen to enable notifications." : readyAlertState === "not-configured" ? "Browser alerts are not configured on the live site yet." : "We can notify you on this device when the canteen marks your order ready.")}</p></div>{readyAlertState === "on" ? <button type="button" onClick={() => void disableReadyAlerts()}>Turn off</button> : <button type="button" onClick={() => void enableReadyAlerts()} disabled={readyAlertBusy || readyAlertState === "checking" || readyAlertState === "unsupported" || readyAlertState === "install-required" || readyAlertState === "not-configured" || user?.source !== "supabase"}>{readyAlertBusy ? "Enabling…" : readyAlertState === "checking" ? "Checking…" : readyAlertState === "blocked" ? "Try again" : readyAlertState === "unsupported" ? "Not supported" : readyAlertState === "install-required" ? "Add to Home Screen" : readyAlertState === "not-configured" ? "Not available" : user?.source !== "supabase" ? "Sign in to enable" : "Turn on alerts"}</button>}</section>}{orders.some((order) => order.status === "READY") && <div className="order-ready-banner" role="status"><span className="order-ready-icon" aria-hidden="true">✓</span><div className="order-ready-copy"><b>Your order is ready to collect!</b><p>Show your pickup number to the canteen staff.</p></div></div>}{orders.length ? <div className="order-list">{orders.map((order) => <OrderCard key={order.id} order={order} cancelling={cancellingOrderId === String(order.id)} onCancel={user?.source === "supabase" && order.status === "SUBMITTED" && order.payment_status !== "PAID" ? () => void cancelMyOrder(order) : undefined} />)}</div> : <div className="empty-state"><span>◷</span><h2>No orders yet</h2><p>Choose an item from the menu to see it appear here.</p><button className="blue-button" onClick={() => navigate("menu")}>Browse menu</button></div>}</main> : page === "team" ? <TeamPage/> : page === "about" || page === "privacy" || page === "terms" || page === "contact" ? <InfoPage page={page}/> : <main>
      <section className="unified-order-note"><span className="section-kicker">ONE MENU · PICKUP HANDLED AUTOMATICALLY</span><b>Choose what you want. We’ll guide the pickup.</b><p>Ready items need no time slot. If your bucket includes food that needs preparation, choose its pickup window in the bucket.</p></section>
      {menuReady && heroSlidesLoaded && <HeroCarousel slides={heroSlides} index={heroSlideIndex} onIndexChange={setHeroSlideIndex} onPause={() => setHeroPaused(true)} onResume={() => setHeroPaused(false)}/>}
<section className="menu-area" id="menu"><div className="menu-intro"><div><span className="section-kicker">THE CANTEEN MENU</span><h2>Find your <span>favourite.</span></h2></div><div className="menu-live"><i className="live-dot"/> Menu availability from canteen service</div></div><ItemOfDaySpotlight schedule={itemOfDaySchedule} now={new Date(scheduleClock)} onAdd={requestAddToCart} canOrder={quickOrdersOpen} /><div className="menu-layout"><nav className="category-sidebar" aria-label="Menu categories"><button type="button" className={categoryFilter === "All" ? "active" : ""} aria-current={categoryFilter === "All" ? "location" : undefined} onClick={() => { setCategoryFilter("All"); document.getElementById("menu")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>All items</button>{menuReady && availableModeCategories.map((category) => <button type="button" className={categoryFilter === category.name ? "active" : ""} aria-current={categoryFilter === category.name ? "location" : undefined} key={category.id} onClick={() => { setCategoryFilter(category.name); document.getElementById("menu-category-" + category.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{category.name}</button>)}</nav><div className="menu-results">{}
       {menuError ? <div className="empty-state error-state"><h2>Menu didn’t load</h2><p>{menuError}</p></div> : <>{!availableModeCategories.length ? <div className="empty-state"><span>🍽️</span><h2>Menu being prepared</h2><p>Menu items will appear here when they are available.</p></div> : availableModeCategories.map((category) => <div className="menu-category" id={"menu-category-" + category.id} data-category-id={category.id} key={category.id}><div className="category-title"><h3>{category.name}</h3><span>{category.items.length} items</span></div><div className="food-grid">{category.items.map((item, index) => <FoodCard key={item.id} item={item} index={index} canOrder={quickOrdersOpen} onAdd={() => requestAddToCart(item)} />)}</div></div>)}</>}</div></div></section>
      <section className="how-it-works"><div><span className="section-kicker">ONE MENU, ONE BUCKET</span><h2>Pickup, <span>made simple.</span></h2><p className="section-subcopy">Browse everything in one place. CedarBite adds pickup details only when your order needs them.</p></div><div className="ordering-modes"><article><span className="mode-icon">✓</span><div><small>READY ITEMS</small><h3>Collect when ready</h3><p>Ready-to-sell items go straight into your bucket without asking you to choose an order type.</p></div></article><article><span className="mode-icon blue">◷</span><div><small>PREPARED FOOD</small><h3>Choose a pickup time</h3><p>If your bucket includes food that needs preparation, its available pickup windows appear in the bucket.</p></div></article></div></section>      <section className="payment-note"><div className="payment-note-copy"><span className="section-kicker">SIMPLE WAYS TO PAY</span><h2>Choose how <span>to pay.</span></h2><p>Pay online, use your CedarBite wallet, or pay in cash when you collect your order.</p><button className="blue-button" onClick={() => user?.role === "DEMO_STUDENT" ? setWalletOpen(true) : user ? setToast("The wallet isn't connected yet. It moves to Supabase in a later step.") : loginDialog.current?.showModal()}>Open wallet <span>→</span></button></div><div className="payment-options" aria-label="Payment options"><article><div><b>Online Payment</b><small>Pay securely online</small></div></article><article><div><b>Wallet Top-up</b><small>Add balance to your wallet</small></div></article><article><div><b>Cash at pickup</b><small>Pay when you collect</small></div></article></div></section>
    </main>}
    <footer className="store-footer"><div className="footer-main"><div><button className="wordmark footer-mark" onClick={() => navigate("menu")}><CedarMark/><span>Cedar<span>Bite</span></span></button><p>Queue · Order · Enjoy</p></div><div><b>Explore</b><button onClick={() => navigate("menu")}>Menu</button><button onClick={() => navigate("about")}>About us</button><button onClick={() => navigate("stations")}>Staff stations</button></div><div><b>Help & information</b><button onClick={() => navigate("contact")}>Contact us</button><button onClick={() => navigate("privacy")}>Privacy policy</button><button onClick={() => navigate("terms")}>Terms and conditions</button></div><div><b>Team behind CedarBite</b><button className="team-footer-link" onClick={() => navigate("team")}>Meet the team <span aria-hidden="true">↗</span></button></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} CedarBite. All rights reserved.</span></div></footer>
    {showOrderingPausedPopup && <div className="addon-prompt-scrim" onClick={() => setShowOrderingPausedPopup(false)}><section className="addon-prompt ordering-paused-popup" role="dialog" aria-modal="true" aria-labelledby="ordering-paused-title" onClick={(event) => event.stopPropagation()}><span className="section-kicker">ORDERING UPDATE</span><h2 id="ordering-paused-title">We are currently not accepting orders.</h2><button type="button" className="blue-button" autoFocus onClick={() => setShowOrderingPausedPopup(false)}>Close</button></section></div>}
    {optionPromptItem && <div className="addon-prompt-scrim" onClick={() => setOptionPromptItem(null)}><section className="addon-prompt option-prompt" role="dialog" aria-modal="true" aria-labelledby="option-prompt-title" onClick={(event) => event.stopPropagation()}><span className="section-kicker">CHOOSE ONE</span><h2 id="option-prompt-title">Choose {optionPromptItem.name}</h2><p>Select one available choice before adding this item to your bucket.</p><div className="option-prompt-list">{(optionPromptItem.options ?? []).map((option) => <button type="button" key={option.id} disabled={!option.available} onClick={() => { const selectedItem = optionPromptItem; setOptionPromptItem(null); continueAddingItem(selectedItem, option.id); }}><span>{option.name}</span><b>{option.available ? "Select" : "Out of stock"}</b></button>)}</div><button type="button" className="addon-prompt-cancel" onClick={() => setOptionPromptItem(null)}>Cancel</button></section></div>}
    {addOnPromptItem && <div className="addon-prompt-scrim" onClick={() => setAddOnPromptItem(null)}><section className="addon-prompt" role="dialog" aria-modal="true" aria-labelledby="addon-prompt-title" onClick={(event) => event.stopPropagation()}><span className="section-kicker">MAKE IT YOURS</span><h2 id="addon-prompt-title">Add {addOnPromptItem.addon_name}?</h2><p>{addOnPromptItem.name} is {money(addOnPromptItem.price_paisa)}. Add {addOnPromptItem.addon_name} for {money(addOnPromptItem.addon_price_paisa ?? 0)} more?</p><div className="addon-prompt-actions"><button type="button" onClick={() => { addToCart(addOnPromptItem.id, 1, false, pendingOptionId); setAddOnPromptItem(null); setPendingOptionId(undefined); setCartOpen(true); }}>No thanks · {money(addOnPromptItem.price_paisa)}</button><button type="button" className="blue-button" onClick={() => { addToCart(addOnPromptItem.id, 1, true, pendingOptionId); setAddOnPromptItem(null); setPendingOptionId(undefined); setCartOpen(true); }}>Add {addOnPromptItem.addon_name} · {money(addOnPromptItem.price_paisa + (addOnPromptItem.addon_price_paisa ?? 0))}</button></div><button type="button" className="addon-prompt-cancel" onClick={() => setAddOnPromptItem(null)}>Cancel</button></section></div>}
    {cartOpen && <div className="cart-scrim" onClick={() => setCartOpen(false)}><aside className="cart-drawer" onClick={(event) => event.stopPropagation()} aria-label="Your bucket"><div className="cart-head"><div><span className="section-kicker">YOUR ORDER</span><h2>Your bucket <small>({cartCount})</small></h2></div><button onClick={() => setCartOpen(false)} aria-label="Close bucket">×</button></div><div className="cart-service"><b>Pickup</b><span>{cartRequiresSchedule ? "Your bucket has prepared food. Choose a pickup window below." : "Ready-to-collect items · no time slot needed"}</span></div>{orderMode === "scheduled" && <label className="bucket-window">Choose your pickup slot<select value={selectedWindow} onChange={(event) => setSelectedWindow(event.target.value)}><option value="">{availablePickupWindows.length ? "Choose from the next available pickup slots" : "No pickup slots are available right now"}</option>{availablePickupWindows.slice(0, 6).map((window) => <option key={window.id} value={window.id}>{new Date(window.start_at).toLocaleString("en-PK", { timeZone:"Asia/Karachi", weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" })} – {formatPickupTime(window.end_at)}</option>)}</select></label>}<div className="cart-lines">{Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([key, quantity]) => { const { itemId, optionId, withAddon } = readCartLineKey(key); const item = sellableItems.find((entry) => entry.id === itemId); if (!item) return null; const option = item.options?.find((entry) => entry.id === optionId); const unitPrice = item.price_paisa + (withAddon ? item.addon_price_paisa ?? 0 : 0); const lineName = `${item.name.replace("[DEV SAMPLE] ", "")}${option ? ` · ${option.name}` : ""}${withAddon && item.addon_name ? ` + ${item.addon_name}` : ""}`; return <div className="cart-line" key={key}><div><b>{lineName}</b><small>{money(unitPrice)} each{withAddon ? " · add-on included" : ""}</small></div><div className="quantity-controls"><button onClick={() => addToCart(item.id, -1, withAddon, optionId)} aria-label={`Remove one ${lineName}`}>−</button><b>{quantity}</b><button onClick={() => addToCart(item.id, 1, withAddon, optionId)} aria-label={`Add one ${lineName}`}>+</button></div><strong>{money(unitPrice * quantity)}</strong></div>; })}{!cartCount && <div className="cart-empty"><span>▣</span><h3>Your bucket is empty</h3><p>Add a menu item to start building your order.</p><button className="blue-button" onClick={() => { setCartOpen(false); document.getElementById("menu")?.scrollIntoView({behavior:"smooth"}); }}>Browse menu</button></div>}</div><div className="cart-bottom"><div className="cart-total"><span>Items total</span><b>{cartCount}</b></div><div className="cart-total"><span>Total</span><b>{money(cartTotal)}</b></div><label className="demo-payment">Payment method<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>{user?.source === "supabase" && user.role === "student" && <option value="wallet">CedarBite wallet</option>}<option value="cash">Cash at pickup</option></select></label><p className="checkout-hint">Review your items and pickup details before placing the order.</p>{orderError && <p className="order-error" role="alert">{orderError}</p>}<button className="checkout-button" disabled={!cartCount || orderSubmitting || !canOrder || (orderMode === "scheduled" && !selectedWindow)} onClick={placeOrder}>{orderSubmitting ? "Sending order…" : canOrder ? "Place order" : "Sign in to place an order"}</button>{!canOrder && <button className="cart-signin" onClick={() => loginDialog.current?.showModal()}>Sign in with your Cedar email</button>}</div></aside></div>}
    <dialog className="signin-dialog" ref={loginDialog}><button className="dialog-x" onClick={() => loginDialog.current?.close()} aria-label="Close sign in">×</button><CedarMark/><span className="section-kicker">WELCOME TO CEDARBITE</span><h2>Sign in with your<br/><span>cedar email</span></h2><p>Sign in with your Cedar College email to access student ordering and wallet features.</p>{googleReady ? <button className="google-button" onClick={startSignIn}><GoogleIcon/> Sign in with Google account</button> : IS_NETLIFY_HOSTED ? <p className="signin-unavailable" role="status">Cedar sign-in is unavailable right now. Please try again later.</p> : <form className="demo-signin-form" onSubmit={(event) => { event.preventDefault(); demoSignIn(demoEmail); }}><label>Cedar email<input type="email" required value={demoEmail} onChange={(event) => setDemoEmail(event.target.value)} placeholder="your.email@cedar.edu.pk"/></label><button className="google-button">Continue with Cedar email</button><small>Cedar College account</small></form>}<small className="secure-hint">Sign-in is limited to verified Cedar College accounts.</small></dialog>
    {walletOpen && <div className="wallet-scrim" onClick={() => setWalletOpen(false)}><section className="wallet-panel" role="dialog" aria-modal="true" aria-labelledby="wallet-title" onClick={(event) => event.stopPropagation()}><div className="cart-head"><div><span className="section-kicker">CEDARBITE WALLET</span><h2 id="wallet-title">Your wallet</h2></div><button onClick={() => setWalletOpen(false)} aria-label="Close wallet">×</button></div><div className="wallet-balance"><span>Available balance</span><b>{money(walletBalance)}</b><small>{user?.role === "DEMO_STUDENT" ? "Wallet balance saved in this browser" : user?.role === "student" || user?.role === "staff_customer" ? "Shared account balance" : "Sign in with your Cedar account to view your wallet"}</small></div>{user?.role === "DEMO_STUDENT" ? <><label className="demo-payment">Top-up amount (PKR)<input type="number" min="100" max="5000" step="50" value={topUpAmount} onChange={(event) => setTopUpAmount(event.target.value)}/></label><label className="demo-payment">Top up using<select value={topUpMethod} onChange={(event) => setTopUpMethod(event.target.value)}><option value="easypaisa">EasyPaisa</option><option value="jazzcash">JazzCash</option><option value="bank">Bank transfer</option><option value="card">Card</option></select></label><p className="wallet-note">Online payment providers are not connected. A wallet balance added here is not backed by a verified payment.</p><button className="blue-button wallet-topup" onClick={() => void demoTopUp()} disabled={topUpSubmitting}>{topUpSubmitting ? "Updating wallet…" : "Add wallet balance"}</button></> : <p className="wallet-note">To add cash to this wallet, give the money to canteen staff and ask them to record it against your student ID.</p>}<h3>Recent wallet activity</h3>{walletEntries.length ? <div className="wallet-history">{walletEntries.slice(0,5).map((entry) => <div key={entry.id}><span><b>{entry.label}</b><small>{new Date(entry.created_at).toLocaleString()} · {entry.method}</small></span><strong className={entry.kind}>{entry.kind === "credit" ? "+" : "−"}{money(entry.amount)}</strong></div>)}</div> : <p className="wallet-empty">No wallet activity yet.</p>}</section></div>}
    {showOrderConfirmation && orderConfirmation && <div className="order-confirmation-scrim"><section className="order-confirmation" role="dialog" aria-modal="true" aria-labelledby="order-success-title" aria-describedby="order-success-description"><CedarMark/><div className="confirmation-check" aria-hidden="true">✓</div><span className="section-kicker">ORDER PLACED SUCCESSFULLY</span><h2 id="order-success-title">Your order is confirmed.</h2><p id="order-success-description">Show this pickup number to the canteen staff when you collect your order.</p><div className="confirmation-pickup"><small>PICKUP NUMBER</small><strong>{orderConfirmation.pickup_code}</strong></div><p className="receipt-email-note">{orderConfirmation.mode === "SCHEDULED" ? "We’ll email your receipt when your scheduled order is ready." : "Your order is ready for collection."}</p><button className="blue-button" autoFocus onClick={() => { setShowOrderConfirmation(false); navigate("menu"); }}>Return to menu</button></section></div>}
    {toast && <div className="toast-message" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </div>;
}

function GoogleIcon() { return <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.25 5.48-4.73 7.18l7.35 5.7c4.29-3.96 7.42-9.8 7.42-17.35z"/><path fill="#FBBC05" d="M10.54 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a23.94 23.94 0 0 0 0 21.56l7.98-6.19z"/><path fill="#34A853" d="M24 48c6.47 0 11.9-2.13 15.86-6.1l-7.35-5.7c-2.04 1.38-4.65 2.2-8.51 2.2-6.26 0-11.57-4.22-13.46-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>; }

function TeamPage() {
  const members = [
    { name: "Eshwar Das", initials: "ED", role: "LEAD DEVELOPER", description: "Lead Developer for CedarBite, working with the team on the campus ordering experience." },
    { name: "Rayan Ahmed", initials: "RA", role: "PRODUCT & TESTING", description: "Exploring the student and staff experience and helping review the ordering flow." },
    { name: "Mudassir Munawar Mannan", initials: "MM", role: "FRONTEND DEVELOPER", description: "Helping shape the student and canteen interfaces as CedarBite develops." },
    { name: "Muhammad Eyad Imran", initials: "ME", role: "BACKEND DEVELOPER", description: "Collaborating on the data and shared order experience for CedarBite." },
  ];
  return <main className="team-page">
    <section className="team-hero"><span className="section-kicker">TEAM BEHIND CEDARBITE</span><h1>Four students.<br/><span>One shared idea.</span></h1><p>We are the student team building CedarBite for the Cedar College community.</p><div className="team-hero-orbit" aria-hidden="true"><span><CedarMark/></span><i/><b/></div></section>
    <section className="team-roster" aria-labelledby="team-roster-title"><div className="team-section-heading"><div><span className="section-kicker">MEET THE TEAM</span><h2 id="team-roster-title">Built together at Cedar.</h2></div><span className="team-count">04 <small>COLLABORATORS</small></span></div><div className="team-member-list">{members.map((member, index) => <article className="team-member-row" key={member.name} style={{ "--team-index": index } as React.CSSProperties}><div className="team-member-visual"><div className="team-member-orbit" aria-hidden="true"><i/></div><div className="team-member-avatar" role="img" aria-label={`${member.initials} initials portrait for ${member.name}`}><span>{member.initials}</span></div><span className="team-member-index">0{index + 1}</span></div><div className="team-member-copy"><span className="team-role">{member.role}</span><h3>{member.name}</h3><p>{member.description}</p></div><span className="team-row-arrow" aria-hidden="true">↗</span></article>)}</div></section>
  </main>;
}

function InfoPage({ page }: { page: "about" | "privacy" | "terms" | "contact" }) {
  if (page === "about") return <main className="info-page about-page">
    <section className="about-hero">
      <div className="about-hero-copy">
        <span className="section-kicker">CEDAR COLLEGE · DHA CAMPUS</span>
        <h1>A clearer way to order your campus break.</h1>
        <p className="info-lead">CedarBite brings the canteen menu and pickup process into one simple place, giving students a clearer view of what’s available and helping staff keep orders organised.</p>
        <a className="about-primary-link" href="/">Explore the menu <span aria-hidden="true">↗</span></a>
      </div>
      <div className="about-hero-art" aria-hidden="true">
        <div className="about-art-orbit about-art-orbit-one"/><div className="about-art-orbit about-art-orbit-two"/>
        <div className="about-art-plate about-campus-poster"><img src="/assets/about-campus-order.svg" alt="" aria-hidden="true"/></div>
        <i className="about-art-dot about-art-dot-one"/><i className="about-art-dot about-art-dot-two"/>
      </div>
    </section>
    <section className="about-story-grid">
      <div className="about-story-heading"><span className="section-kicker">WHY CEDARBITE</span><h2>A small change to a familiar part of the day.</h2></div>
      <div className="about-story-copy"><p>A short break can feel even shorter when students are still deciding what’s available or waiting to place an order. CedarBite began as a student project to make that part of the school day easier to understand and manage.</p><p>The goal is practical: give students one clear menu and a pickup number, while giving canteen staff a shared view of orders as they are handled. The service is designed around collection on campus; it does not offer delivery.</p></div>
    </section>
    <section className="about-flow-section">
      <div className="about-section-heading"><span className="section-kicker">A SIMPLE FLOW</span><h2>From menu to pickup.</h2><p>Different items need different timing. CedarBite keeps that distinction behind one menu.</p></div>
      <div className="about-flow-grid">
        <article className="about-flow-card"><span className="about-flow-number">01</span><span className="about-flow-icon" aria-hidden="true">⌕</span><h3>Choose what you want</h3><p>Browse the current menu, check item availability, and select any choices or additions offered for an item.</p></article>
        <article className="about-flow-card"><span className="about-flow-number">02</span><span className="about-flow-icon" aria-hidden="true">◷</span><h3>Order at the right pace</h3><p>Ready-to-serve items can move straight to pickup. Food that needs preparation can use an available pickup window.</p></article>
        <article className="about-flow-card"><span className="about-flow-number">03</span><span className="about-flow-icon" aria-hidden="true">✓</span><h3>Collect with confidence</h3><p>Follow the order status and use the pickup number when collecting from the canteen.</p></article>
      </div>
    </section>
    <section className="about-people-band"><div><span className="section-kicker">BUILT BY CEDAR STUDENTS</span><h2>Designed with the people who use it in mind.</h2><p>CedarBite is being developed by students who want to solve a real campus problem with a tool that is straightforward for both students and canteen staff. The team’s focus is on clear choices, dependable order handling, and a workflow that fits the way the canteen operates.</p></div><a className="about-team-link" href="/team">Meet the team <span aria-hidden="true">→</span></a></section>
    <p className="about-service-note">CedarBite’s operating details, payment methods, and pickup procedures are subject to the arrangements confirmed with Cedar College and the canteen.</p>
  </main>;

  if (page === "contact") return <main className="info-page contact-page"><header className="info-page-heading"><span className="section-kicker">CONTACT CEDARBITE</span><h1>We’re here to help.</h1><p className="info-lead">For an order question, keep your pickup number nearby so the canteen team can find it quickly.</p></header><div className="contact-card-grid"><a className="contact-card" href="mailto:cedarbite1@gmail.com"><span className="contact-card-icon" aria-hidden="true">✉</span><span className="contact-card-label">EMAIL</span><b>cedarbite1@gmail.com</b><small>For order, account, or service enquiries</small><span className="contact-card-arrow" aria-hidden="true">↗</span></a><a className="contact-card" href="tel:+9221111454647"><span className="contact-card-icon" aria-hidden="true">☎</span><span className="contact-card-label">CANTEEN CONTACT</span><b>021 111 454 647</b><small>Call for canteen-related assistance</small><span className="contact-card-arrow" aria-hidden="true">↗</span></a><article className="contact-card contact-location"><span className="contact-card-label">LOCATION</span><div className="contact-location-name"><span className="contact-college-logo"><img className="college-logo-light" src="/assets/cedar-college-mark.png" alt="Cedar College logo"/><img className="college-logo-dark" src="/assets/cedar-college-mark-dark.png" alt="" aria-hidden="true"/></span><b>Cedar College</b></div><small>CedarBite is for pickup at Cedar College.</small></article></div><section className="contact-help"><span className="section-kicker">BEFORE YOU CONTACT US</span><h2>Have your pickup number ready.</h2><p>It helps the canteen team locate your order. Please don’t send your password, verification code, or payment card details by email or phone.</p></section></main>;

  const sections = page === "privacy" ? [
    { title: "Who this notice covers", paragraphs: ["This notice explains the information CedarBite uses when you visit the site, sign in, place an order, or use a staff station. CedarBite is intended for the Cedar College community. For food preparation and canteen service, Del Frio operates at the Cedar College."] },
    { title: "Information linked to your account", paragraphs: ["When Cedar Google sign-in is enabled, Google and Supabase verify your sign-in. CedarBite receives your verified Cedar email address, an account identifier, and the name and role associated with your CedarBite profile. For student accounts, the seven-digit student ID is derived from the email address; you do not need to enter it separately for an online order.", "Staff stations also use a station username and an authenticated session so the system can restrict staff functions. Authorized staff may submit menu item names, descriptions, prices, photos, choices, and availability. Some staff actions are recorded with the station username. Never send passwords or verification codes to CedarBite by email or phone."] },
    { title: "Information in an order", paragraphs: ["An online order can include an internal order reference, pickup code, menu items and choices, quantities, price, order and pickup times, pickup window, status, payment method, and payment status. The order is linked to the student’s account, Cedar email, and student ID so the student can view their own orders and canteen staff can prepare and hand over the correct order.", "For in-person counter orders, staff may enter a student ID or a teacher’s name. These details appear in the shared canteen order record so staff can identify and manage the order."] },
    { title: "Wallet and payment records", paragraphs: ["Cash-desk records can include a student ID, amount, date and time, payment label or method, transaction reference, and the staff username that recorded a credit or refund. A student-initiated top-up request can include the student ID, amount, selected method, and request status.", "CedarBite does not ask for or store card numbers, card security codes, bank passwords, or EasyPaisa/JazzCash one-time codes. The payment choices currently shown in CedarBite do not by themselves send or verify a transfer. A payment is not marked received until the canteen records it."] },
    { title: "Ready alerts and email", paragraphs: ["If you turn on browser alerts, CedarBite stores the device subscription details needed to deliver an order-ready alert. You can turn alerts off in My Orders or in your browser settings. For scheduled orders, CedarBite may email the order receipt when the canteen marks the order ready. Quick orders do not receive an email receipt under the current setup."] },
    { title: "Browser storage and technical information", paragraphs: ["CedarBite uses browser storage for your bucket, display preference, and sign-in session. If browser-only preview sign-in is used, preview orders and wallet entries may also remain in that browser. Clearing site data removes locally saved information.", "The services that host CedarBite, authenticate accounts, store orders, and deliver email or browser alerts may process technical information such as IP address, device/browser details, request time, and error logs as part of providing and protecting their services."] },
    { title: "How information is used and shared", paragraphs: ["Information is used to sign you in, display your orders, prepare and hand over food, record payments and refunds, send the scheduled-order receipt or requested ready alert, respond to support questions, and protect the service from misuse.", "Order details are available to authorized canteen staff who need them to handle orders and payments. CedarBite also relies on service providers for sign-in, hosting, data storage, and email or browser-alert delivery, including Google, Supabase, Netlify, and Resend where those services are configured. CedarBite does not sell personal information."] },
    { title: "Storage, retention, and your choices", paragraphs: ["Account, order, wallet, and alert records are kept in the services used to operate CedarBite. Order history may be retained for canteen operations and payment reconciliation; authorized staff can remove eligible records. Browser-saved information remains until you clear it or it is replaced.", "To ask a question, correct a detail, or request deletion, email cedarbite1@gmail.com. Please include enough information to locate the record, such as a pickup number, but do not include a password, OTP, or card details. Some records may need to remain available for order, payment, or college record-keeping."] },
    { title: "Changes to this notice", paragraphs: ["If CedarBite changes the information it collects or how it is used, this page will be updated. Last updated: 13 November 2026."] },
  ] : [
    { title: "Using CedarBite", paragraphs: ["CedarBite is for Cedar College students, teachers, and authorized canteen staff. Students should sign in with their own Cedar Google account. Staff should use only the station access assigned to them and keep their credentials private.", "By placing an order, you confirm that the details shown in your bucket are the items and quantities you want. Do not place an order using another person’s account or pickup code."] },
    { title: "Menu, prices, and availability", paragraphs: ["Menu items, choices, prices, and availability are set by the canteen and may change. A listed item or option may sell out before an order is completed. The current price shown at checkout is the amount recorded for the order. Food photographs are illustrative; the served item may look different.", "If a price or menu detail is clearly incorrect, the canteen may pause or correct the order and explain the amount due before payment is completed."] },
    { title: "Pickup and order status", paragraphs: ["CedarBite is for pickup at Cedar College; it does not arrange delivery. Quick items are intended for immediate collection and appear in the Order ready section after placement. Scheduled orders use an available pickup window and move through the canteen’s preparation process. A scheduled order is ready only when staff marks it ready.", "Keep your pickup number available and show it to canteen staff when collecting. Check My Orders for the latest status. A scheduled pickup window is a requested collection time, subject to the availability displayed when the order is placed and the canteen’s ability to prepare it."] },
    { title: "Payment", paragraphs: ["Cash at pickup is recorded by canteen staff when cash is received. EasyPaisa, JazzCash, bank, card, or wallet labels shown in the interface do not mean CedarBite has processed or verified a payment. Do not enter card credentials, banking passwords, or OTPs in CedarBite or share them with staff. Follow the canteen’s instructions and check that the payment status is recorded correctly.", "Where a wallet credit or refund is recorded by authorized staff, the amount and related order or student details may appear in the wallet history. Contact the canteen if a recorded amount appears incorrect."] },
    { title: "Changes and cancellations", paragraphs: ["An online student order can be cancelled in My Orders only while the cancel option is shown. Once the canteen accepts the order or it is marked ready, the in-app cancellation option is no longer available. For help, contact the canteen and provide the pickup number.", "Refunds are handled by the canteen and depend on the payment record and the circumstances. A refund is not complete until it appears in the order or wallet history, as applicable."] },
    { title: "Responsible use and service availability", paragraphs: ["Do not interfere with the service, attempt to access another person’s account or staff station, or submit false order or payment details. CedarBite may be unavailable during maintenance, connectivity problems, or a canteen pause. If an order status is unclear, check My Orders or ask staff before submitting the same order again."] },
    { title: "Food questions and contact", paragraphs: ["Food preparation and catering at the campus are provided by Del Frio. Please speak with canteen staff before ordering if you have an allergy or need ingredient information; menu descriptions may not list every ingredient.", "Questions about these terms or a CedarBite order can be sent to cedarbite1@gmail.com or raised with the canteen team at Cedar College. Contact number: 021 111 454 647. These terms were last updated on 13 November 2026."] },
  ];
  const isPrivacy = page === "privacy";
  const title = isPrivacy ? "Privacy policy" : "Terms and conditions";
  const lead = isPrivacy
    ? "A clear account of the information CedarBite uses to handle sign-in, orders, payments, and ready alerts."
    : "The practical terms for placing, paying for, and collecting an order through CedarBite.";
  return <main className={`info-page legal-page ${isPrivacy ? "privacy-page" : "terms-page"}`}><header className="info-page-heading"><span className="section-kicker">CEDARBITE · {isPrivacy ? "PRIVACY" : "SERVICE TERMS"}</span><h1>{title}</h1><p className="info-lead">{lead}</p><span className="legal-updated">Updated 13 November 2026 · Cedar College</span></header><div className="legal-content-grid"><nav className="legal-index" aria-label={`${title} sections`}><b>On this page</b>{sections.map((section, index) => <a key={section.title} href={`#legal-section-${index + 1}`}>{section.title}</a>)}</nav><div className="legal-sections">{sections.map((section, index) => <section className="legal-section" id={`legal-section-${index + 1}`} key={section.title}><span className="legal-section-number">{String(index + 1).padStart(2, "0")}</span><div><h2>{section.title}</h2>{section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div></section>)}<p className="legal-contact-note">Questions? <a href="mailto:cedarbite1@gmail.com">cedarbite1@gmail.com</a> · <a href="tel:+9221111454647">021 111 454 647</a></p></div></div></main>;
}
function MenuOptionsEditor({ initialOptions = [] }: { initialOptions?: MenuOption[] }) {
  const [options, setOptions] = useState<MenuOption[]>(() => initialOptions.map((option) => ({ ...option })));
  function update(index: number, changes: Partial<MenuOption>) { setOptions((current) => current.map((option, optionIndex) => optionIndex === index ? { ...option, ...changes } : option)); }
  return <fieldset className="menu-options-editor"><legend>Choices students must select (optional)</legend><p>For example: Pepsi, 7UP, or Mirinda. Unavailable choices stay visible as out of stock.</p>{options.map((option, index) => <div className="menu-option-row" key={option.id}><input aria-label={`Choice ${index + 1} name`} value={option.name} maxLength={80} placeholder={`Choice ${index + 1}`} onChange={(event) => update(index, { name: event.target.value })}/><label><input type="checkbox" checked={option.available} onChange={(event) => update(index, { available: event.target.checked })}/> Available</label><button type="button" aria-label={`Remove choice ${option.name || index + 1}`} onClick={() => setOptions((current) => current.filter((_, optionIndex) => optionIndex !== index))}>Remove</button></div>)}{options.length < 25 && <button type="button" className="menu-option-add" onClick={() => setOptions((current) => [...current, { id: createUuid(), name: "", available: true }])}>+ Add a choice</button>}<input type="hidden" name="options_json" value={JSON.stringify(options)}/></fieldset>;
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
    let options: MenuOption[];
    try { options = readMenuOptions(data.get("options_json")); } catch (error) { setFormError(error instanceof Error ? error.message : "Check the item choices."); return; }
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
        options,
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
    <MenuOptionsEditor initialOptions={item.options}/>
    <label className="menu-edit-image">Item image<input ref={imageInput} type="file" accept="image/*" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; const version = ++imageVersion.current; setImageError(""); if (!file) return; setImageLoading(true); void resizeMenuImage(file).then((image) => { if (version === imageVersion.current) setImageData(image); }).catch((error) => { if (version === imageVersion.current) { setImageError(error instanceof Error ? error.message : "This image could not be loaded."); input.value = ""; } }).finally(() => { if (version === imageVersion.current) setImageLoading(false); }); }}/></label>
    {imageData && <div className="item-image-preview"><img src={imageData} alt={`Preview of ${item.name}`}/><button type="button" disabled={saving || formSaving} onClick={() => { imageVersion.current += 1; setImageData(""); setImageLoading(false); if (imageInput.current) imageInput.current.value = ""; }}>Remove image</button></div>}
    {imageLoading && <p className="form-message" role="status">Preparing image…</p>}{imageError && <p className="form-message error-message" role="alert">{imageError}</p>}{formError && <p className="form-message error-message" role="alert">{formError}</p>}
    <div className="menu-edit-actions"><button type="button" disabled={saving || formSaving} onClick={onCancel}>Cancel</button><button className="blue-button" disabled={saving || formSaving || imageLoading}>{saving || formSaving ? "Saving…" : "Save changes"}</button></div>
  </form>;
}

function FoodCard({ item, index, onAdd, canOrder, featuredLabel }: { item: Item; index: number; onAdd: () => void; canOrder: boolean; featuredLabel?: string }) {
  const noAvailableChoices = Boolean(item.options?.length && !item.options.some((option) => option.available));
  const orderBlocked = !item.available || !canOrder;
  const modeLabel = item.quick_allowed && item.scheduled_allowed ? "READY OR MADE FRESH" : item.quick_allowed ? "READY TO COLLECT" : "MADE TO ORDER";
  const actionLabel = !item.available ? "Sold out" : !canOrder ? "Closed" : item.options?.length ? noAvailableChoices ? "View stock" : "Choose" : "Add";
  return <article className={`food-card ${featuredLabel ? "item-of-day-featured" : ""} ${!item.available ? "sold-out" : ""}`}><div className={`food-picture picture-${index % 4}`}>{item.image_data ? <img className="food-item-photo" src={item.image_data} alt={item.name} loading="eager" decoding="async"/> : <span className="food-emoji">{itemIcon(item)}</span>}<span className="food-tag">{featuredLabel || modeLabel}</span></div><div className="food-info"><div className="food-name-price"><h4>{item.name.replace("[DEV SAMPLE] ", "")}</h4><b>{item.price_display}</b></div><p>{item.description || (item.prep_minutes ? `Made to order · about ${item.prep_minutes} minutes` : "A canteen favourite.")}</p><div className="food-bottom"><span className={item.available && !noAvailableChoices ? "stock-yes" : "stock-no"}><i/> {item.available && !noAvailableChoices ? item.options?.length ? "Choose an option" : "Available" : "All choices out of stock"}</span><button onClick={onAdd} disabled={orderBlocked} aria-label={!item.available ? `${item.name} is sold out` : !canOrder ? `Ordering is closed for ${item.name}` : item.options?.length ? `Choose an option for ${item.name}` : `Add ${item.name} to bucket`}>{actionLabel}{item.available && canOrder && <span> +</span>}</button></div></div></article>;
}

function OrderCard({ order, onCancel, cancelling = false }: { order: Order; onCancel?: () => void; cancelling?: boolean }) { return <article className={`order-row${order.status === "CANCELLED" ? " order-cancelled" : ""}`}><div className="order-row-top"><b>Pickup number: {order.pickup_code}</b><span className="order-status">{human(order.status)}</span><span className="order-date">{new Date(order.created_at).toLocaleString()}</span></div><p>{order.items.map((line, index) => <span key={`${line.name}-${index}`}>{line.quantity} × {line.name}</span>)}</p><div className="order-row-bottom"><span>{human(order.mode)}{order.pickup_window ? ` · ${new Date(order.pickup_window.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " · Quick pickup"}</span><b>{order.total_display}</b></div>{onCancel && <div className="order-cancel-row"><small>You can cancel until the canteen accepts your order.</small><button className="order-cancel" onClick={onCancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel order"}</button></div>}</article>; }

type OwnerProps = { station: "order_manager" | "cashier" | "developer"; user: User | null; googleReady: boolean; categories: Category[]; items: (Item & { category: string })[]; queue: Order[]; orderHistory: Order[]; salesSummary: SalesSummary | null; salesSummaryDates: string[]; salesSummaryError: string; salesSummaryLoading: boolean; onLoadSalesSummary: (date?: string) => void; onLoadSalesDates: () => void; onDeleteSalesSummary: (date: string) => Promise<void>; monthlySalesSummary: MonthlySalesSummary | null; monthlySalesMonths: string[]; monthlySalesError: string; monthlySalesLoading: boolean; onLoadMonthlySalesMonths: () => void; onLoadMonthlySalesSummary: (month?: string) => void; walletTopUpHistory: WalletTopUpHistoryEntry[]; walletHistoryError: string; walletHistoryLoading: boolean; onLoadHistory: () => void; onLoadWalletTopUpHistory: () => void; queuePendingIds: string[]; itemOfDaySchedule: ItemOfDayEntry[]; itemOfDayMessage: string; itemOfDayPending: boolean; onSaveItemOfDaySchedule: (schedule: ItemOfDayEntry[]) => Promise<void>; heroSlides: HeroSlide[]; heroSlidesMessage: string; heroSlidesPending: boolean; onSaveHeroSlides: (slides: HeroSlide[]) => Promise<void>; darkMode: boolean; onToggleTheme: () => void; canManage: boolean; canSortMenu: boolean; onReorderMenuItems: (sourceId: number, targetId: number) => void; onReorderMenuCategories: (sourceId: number, targetId: number) => void; canToggle: boolean; availabilityPending: number[]; menuMutationPending: boolean; itemAddPending: boolean; canQueue: boolean; canTopUp: boolean; walletMessage: string; walletPending: boolean; onCashTopUp: (form: HTMLFormElement) => Promise<boolean>; onLookupStudent: (student_id: string) => Promise<{ student_id: string; full_name: string }>; itemMessage: string; orderingReason: string; onSignIn: () => void; onDemoStaff: (username: string, password: string, station: string) => Promise<void>; onSignOut: () => void; onReturnToActive: () => void; onBack: () => void; onToggle: (item: Item) => void; onPrice: (item: Item, form: HTMLFormElement) => void; onAddCategory: (form: HTMLFormElement) => void; onRemoveCategory: (category: Category, targetCategoryId?: number) => Promise<boolean>; onAddItem: (event: FormEvent<HTMLFormElement>) => void; onRemoveItem: (item: Item) => Promise<boolean>; onUpdateItem: (item: Item, values: MenuItemEditValues) => Promise<void>; onAdvance: (order: Order) => void; onDeleteOrder: (order: Order) => void; onDeleteHistoryOrder: (order: Order) => void; onRestoreHistoryOrder: (order: Order) => void; onRefundHistoryOrder: (order: Order) => void; onMarkCashPaid: (order: Order) => void; onChangePassword: (newPassword: string) => Promise<void>; onResetPassword: (station: string, newPassword: string) => Promise<void>; onToggleOrdering: () => void; onRefresh: () => void; temporaryOpening: boolean; temporaryOpeningExpiresAt: string | null; temporaryOpeningPending: boolean; onToggleTemporaryOpening: (enabled: boolean) => Promise<void>; onExportData: (from: string, to: string) => Promise<DeveloperExportPayload> };
function pakistanWeekday(date = new Date()): Weekday {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", weekday: "long" }).format(date).toLowerCase() as Weekday;
}
function canteenIsOperatingDay(date = new Date()): boolean {
  return CANTEEN_OPEN_DAYS.has(pakistanWeekday(date));
}
function pakistanMinute(date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}
function isCanteenOpenNow(date = new Date()): boolean {
  const minute = pakistanMinute(date);
  return canteenIsOperatingDay(date) && minute >= 8 * 60 && minute < 17 * 60;
}
function isPickupPreviewOpen(date = new Date()): boolean {
  const minute = pakistanMinute(date);
  return canteenIsOperatingDay(date) && minute >= 7 * 60 + 50 && minute < 17 * 60;
}
function ItemOfDaySpotlight({ schedule, now, onAdd, canOrder }: { schedule: ItemOfDayEntry[]; now: Date; onAdd: (item: Item) => void; canOrder: boolean }) {
  const today = pakistanWeekday(now);
  const featured = schedule.filter((entry) => entry.days.includes(today) && entry.item.available).map((entry) => entry.item);
  if (!featured.length) return null;
  const weekdayLabel = new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", weekday: "long" }).format(now);
  const dateLabel = new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", weekday: "short", month: "short", day: "numeric" }).format(now);
  return <section className="item-of-day-spotlight" aria-label="Items of the day">
    <div className="item-of-day-heading"><div><span className="item-of-day-eyebrow"><i aria-hidden="true">✦</i> {weekdayLabel.toUpperCase()} · FEATURED</span><h2>Today’s <span>spotlight</span></h2></div><span className="item-of-day-date">{dateLabel}</span></div>
    <div className="item-of-day-grid food-grid">{featured.map((item, index) => <FoodCard key={item.id} item={item} index={index} onAdd={() => onAdd(item)} canOrder={canOrder} featuredLabel={`${weekdayLabel.toUpperCase()} PICK`} />)}</div>
  </section>;
}
function ItemOfDayEditor({ schedule, message, pending, canManage, onSave }: { schedule: ItemOfDayEntry[]; message: string; pending: boolean; canManage: boolean; onSave: (schedule: ItemOfDayEntry[]) => Promise<void> }) {
  const [draft, setDraft] = useState<ItemOfDayEntry[]>(schedule);
  const [formMessage, setFormMessage] = useState("");
  useEffect(() => setDraft(schedule), [schedule]);
  function toggleDay(itemId: number, day: Weekday) {
    setDraft((current) => {
      const days = new Set(current.find((entry) => entry.item.id === itemId)?.days ?? []);
      if (days.has(day)) days.delete(day); else days.add(day);
      return current.map((entry) => entry.item.id === itemId ? { ...entry, days: WEEKDAYS.filter((weekday) => days.has(weekday)) } : entry);
    });
  }
  async function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.length >= 20) { setFormMessage("The Item of the day list is full. Remove a special before adding another."); return; }
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const description = String(data.get("description") ?? "").trim();
    const price = Number(data.get("price"));
    const quick_allowed = data.get("quick_allowed") === "on";
    const scheduled_allowed = data.get("scheduled_allowed") === "on";
    if (!name || !Number.isFinite(price) || price < 0 || price > 100000 || (!quick_allowed && !scheduled_allowed)) {
      setFormMessage("Enter an item name and price, and choose at least one order option.");
      return;
    }
    const imageFile = data.get("image");
    let image_data: string | null = null;
    if (imageFile instanceof File && imageFile.size) {
      try { image_data = await resizeMenuImage(imageFile); }
      catch (error) { setFormMessage(error instanceof Error ? error.message : "This image could not be loaded."); return; }
    }
    const nextId = Math.min(-Date.now(), ...draft.map((entry) => entry.item.id - 1));
    const item: Item = {
      id: nextId, category_id: -1, name, description, price_paisa: Math.round(price * 100), price_display: `Rs ${Math.round(price).toLocaleString("en-PK")}`,
      available: true, quick_allowed, scheduled_allowed, prep_minutes: scheduled_allowed ? 15 : null, image_data,
    };
    setDraft((current) => [...current, { item, days: [] }]);
    setFormMessage(`${name} added. Choose its days, then save the schedule.`);
    form.reset();
  }
  function removeItem(itemId: number) { setDraft((current) => current.filter((entry) => entry.item.id !== itemId)); }
  return <section className="owner-content item-of-day-editor"><div className="panel-heading"><div><span className="section-kicker">STUDENT MENU SPOTLIGHT</span><h2>Item of the day</h2><p>Add specials that are separate from the regular menu, then choose which days each one appears.</p></div></div>{!canManage ? <p className="panel-empty">Manager access required.</p> : <><form className="item-of-day-add-form" onSubmit={(event) => { void addItem(event); }}><label>Item name<input name="name" placeholder="e.g. Sushi" maxLength={100} required/></label><label>Description<input name="description" placeholder="A short description" maxLength={300}/></label><label>Price (Rs)<input name="price" type="number" min="0" max="100000" step="1" placeholder="e.g. 450" required/></label><label>Item image<input name="image" type="file" accept="image/*"/></label><fieldset><legend>Order options</legend><label><input type="checkbox" name="quick_allowed"/> Quick</label><label><input type="checkbox" name="scheduled_allowed" defaultChecked/> Scheduled</label></fieldset><button type="submit" className="blue-button" disabled={pending || draft.length >= 20}>Add item</button><p className="form-message" role="status">{formMessage || "Add a photo if you have one. Choose the days for each special below."}</p></form><div className="item-of-day-admin-list">{draft.map(({ item, days: selectedDays }) => { const days = new Set(selectedDays); return <article className="item-of-day-admin-row" key={item.id}><div className="item-of-day-admin-item"><MenuItemVisual item={item}/><span><b>{item.name}</b><small>{item.price_display}{!item.available ? " · Currently unavailable" : " · Special item"}</small></span><button type="button" className="item-of-day-remove" aria-label={`Remove ${item.name} from Item of the day`} onClick={() => removeItem(item.id)}>×</button></div><div className="item-of-day-days" aria-label={`Spotlight days for ${item.name}`}>{WEEKDAYS.map((day) => <button type="button" key={day} aria-pressed={days.has(day)} onClick={() => toggleDay(item.id, day)}>{day.slice(0, 3)}</button>)}</div></article>; })}{!draft.length && <p className="panel-empty">No specials added yet. Add an item above to start the list.</p>}</div><div className="item-of-day-save"><p className="form-message" role="status">{message}</p><button type="button" className="blue-button" disabled={pending} onClick={() => void onSave(draft)}>{pending ? "Saving schedule…" : "Save schedule"}</button></div></>}</section>;
}

function OwnerApp(props: OwnerProps) {
  const initialTab = props.station === "cashier" ? "Cash receipts" : "Overview";
  const [tab, setTab] = useState(initialTab); const [customizeOpen, setCustomizeOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => { window.scrollTo(0, 0); }, [tab, props.station]);
  const [salesDate, setSalesDate] = useState(pakistanDay());
  const [salesMonth, setSalesMonth] = useState(pakistanDay().slice(0, 7));
  const [salesDeleteConfirmDate, setSalesDeleteConfirmDate] = useState<string | null>(null);
  const [salesDeletePendingDate, setSalesDeletePendingDate] = useState<string | null>(null);
  const [salesDeleteError, setSalesDeleteError] = useState("");
  const [topUpStudentId, setTopUpStudentId] = useState("");
  const [topUpStudent, setTopUpStudent] = useState<{ student_id: string; full_name: string } | null>(null);
  const [topUpStudentLookupBusy, setTopUpStudentLookupBusy] = useState(false);
  const [topUpStudentLookupError, setTopUpStudentLookupError] = useState("");
  const [topUpStudentConfirmed, setTopUpStudentConfirmed] = useState(false);
  const topUpStudentLookupVersion = useRef(0);
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
  const { user, categories, items, queue, orderHistory, canManage, canToggle, canQueue } = props;
  const isDeveloper = props.station === "developer";
  const hasDeveloperAccess = isDeveloper && Boolean(user?.permissions.includes("developer.area"));
  const canCustomize = canManage || (isDeveloper && Boolean(user?.permissions.includes("developer.area") || user?.permissions.includes("customize.manage")));
  const activeStation = storageGet("session", CANTEEN_ROLE_KEY);
  const stationConflict = Boolean((activeStation && activeStation !== props.station) || (user && (user.role !== "DEMO_CANTEEN" || activeStation !== props.station)));
  const waiting = queue.filter((order) => ["SUBMITTED", "ACCEPTED", "PREPARING"].includes(order.status)).length;
  const refundOrders = orderHistory.filter((order) => order.status === "COLLECTED");
  const tabs = props.station === "cashier" ? ["Cash receipts", "Wallet top-ups", "Wallet top-up history", "Refunds"] : isDeveloper ? ["Overview", "Daily sales", "Monthly sales", "Customize", "Staff passwords", "Export"] : ["Overview", "Daily sales", "Monthly sales", "Orders history", "Customize"];
  async function lookupTopUpStudent(studentId: string) {
    const version = ++topUpStudentLookupVersion.current;
    setTopUpStudent(null);
    setTopUpStudentConfirmed(false);
    setTopUpStudentLookupError("");
    setTopUpStudentLookupBusy(true);
    try {
      const student = await props.onLookupStudent(studentId);
      if (version === topUpStudentLookupVersion.current) setTopUpStudent(student);
    } catch (error) {
      if (version === topUpStudentLookupVersion.current) setTopUpStudentLookupError(error instanceof Error ? error.message : "Student profile could not be checked.");
    } finally {
      if (version === topUpStudentLookupVersion.current) setTopUpStudentLookupBusy(false);
    }
  }
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
  }  return <div className="owner-app"><aside className="owner-sidebar"><button className="owner-logo" onClick={props.onBack}><CedarMark/><span>Cedar<span>Bite</span><small>{isDeveloper ? "DEVELOPER AREA" : "CANTEEN CONSOLE"}</small></span></button><button type="button" className="owner-mobile-toggle" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}><span>{tab}</span><b>{mobileNavOpen ? "Close" : "Navigate"}<i aria-hidden="true">{mobileNavOpen ? "×" : "☰"}</i></b></button><div className={`owner-nav-content ${mobileNavOpen ? "is-open" : ""}`}><span className="sidebar-label">WORKSPACE</span>{tabs.map((name) => <div className="owner-nav-group" key={name}>
        <button className={`sidebar-link ${tab === name || name === "Customize" && customizeOpen ? "active" : ""}`} aria-expanded={name === "Customize" ? customizeOpen : undefined} onClick={() => {
          if (name === "Customize") { setCustomizeOpen((open) => !open); setMobileNavOpen(false); return; }
          setCustomizeOpen(false); setTab(name); setMobileNavOpen(false);
          if (name === "Orders history") props.onLoadHistory();
          if (name === "Refunds") props.onLoadHistory();
          if (name === "Daily sales") { const today = pakistanDay(); setSalesDate(today); props.onLoadSalesDates(); props.onLoadSalesSummary(today); }
          if (name === "Monthly sales") { const month = pakistanDay().slice(0, 7); setSalesMonth(month); props.onLoadMonthlySalesMonths(); props.onLoadMonthlySalesSummary(month); }
          if (name === "Wallet top-up history") props.onLoadWalletTopUpHistory();
        }}><span>{({Overview:"⌂","Daily sales":"▥","Monthly sales":"▤","New orders":"▤",Preparing:"◷","Order Ready":"✓","Orders history":"▤",Customize:"⚙","Staff passwords":"⚿","Cash receipts":"¤","Wallet top-ups":"＋","Wallet top-up history":"≡",Refunds:"↺"} as Record<string,string>)[name]}</span>{name}<i className="customize-chevron" aria-hidden="true">{name === "Customize" ? customizeOpen ? "⌃" : "⌄" : ""}</i>{name === "New orders" && queue.filter((order) => order.status === "SUBMITTED").length > 0 && <i>{queue.filter((order) => order.status === "SUBMITTED").length}</i>}</button>
        {name === "Customize" && customizeOpen && <div className="customize-subnav" aria-label="Website customization">{(isDeveloper ? ["Homepage banner", "Item of the day"] : ["Menu"]).map((section) => <button type="button" key={section} className={tab === section ? "active" : ""} aria-current={tab === section ? "page" : undefined} onClick={() => { setTab(section); setMobileNavOpen(false); }}>{section}</button>)}</div>}
      </div>)}{!isDeveloper && <a className="owner-all-stations-link" href="/stations">← All staff stations</a>}<button className="back-store owner-mobile-back-store" onClick={props.onBack}>← Back to student menu</button></div><div className="sidebar-spacer"/><div className="service-state"><span className="state-dot"/> <span><b>Canteen service</b><small>{props.orderingReason}</small></span></div><button className="back-store" onClick={props.onBack}>← Back to student menu</button></aside>
    <div className="owner-main"><header className="owner-topbar"><div><span className="owner-crumb">CEDARBITE <span>/</span> {isDeveloper ? "DEVELOPER" : "CANTEEN"}</span><h1>{({Overview:isDeveloper ? "Website insights" : "Canteen overview","Daily sales":"Daily sales summary","Monthly sales":"Monthly sales audit","New orders":"New orders",Preparing:"Preparing","Order Ready":"Order Ready","Orders history":"Completed order history",Menu:"Menu management","Item of the day":"Item of the day","Customize":"Customize","Staff passwords":isDeveloper ? "Staff password control" : "Staff password reset",Export:"Export data","Cash receipts":"Cash receipts","Wallet top-ups":"Student wallet top-ups","Wallet top-up history":"Wallet top-up history"} as Record<string,string>)[tab] ?? "Canteen console"}</h1></div><div className="owner-top-actions">{!isDeveloper && <a className="owner-stations-button" href="/stations">Staff stations <span aria-hidden="true">↗</span></a>}<button className="refresh-link" onClick={() => { props.onRefresh(); if (tab === "Daily sales") { props.onLoadSalesDates(); if (isValidSalesDate(salesDate)) props.onLoadSalesSummary(salesDate); } if (tab === "Monthly sales") { props.onLoadMonthlySalesMonths(); props.onLoadMonthlySalesSummary(salesMonth); } if (isDeveloper && tab === "Overview") { props.onLoadSalesSummary(); props.onLoadMonthlySalesSummary(); } }}>↻ Refresh</button>{user ? <button className="owner-user" onClick={props.onSignOut}><span>{user.email.slice(0,1).toUpperCase()}</span>{user.email} · Sign out</button> : !isDeveloper && <button className="sign-button" onClick={props.onSignIn}>Sign in</button>}{user && storageGet("session", CANTEEN_ROLE_KEY) === props.station && <ChangePasswordForm station={props.station} onChange={props.onChangePassword}/>}<ThemeSwitch darkMode={props.darkMode} onToggle={props.onToggleTheme} className="owner-theme-toggle"/></div></header>
    {stationConflict ? <StationSwitchPrompt activeStation={activeStation} activeUser={user} targetStation={props.station} onSignOut={props.onSignOut} onReturn={props.onReturnToActive}/> : !user || storageGet("session", CANTEEN_ROLE_KEY) !== props.station ? <section className="owner-lock"><div className="lock-emblem"><CedarMark/></div><span className="section-kicker">{props.station === "cashier" ? "CASH DESK" : isDeveloper ? "PRIVATE DEVELOPER ACCESS" : "ORDER CONTROL"}</span><h2>{props.station === "cashier" ? <>Cash desk<br/><span>staff sign-in.</span></> : isDeveloper ? <>Developer<br/><span>sign-in.</span></> : <>Canteen order<br/><span>management.</span></>}</h2><p>Sign in with the username and password for this staff station.</p><form className="demo-signin-form" onSubmit={(event) => { event.preventDefault(); setDemoLoginError(""); void props.onDemoStaff(demoUsername, demoPassword, props.station).catch((error) => setDemoLoginError(error instanceof Error ? error.message : "Sign-in failed.")); }}><label>Username<input autoComplete="username" required value={demoUsername} onChange={(event) => setDemoUsername(event.target.value)} placeholder="Enter username" /></label><label>Password<input type="password" autoComplete="current-password" required value={demoPassword} onChange={(event) => setDemoPassword(event.target.value)} placeholder="Enter password"/></label>{demoLoginError && <p className="form-message error-message">{demoLoginError}</p>}<button className="blue-button">Log in to {props.station === "cashier" ? "cash desk" : isDeveloper ? "the developer area" : "order control"}</button></form><p className="password-help">Forgot password? {props.station === "cashier" ? "Ask the order manager to reset the cash desk password." : isDeveloper ? "For account recovery, update CANTEEN_DEVELOPER_PASSWORD in Netlify environment variables." : "If you are the order manager, update your password in Netlify environment variables."}</p><button className="back-to-store" onClick={props.onBack}>← Return to student menu</button></section> : !(canManage || canToggle || canQueue || props.canTopUp || hasDeveloperAccess) ? <section className="owner-lock"><span className="section-kicker">STAFF WORKSPACE</span><h2>This account<br/><span>doesn’t have staff access.</span></h2><p>Use the credentials assigned to this staff station.</p><button className="blue-button" onClick={props.onSignOut}>Sign out</button><button className="back-to-store" onClick={props.onBack}>Return to student menu</button></section> : <>
      {!isDeveloper && <div className="owner-banner"><div><b>Canteen workspace · shared queue and availability</b><span>Pickup orders, menu items, prices, and availability sync across devices.</span></div><button onClick={props.onToggleOrdering}>{props.orderingReason.includes("paused") ? "Resume ordering" : "Pause ordering"}</button></div>}
      {isDeveloper && tab === "Overview" && <DeveloperInsights salesSummary={props.salesSummary} monthlySalesSummary={props.monthlySalesSummary} dailyLoading={props.salesSummaryLoading} monthlyLoading={props.monthlySalesLoading} dailyError={props.salesSummaryError} monthlyError={props.monthlySalesError} onLoadDaily={props.onLoadSalesSummary} onLoadMonthly={props.onLoadMonthlySalesSummary} onOpenDaily={() => setTab("Daily sales")} onOpenMonthly={() => setTab("Monthly sales")} onOpenExport={() => setTab("Export")} onOpenCustomize={() => { setTab("Homepage banner"); setCustomizeOpen(true); }} temporaryOpening={props.temporaryOpening} temporaryOpeningPending={props.temporaryOpeningPending} onToggleTemporaryOpening={props.onToggleTemporaryOpening}/>} {!isDeveloper && tab === "Overview" && <section className="owner-content"><div className="metric-grid"><article><span>ACTIVE MENU ITEMS</span><b>{items.length}</b><small>Across {categories.length} menu categories</small></article><article><span>ORDERS TO FULFIL</span><b>{waiting}</b><small>{canQueue ? "Needs canteen attention" : "Queue access is restricted"}</small></article><article><span>AVAILABLE ITEMS</span><b>{items.filter((item) => item.available).length}</b><small>{items.filter((item) => !item.available).length} currently unavailable</small></article></div><div className="order-stage-cards"><button onClick={() => document.getElementById("new-orders-list")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>NEW ORDERS</span><b>{queue.filter((order) => order.status === "SUBMITTED").length}</b><small>Review and accept</small></button><button onClick={() => document.getElementById("preparing-list")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>PREPARING</span><b>{queue.filter((order) => ["PREPARING", "ACCEPTED"].includes(order.status)).length}</b><small>Shown on kitchen monitor</small></button><button onClick={() => document.getElementById("ready-list")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>ORDER READY</span><b>{queue.filter((order) => order.status === "READY").length}</b><small>Waiting for pickup</small></button></div>{canQueue ? <><div className="owner-workflow-sections"><section className="owner-panel" id="new-orders-list"><div className="panel-heading"><div><span className="section-kicker">INCOMING</span><h2>New orders</h2></div><span className="queue-live"><i/> {queue.filter((order) => order.status === "SUBMITTED").length} waiting</span></div>{queue.filter((order) => order.status === "SUBMITTED").length ? <div className="queue-list">{queue.filter((order) => order.status === "SUBMITTED").map((order) => <QueueItem key={order.id} order={order} pending={props.queuePendingIds.includes(String(order.id))} onAdvance={props.onAdvance} onDelete={props.onDeleteOrder}/>)}</div> : <div className="panel-empty">No new orders are waiting for acceptance.</div>}</section><section className="owner-panel" id="preparing-list"><div className="panel-heading"><div><span className="section-kicker">IN THE KITCHEN</span><h2>Preparing</h2></div><span className="queue-live"><i/> {queue.filter((order) => ["PREPARING", "ACCEPTED"].includes(order.status)).length} in progress</span></div>{queue.filter((order) => ["PREPARING", "ACCEPTED"].includes(order.status)).length ? <div className="queue-list">{queue.filter((order) => ["PREPARING", "ACCEPTED"].includes(order.status)).map((order) => <QueueItem key={order.id} order={order} pending={props.queuePendingIds.includes(String(order.id))} onAdvance={props.onAdvance}/>)}</div> : <div className="panel-empty">No orders are being prepared.</div>}</section><section className="owner-panel" id="ready-list"><div className="panel-heading"><div><span className="section-kicker">READY FOR COLLECTION</span><h2>Order ready</h2></div><span className="queue-live"><i/> {queue.filter((order) => order.status === "READY").length} awaiting pickup</span></div>{queue.filter((order) => order.status === "READY").length ? <div className="queue-list">{queue.filter((order) => order.status === "READY").map((order) => <QueueItem key={order.id} order={order} pending={props.queuePendingIds.includes(String(order.id))} onAdvance={props.onAdvance}/>)}</div> : <div className="panel-empty">No orders are ready for pickup.</div>}<PickupLookup queue={queue} pendingIds={props.queuePendingIds} onConfirm={props.onAdvance}/></section></div></> : <div className="panel-empty large">Queue access is not enabled for your account.</div>}<section className="owner-panel overview-availability"><div className="panel-heading"><div><span className="section-kicker">MENU STATUS</span><h2>Availability</h2></div><button onClick={() => setTab("Menu")}>Manage menu →</button></div>{items.map((item) => <div className="mini-menu-row" key={item.id}><MenuItemVisual item={item} className="mini-food"/><span><b>{item.name.replace("[DEV SAMPLE] ", "")}</b><small>{item.price_display}</small></span><AvailabilitySwitch item={item} disabled={!canToggle || props.availabilityPending.includes(item.id)} onToggle={props.onToggle}/></div>)}</section></section>}      {tab === "Cash receipts" && props.station === "cashier" && <section className="owner-content"><div className="panel-heading"><div><span className="section-kicker">PAY AT PICKUP</span><h2>Cash orders awaiting payment</h2></div><span className="queue-live"><i/> Shared cash desk queue</span></div>{queue.length ? <div className="queue-list">{queue.map((order) => <article className="queue-item" key={order.id}><div className="queue-number">{order.pickup_code}<small>Pickup number</small></div><div className="queue-details"><div><b>{human(order.status)} · {order.payment_status === "PAID" ? "Paid" : "Payment due"}</b><small>{orderCustomerLabel(order)}</small></div><p>{order.items.map((line, index) => <span key={`${order.id}-${index}`}>{line.quantity} × {line.name}</span>)}</p></div><div className="queue-amount">{order.total_display}</div>{order.payment_status !== "PAID" && <button className="blue-button queue-action" disabled={props.queuePendingIds.includes(String(order.id))} onClick={() => props.onMarkCashPaid(order)}>{props.queuePendingIds.includes(String(order.id)) ? "Saving…" : "Record cash received"}</button>}</article>)}</div> : <div className="panel-empty large">No unpaid cash orders right now.</div>}</section>}
      {tab === "Daily sales" && <section className="owner-content sales-report"><section className="owner-panel sales-report-heading"><div><span className="section-kicker">CANTEEN PERFORMANCE</span><h2>{salesDateLabel(salesDate)}</h2><p>Daily sales and item counts, based on orders recorded as paid.</p></div><label>Summary date<input aria-label="Summary date" type="date" max={pakistanDay()} value={salesDate} onChange={(event) => { const date = event.target.value; setSalesDate(date); if (isValidSalesDate(date)) props.onLoadSalesSummary(date); }}/></label></section><section className="owner-panel sales-date-panel"><div><span className="section-kicker">PAST SUMMARIES</span><h2>Previous day summaries</h2><p>Choose a date to open its saved daily results. Removing a summary keeps the underlying orders and payment records.</p></div><div className="sales-date-list">{props.salesSummaryDates.filter((date) => date < pakistanDay()).map((date) => <div className="sales-date-entry" key={date}><button type="button" className={`sales-date-open ${salesDate === date ? "selected" : ""}`} aria-pressed={salesDate === date} onClick={() => { setSalesDate(date); setSalesDeleteError(""); props.onLoadSalesSummary(date); }}><b>{salesDateLabel(date)}</b><span>Open summary →</span></button>{canManage && (salesDeleteConfirmDate === date ? <div className="sales-delete-confirm" role="group" aria-label={`Confirm removing ${salesDateLabel(date)} summary`}><span>Remove this summary? Order records stay.</span><div><button type="button" onClick={() => { setSalesDeleteConfirmDate(null); setSalesDeleteError(""); }} disabled={salesDeletePendingDate === date}>Cancel</button><button type="button" className="confirm" onClick={() => void removeSalesSummary(date)} disabled={salesDeletePendingDate === date}>{salesDeletePendingDate === date ? "Removing…" : "Remove"}</button></div></div> : <button type="button" className="sales-date-delete" aria-label={`Remove ${salesDateLabel(date)} summary`} title="Remove this summary" onClick={() => { setSalesDeleteError(""); setSalesDeleteConfirmDate(date); }}><span aria-hidden="true">×</span></button>)}</div>)}{!props.salesSummaryDates.some((date) => date < pakistanDay()) && <span className="sales-no-days">Previous dates will appear here when orders have been recorded.</span>}</div>{salesDeleteError && <p className="form-message error-message" role="alert">{salesDeleteError}</p>}</section>{salesDate && props.salesSummaryError && <div className="panel-empty large sales-report-error" role="alert"><b>Summary unavailable</b><p>{props.salesSummaryError}</p><button className="blue-button" onClick={() => { props.onLoadSalesDates(); if (isValidSalesDate(salesDate)) props.onLoadSalesSummary(salesDate); }}>Try again</button></div>}{salesDate && props.salesSummaryLoading && <div className="panel-empty large" role="status">Loading daily summary…</div>}{!salesDate ? <div className="panel-empty large">Choose a date to view its daily summary.</div> : !props.salesSummaryLoading && !props.salesSummaryError && props.salesSummary && <><div className="sales-kpi-grid"><article><span>PAID SALES</span><b>{money(props.salesSummary.paid_sales_paisa)}</b><small>Confirmed order payments</small></article><article><span>PAID ORDERS</span><b>{props.salesSummary.paid_orders}</b><small>Orders counted as sales</small></article><article><span>ITEMS SOLD</span><b>{props.salesSummary.units_sold}</b><small>Units in paid orders</small></article><article><span>ORDERS PLACED</span><b>{props.salesSummary.orders_placed}</b><small>{props.salesSummary.pending_payment_orders} still unpaid or pending</small></article></div><section className="owner-panel sales-items-panel"><div className="panel-heading"><div><span className="section-kicker">ITEM BREAKDOWN</span><h2>What sold</h2></div><span className="queue-live">{props.salesSummary.items_sold.length} item types</span></div>{props.salesSummary.items_sold.length ? <div className="sales-item-chart">{props.salesSummary.items_sold.map((item) => <div className="sales-item-bar" key={item.name}><b>{item.name}</b><div className="sales-item-track"><span style={{ width: `${Math.max(4, item.quantity / Math.max(1, ...props.salesSummary!.items_sold.map((entry) => entry.quantity)) * 100)}%` }}/></div><strong>{item.quantity}</strong></div>)}</div> : <div className="panel-empty">No paid items were recorded for this date.</div>}</section><div className="sales-bottom-grid"><section className="owner-panel"><span className="section-kicker">PAYMENT SPLIT</span><h2>Paid by method</h2>{props.salesSummary.payment_methods.length ? <div className="sales-method-list">{props.salesSummary.payment_methods.map((entry) => <div key={entry.method}><span><b>{human(entry.method)}</b><small>{entry.count} paid orders</small></span><strong>{money(entry.amount_paisa)}</strong></div>)}</div> : <div className="panel-empty">No confirmed payments for this date.</div>}</section><section className="owner-panel"><span className="section-kicker">ORDER ACTIVITY</span><h2>Placed that day</h2><div className="sales-activity-row"><span>Order value placed</span><b>{money(props.salesSummary.placed_order_value_paisa)}</b></div><div className="sales-activity-row"><span>Payment still due</span><b>{props.salesSummary.pending_payment_orders}</b></div><p className="sample-reminder">Unpaid or pending orders are not included in paid sales or items sold.</p></section></div></>}</section>}{tab === "Monthly sales" && <section className="owner-content sales-report monthly-sales-report"><section className="owner-panel sales-report-heading"><div><span className="section-kicker">MONTHLY PERFORMANCE & AUDIT</span><h2>{salesMonth ? new Date(`${salesMonth}-01T00:00:00Z`).toLocaleDateString("en-PK", { timeZone: "UTC", month: "long", year: "numeric" }) : "Monthly sales"}</h2><p>Compare paid sales, refunds, items, payment methods, and daily order activity for the selected month.</p></div><label>Sales month<input aria-label="Sales month" type="month" max={pakistanDay().slice(0, 7)} value={salesMonth} onChange={(event) => { const month = event.target.value; setSalesMonth(month); if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) props.onLoadMonthlySalesSummary(month); }}/></label></section><section className="owner-panel sales-date-panel"><div><span className="section-kicker">MONTH ARCHIVE</span><h2>Available months</h2><p>Choose a month to review its current audit totals. The report is recalculated from recorded orders and payment events.</p></div><div className="sales-date-list">{props.monthlySalesMonths.map((month) => <button type="button" className={`sales-date-open ${salesMonth === month ? "selected" : ""}`} key={month} aria-pressed={salesMonth === month} onClick={() => { setSalesMonth(month); props.onLoadMonthlySalesSummary(month); }}><b>{new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-PK", { timeZone: "UTC", month: "long", year: "numeric" })}</b><span>Open monthly audit →</span></button>)}{!props.monthlySalesMonths.length && <span className="sales-no-days">Monthly periods will appear once orders are recorded.</span>}</div></section>{props.monthlySalesError && <div className="panel-empty large sales-report-error" role="alert"><b>Monthly audit unavailable</b><p>{props.monthlySalesError}</p><button className="blue-button" onClick={() => { props.onLoadMonthlySalesMonths(); if (salesMonth) props.onLoadMonthlySalesSummary(salesMonth); }}>Try again</button></div>}{props.monthlySalesLoading && <div className="panel-empty large" role="status">Loading monthly sales audit…</div>}{!props.monthlySalesLoading && !props.monthlySalesError && props.monthlySalesSummary && <><div className="sales-kpi-grid"><article><span>NET SALES</span><b>{money(props.monthlySalesSummary.net_sales_paisa)}</b><small>Paid sales less refunds recorded this month</small></article><article><span>PAID SALES</span><b>{money(props.monthlySalesSummary.paid_sales_paisa)}</b><small>{props.monthlySalesSummary.paid_orders} paid orders</small></article><article><span>REFUNDS</span><b>{money(props.monthlySalesSummary.refunds_paisa)}</b><small>{props.monthlySalesSummary.refunds} refunds recorded</small></article><article><span>ITEMS SOLD</span><b>{props.monthlySalesSummary.units_sold}</b><small>{props.monthlySalesSummary.items_sold.length} item types in paid orders</small></article></div><section className="owner-panel sales-items-panel"><div className="panel-heading"><div><span className="section-kicker">ITEM BREAKDOWN</span><h2>Top items this month</h2></div><span className="queue-live">{props.monthlySalesSummary.items_sold.length} item types</span></div>{props.monthlySalesSummary.items_sold.length ? <div className="sales-item-chart">{props.monthlySalesSummary.items_sold.map((item) => <div className="sales-item-bar" key={item.name}><b>{item.name}</b><div className="sales-item-track"><span style={{ width: `${Math.max(4, item.quantity / Math.max(1, ...props.monthlySalesSummary!.items_sold.map((entry) => entry.quantity)) * 100)}%` }}/></div><strong>{item.quantity}</strong></div>)}</div> : <div className="panel-empty">No paid item sales were recorded for this month.</div>}</section><div className="sales-bottom-grid"><section className="owner-panel"><span className="section-kicker">PAYMENT AUDIT</span><h2>Paid by method</h2>{props.monthlySalesSummary.payment_methods.length ? <div className="sales-method-list">{props.monthlySalesSummary.payment_methods.map((entry) => <div key={entry.method}><span><b>{human(entry.method)}</b><small>{entry.count} paid orders</small></span><strong>{money(entry.amount_paisa)}</strong></div>)}</div> : <div className="panel-empty">No confirmed payments for this month.</div>}</section><section className="owner-panel"><span className="section-kicker">ORDER RECONCILIATION</span><h2>Monthly totals</h2><div className="sales-activity-row"><span>Order value placed</span><b>{money(props.monthlySalesSummary.placed_order_value_paisa)}</b></div><div className="sales-activity-row"><span>Orders placed</span><b>{props.monthlySalesSummary.orders_placed}</b></div><div className="sales-activity-row"><span>Payment still due</span><b>{props.monthlySalesSummary.pending_payment_orders}</b></div><div className="sales-activity-row"><span>Net sales</span><b>{money(props.monthlySalesSummary.net_sales_paisa)}</b></div><p className="sample-reminder">Cancelled orders are excluded from orders placed. Pending payments are not counted as sales. Refunds are shown separately and subtracted from net sales.</p></section></div><section className="owner-panel monthly-audit-panel"><div className="panel-heading"><div><span className="section-kicker">DAILY AUDIT TRAIL</span><h2>Day-by-day activity</h2></div><span className="queue-live">{props.monthlySalesSummary.daily_breakdown.length} active days</span></div>{props.monthlySalesSummary.daily_breakdown.length ? <div className="monthly-audit-list">{props.monthlySalesSummary.daily_breakdown.map((day) => <article key={day.date}><b>{salesDateLabel(day.date)}</b><span>{day.orders_placed} placed · {day.paid_orders} paid · {day.units_sold} items</span><div className="monthly-audit-track" aria-hidden="true"><span style={{ width: `${Math.max(3, day.paid_sales_paisa / Math.max(1, ...props.monthlySalesSummary!.daily_breakdown.map((entry) => entry.paid_sales_paisa)) * 100)}%` }}/></div><strong>{money(day.paid_sales_paisa)}</strong><small>{day.pending_payment_orders} unpaid</small></article>)}</div> : <div className="panel-empty">No order activity was recorded for this month.</div>}<p className="sample-reminder">Audit generated {new Date(props.monthlySalesSummary.generated_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })}. Removing a saved daily summary does not delete the underlying order or payment records used here.</p></section></>}</section>}      {tab === "Orders history" && <section className="owner-content"><div className="panel-heading"><div><span className="section-kicker">COMPLETED COLLECTIONS</span><h2>Orders history</h2></div><button onClick={props.onLoadHistory}>↻ Refresh history</button></div>{props.orderHistory.length ? <div className="queue-list">{props.orderHistory.map((order) => { const pending = props.queuePendingIds.includes(String(order.id)); const paymentMethod = String(order.payment_method || "cash").trim().toLowerCase(); const eligible = paymentMethod === "wallet" || String(order.payment_status || "").trim().toUpperCase() === "PAID"; const cancelled = order.status === "CANCELLED"; const voided = order.status === "VOIDED"; return <article className={`queue-item history-item${cancelled ? " history-cancelled" : ""}${voided ? " history-voided" : ""}`} key={order.id}><div className="queue-number">{order.pickup_code}<small>Pickup number</small></div><div className="queue-details"><div><b className={cancelled ? "history-status-cancelled" : undefined}>{voided ? "Voided · recoverable" : cancelled ? "Cancelled" : order.refund_status === "REFUNDED" ? "Refunded" : "Collected"}</b><small>{voided ? `Removed by ${order.voided_by || "manager"} · ` : cancelled ? "Cancelled by the customer · " : ""}{new Date((voided ? order.voided_at : cancelled ? order.cancelled_at : order.completed_at) ?? order.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} · {human(order.payment_method || "cash")} · {human(order.payment_status || "unpaid")}</small>{voided && order.void_reason && <small>Reason: {order.void_reason}</small>}{order.refunded_at && <small>Refunded {new Date(order.refunded_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} · {human(order.refund_method || "wallet")}</small>}</div><p>{order.items.map((line, index) => <span key={`${order.id}-${index}`}>{line.quantity} × {line.name}</span>)}</p><small className="queue-student-id">{orderCustomerLabel(order)}</small></div><div className="queue-amount">{order.total_display}</div><div className="history-actions"><button type="button" className="receipt-print-button" onClick={() => setReceiptRequest({ order, key: crypto.randomUUID() })} aria-label={`Print receipt for order ${order.pickup_code}`} title="Print receipt">▤</button>{canManage && !voided && order.refund_status !== "REFUNDED" && <button type="button" className="history-refund-button" disabled={pending || !eligible} onClick={() => props.onRefundHistoryOrder(order)} title={!eligible ? paymentMethod === "cash" ? "Record cash received in Cash Desk before refunding" : "This payment is not marked as paid" : paymentMethod === "wallet" ? "Return funds to the student's wallet" : "Record that the payment was returned manually"} aria-label={`Refund order ${order.pickup_code}`}>{pending ? "…" : paymentMethod === "wallet" ? "Refund to wallet" : "Record refund"}</button>}{order.refund_status === "REFUNDED" && <span className="refund-complete-label">Refunded</span>}{canManage && (voided ? <button type="button" className="history-restore-button" disabled={pending} onClick={() => props.onRestoreHistoryOrder(order)} aria-label={`Restore order ${order.pickup_code}`} title="Restore order">↶ Restore</button> : <button type="button" className="history-delete-button" disabled={pending} onClick={() => props.onDeleteHistoryOrder(order)} aria-label={`Void order ${order.pickup_code}`} title="Keep in audit history">⌫</button>)}</div></article>; })}</div> : <div className="panel-empty large">No completed orders have been recorded yet.</div>}</section>}{tab === "Menu" && <section className="owner-content"><div className="owner-columns"><section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">CATALOGUE</span><h2>Menu items</h2></div><span className="queue-live">{items.length} items</span></div>{props.canSortMenu && <p className="menu-sort-help">Drag the grip or use the arrows to reorder items within their category. The new order is saved for everyone.</p>}{items.map((item) => <div className="menu-admin-row" data-menu-item-id={item.id} key={item.id} onDragOver={(event) => { if (props.canSortMenu) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const sourceId = Number(event.dataTransfer.getData("text/plain")); if (sourceId) props.onReorderMenuItems(sourceId, item.id); }}><div className="menu-admin-name">{props.canSortMenu && <MenuSortHandle item={item} items={items.filter((entry) => entry.category_id === item.category_id)} disabled={props.menuMutationPending} onMove={props.onReorderMenuItems}/>}<MenuItemVisual item={item} className="mini-food"/><span><b>{item.name}</b><small>{item.category} · {item.quick_allowed ? "Quick pickup" : "Prepared"}{item.addon_name ? ` · Extra: ${item.addon_name} (+${money(item.addon_price_paisa ?? 0)})` : ""}</small></span></div><form className="price-edit" onSubmit={(event) => { event.preventDefault(); props.onPrice(item, event.currentTarget); }}><span>Rs</span><input aria-label={`Price for ${item.name}`} name="price" type="number" min="0" step="1" defaultValue={Math.round(item.price_paisa / 100)} disabled={!canManage || props.menuMutationPending}/><button disabled={!canManage || props.menuMutationPending}>Save</button></form><AvailabilitySwitch item={item} disabled={!canToggle || props.availabilityPending.includes(item.id)} onToggle={props.onToggle}/><button type="button" className="menu-edit-icon" disabled={!canManage || props.menuMutationPending} aria-label={`Edit ${item.name}`} title="Edit menu item" onClick={() => setEditingMenuItemId(item.id)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5 3 3M4 16l3.5-.8L16 6.7a1.4 1.4 0 0 0-2-2l-8.5 8.5L4 16Z"/></svg></button>{editingMenuItemId === item.id && <div className="menu-edit-scrim" onClick={() => setEditingMenuItemId(null)}><section className="menu-edit-modal" role="dialog" aria-modal="true" aria-labelledby="menu-edit-title" onClick={(event) => event.stopPropagation()}><header><div><span className="section-kicker">MENU ITEM</span><h2 id="menu-edit-title">Edit {item.name}</h2></div><button type="button" aria-label="Close edit form" onClick={() => setEditingMenuItemId(null)}>×</button></header><MenuItemEditForm item={item} categories={categories} saving={props.menuMutationPending} onCancel={() => setEditingMenuItemId(null)} onSave={props.onUpdateItem} /></section></div>}{canManage && (removeConfirmId === item.id ? <div className="menu-remove-confirm" role="group" aria-label={`Confirm removing ${item.name}`}><span>Remove <b>{item.name}</b>? Orders stay in history.</span><button type="button" className="menu-remove-cancel" disabled={props.menuMutationPending} onClick={() => setRemoveConfirmId(null)}>Cancel</button><button type="button" className="menu-remove-confirm-button" disabled={props.menuMutationPending} onClick={() => { void props.onRemoveItem(item).then((removed) => { if (removed) setRemoveConfirmId(null); }); }}>{props.menuMutationPending ? "Removing…" : "Confirm remove"}</button></div> : <button type="button" className="menu-remove-trigger" disabled={props.menuMutationPending} aria-label={`Remove ${item.name} from menu`} onClick={() => setRemoveConfirmId(item.id)} title={`Remove ${item.name}`}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2m2 0-.7 10H6.7L6 6m2.5 2.5v5m3-5v5"/></svg></button>)}</div>)}{!items.length && <p className="panel-empty">No menu items yet.</p>}</section><div className="owner-form-stack"><section className="owner-panel form-panel"><span className="section-kicker">ADD TO MENU</span><h2>New item</h2>{canManage ? <form className="owner-form" onSubmit={(event) => void props.onAddItem(event)}><label>Item name<input name="name" required maxLength={120} placeholder="e.g. Chicken burger"/></label><label>Category<select name="category_id" required defaultValue="">{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Description<textarea name="description" rows={2} placeholder="What should students know?"/></label><label>Price in PKR<input name="price" type="number" min="0" step="1" required placeholder="350"/></label><label>Optional add-on name<input name="addon_name" maxLength={80} placeholder="e.g. Fries, extra cheese, sauce"/></label><label>Add-on extra price (PKR)<input name="addon_price" type="number" min="0" step="1" placeholder="e.g. 150"/><small>Charged on top of the item price only when the student chooses it.</small></label><MenuOptionsEditor/><div className="check-row"><label><input type="checkbox" name="quick"/> Quick pickup</label><label><input type="checkbox" name="scheduled" defaultChecked/> Prepared order</label></div><label>Preparation time (minutes)<input name="prep_minutes" type="number" min="0" max="240" placeholder="Optional"/></label><label>Item image (optional)<input ref={itemImageInput} type="file" accept="image/*" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; const version = ++itemImageLoadVersion.current; setNewItemImageError(""); if (!file) { setNewItemImage(""); setNewItemImageLoading(false); return; } setNewItemImageLoading(true); void resizeMenuImage(file).then((image) => { if (version === itemImageLoadVersion.current) setNewItemImage(image); }).catch((error) => { if (version === itemImageLoadVersion.current) { setNewItemImageError(error instanceof Error ? error.message : "This image could not be loaded."); input.value = ""; } }).finally(() => { if (version === itemImageLoadVersion.current) setNewItemImageLoading(false); }); }}/><small>Choose a photo to display on the student menu. It will be resized automatically.</small></label>{newItemImageLoading && <p className="form-message" role="status">Preparing image…</p>}{newItemImage && <div className="item-image-preview"><img src={newItemImage} alt="Preview of the menu item"/><button type="button" onClick={() => { itemImageLoadVersion.current += 1; setNewItemImage(""); setNewItemImageLoading(false); if (itemImageInput.current) itemImageInput.current.value = ""; }}>Remove image</button></div>}<input type="hidden" name="image_data" value={newItemImage}/>{newItemImageError && <p className="form-message error-message" role="alert">{newItemImageError}</p>}{props.itemMessage && <p className="form-message">{props.itemMessage}</p>}<button className="blue-button" disabled={props.itemAddPending || props.menuMutationPending || newItemImageLoading}>{newItemImageLoading ? "Preparing image…" : props.itemAddPending ? "Adding…" : "Add menu item"}</button></form> : <p className="panel-empty">Only menu managers can add or edit menu items.</p>}</section><section className="owner-panel form-panel"><span className="section-kicker">ORGANISE MENU</span><h2>New category</h2>{canManage ? <form className="inline-category" onSubmit={(event) => { event.preventDefault(); props.onAddCategory(event.currentTarget); }}><input name="category" required maxLength={80} placeholder="e.g. Hot drinks"/><button className="blue-button" disabled={props.menuMutationPending}>Add category</button></form> : <p className="panel-empty">Manager access required.</p>}<div className="category-manage-list"><span className="section-kicker">EXISTING CATEGORIES</span>{props.canSortMenu && <p className="menu-sort-help">Use the arrows to set the category sequence shown on the student menu and counter.</p>}{categories.map((category) => <div className="category-manage-row" key={category.id}>{props.canSortMenu && <CategorySortControls category={category} categories={categories} disabled={props.menuMutationPending} onMove={props.onReorderMenuCategories}/>}<div className="category-manage-copy"><b>{category.name}</b><small>{category.items.length} {category.items.length === 1 ? "menu item" : "menu items"}</small></div>{canManage && (removeCategoryConfirmId === category.id ? <div className="category-remove-confirm" role="group" aria-label={`Confirm removing ${category.name} category`}><span>{category.items.length ? `Move ${category.items.length} ${category.items.length === 1 ? "item" : "items"} before removing this category.` : "Remove this empty category?"}</span>{category.items.length > 0 && <label>Move items to<select aria-label={`Move ${category.name} items to`} value={removeCategoryTargetId ?? ""} onChange={(event) => setRemoveCategoryTargetId(Number(event.target.value) || null)}><option value="">Choose category</option>{categories.filter((target) => target.id !== category.id).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>}<button type="button" onClick={() => { setRemoveCategoryConfirmId(null); setRemoveCategoryTargetId(null); }} disabled={props.menuMutationPending}>Cancel</button><button type="button" className="confirm" disabled={props.menuMutationPending || (category.items.length > 0 && removeCategoryTargetId == null)} onClick={() => { void props.onRemoveCategory(category, category.items.length > 0 ? removeCategoryTargetId ?? undefined : undefined).then((removed) => { if (removed) { setRemoveCategoryConfirmId(null); setRemoveCategoryTargetId(null); } }); }}>{props.menuMutationPending ? "Saving…" : "Remove"}</button></div> : <button type="button" className="category-remove-trigger" disabled={props.menuMutationPending || categories.length <= 1} aria-label={`Remove ${category.name} category`} title={categories.length <= 1 ? "At least one category must remain" : "Remove category"} onClick={() => { setRemoveCategoryConfirmId(category.id); setRemoveCategoryTargetId(categories.find((target) => target.id !== category.id)?.id ?? null); }}>Remove</button>)}{categories.length <= 1 && <small className="category-remove-hint">Keep at least one category.</small>}</div>)}</div></section></div></div><p className="sample-reminder">Menu items and prices are shared with the student ordering page and counter.</p></section>}
      {tab === "Homepage banner" && isDeveloper && canCustomize && <HeroSlidesEditor slides={props.heroSlides} message={props.heroSlidesMessage} pending={props.heroSlidesPending} onSave={props.onSaveHeroSlides}/>}
      {tab === "Wallet top-ups" && props.canTopUp && <section className="owner-content"><div className="owner-columns"><section className="owner-panel form-panel"><span className="section-kicker">CASH RECEIVED AT COUNTER</span><h2>Credit a student wallet</h2><p className="sample-reminder">Accept the cash first, then enter the student ID and amount. {user?.role === "DEMO_CANTEEN" ? "Credits are saved to the shared wallet ledger with your staff account and time." : "Each credit is saved to the shared wallet ledger with your staff account and time."}</p><form className="owner-form" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; if (await props.onCashTopUp(form)) { topUpStudentLookupVersion.current += 1; setTopUpStudentId(""); setTopUpStudent(null); setTopUpStudentConfirmed(false); setTopUpStudentLookupError(""); } }}><label>7-digit student ID<input name="student_id" inputMode="numeric" pattern="[0-9]{7}" minLength={7} maxLength={7} required placeholder="e.g. 2028246" value={topUpStudentId} onChange={(event) => { const id = event.target.value.replace(/\D/g, "").slice(0, 7); topUpStudentLookupVersion.current += 1; setTopUpStudentId(id); setTopUpStudent(null); setTopUpStudentConfirmed(false); setTopUpStudentLookupError(""); if (id.length === 7) void lookupTopUpStudent(id); }}/></label>{topUpStudentLookupBusy && <p className="form-message" role="status">Checking the Cedar student account…</p>}{topUpStudent && topUpStudent.student_id === topUpStudentId && <div className="student-profile-confirm"><b>{topUpStudent.full_name}</b><span>Student ID {topUpStudent.student_id}</span><label><input type="checkbox" name="student_confirmed" required checked={topUpStudentConfirmed} onChange={(event) => setTopUpStudentConfirmed(event.target.checked)}/> I verified this name with the student.</label></div>}{topUpStudentLookupError && <p className="form-message error-message" role="alert">{topUpStudentLookupError}</p>}<label>Cash received (PKR)<input name="amount" type="number" min="50" max="5000" step="1" required placeholder="e.g. 500"/></label><label>Note (optional)<input name="note" maxLength={160} placeholder="Cash received at counter"/></label>{props.walletMessage && <p className="form-message" role="status">{props.walletMessage}</p>}<button className="blue-button" disabled={props.walletPending || !topUpStudentConfirmed || topUpStudent?.student_id !== topUpStudentId}>{props.walletPending ? "Recording…" : "Confirm and add credits"}</button></form></section><section className="owner-panel"><span className="section-kicker">HOW THIS CREDIT WORKS</span><h2>Recorded to one student</h2><p>{user?.role === "DEMO_CANTEEN" ? "The seven-digit ID matches the student account. The credit appears in the student wallet after sign-in." : "The seven-digit ID is matched to the student’s Cedar email account. The credit appears in their wallet activity and balance after they sign in. The server records the staff account, amount, and timestamp."}</p><p className="sample-reminder">Use this only after cash has actually been received. Credits are permanent ledger entries; corrections should be handled through an audited adjustment process.</p></section></div></section>}
      {tab === "Wallet top-up history" && props.canTopUp && <section className="owner-content"><div className="panel-heading"><div><span className="section-kicker">WALLET LEDGER</span><h2>Wallet top-up history</h2></div><button onClick={props.onLoadWalletTopUpHistory} disabled={props.walletHistoryLoading}>{props.walletHistoryLoading ? "Loading…" : "↻ Refresh history"}</button></div>{props.walletHistoryError ? <div className="panel-empty large" role="alert"><b>History could not be loaded.</b><p>{props.walletHistoryError}</p><button className="blue-button" onClick={props.onLoadWalletTopUpHistory} disabled={props.walletHistoryLoading}>Try again</button></div> : props.walletHistoryLoading ? <div className="panel-empty large" role="status">Loading recorded wallet top-ups…</div> : props.walletTopUpHistory.length ? <div className="queue-list">{props.walletTopUpHistory.map((entry) => <article className="queue-item history-item" key={entry.id}><div className="queue-number">ID {entry.student_id}<small>Student account</small></div><div className="queue-details"><div><b>{entry.label || "Wallet top-up"}</b><small>{new Date(entry.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} · {entry.method ? human(entry.method) : "Cash at counter"} · {entry.recorded_by || "cashier"}</small><small>{(entry.status === "PAYMENT_NOT_RECEIVED" || entry.recorded_by === "student dashboard") ? "Payment not received" : entry.status === "REFUNDED" ? "Wallet refund issued" : "Cash recorded"}</small></div></div><div className={`queue-amount ${entry.kind === "debit" ? "wallet-debit" : "wallet-credit"}`}>{entry.kind === "debit" ? "−" : "+"}{money(entry.amount_paisa)}</div></article>)}</div> : <div className="panel-empty large">No wallet top-ups have been recorded yet.</div>}<p className="sample-reminder">Online transfers are not verified by CedarBite. Do not treat a selected provider as confirmation that funds were received.</p></section>}
      {tab === "Refunds" && props.station === "cashier" && <section className="owner-content"><div className="panel-heading"><div><span className="section-kicker">COMPLETED ORDERS</span><h2>Refunds</h2><p>Review collected orders and record a refund after it has been returned.</p></div><button type="button" onClick={props.onLoadHistory}>↻ Refresh</button></div>{refundOrders.length ? <div className="queue-list">{refundOrders.map((order) => <article className="queue-item history-item" key={order.id}><div className="queue-number">{order.pickup_code}<small>Pickup number</small></div><div className="queue-details"><div><b>{orderCustomerLabel(order)}</b><small>{new Date(order.completed_at ?? order.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} · {human(order.payment_method ?? "cash")} · {human(order.payment_status ?? "unpaid")}</small><p>{order.items.map((line, index) => <span key={`${order.id}-${index}`}>{line.quantity} × {line.name}</span>)}</p></div></div><div className="queue-amount">{order.total_display}</div>{order.refund_status === "REFUNDED" ? <span className="status-pill status-refunded">Refund recorded</span> : (order.payment_method === "wallet" || order.payment_status === "PAID") ? <button type="button" className="queue-action" disabled={props.queuePendingIds.includes(String(order.id))} onClick={() => props.onRefundHistoryOrder(order)}>{props.queuePendingIds.includes(String(order.id)) ? "Recording…" : "Record refund"}</button> : <small className="refund-payment-note">Refund requires a recorded payment.</small>}</article>)}</div> : <div className="panel-empty large">No completed orders are available for refunds.</div>}</section>}
      {tab === "Item of the day" && isDeveloper && <ItemOfDayEditor schedule={props.itemOfDaySchedule} message={props.itemOfDayMessage} pending={props.itemOfDayPending} canManage={canCustomize} onSave={props.onSaveItemOfDaySchedule} />}
      {tab === "Staff passwords" && isDeveloper && <section className="owner-content"><div className="owner-columns"><section className="owner-panel form-panel"><span className="section-kicker">STAFF ACCESS</span><h2>Reset a station password</h2><p>Reset the Counter, Cash desk, or Kitchen monitor password. The order manager password is changed separately in Netlify settings to preserve its recovery path.</p><ResetStationPasswordForm onReset={props.onResetPassword}/></section><section className="owner-panel"><span className="section-kicker">DEVELOPER ACCOUNT</span><h2>Protect this area</h2><p>Use the Change password control above to update the developer login. If account recovery is needed, set <code>CANTEEN_DEVELOPER_PASSWORD</code> in Netlify environment variables, then sign in with the recovered password.</p></section></div></section>}
      {tab === "Export" && isDeveloper && <DeveloperExport onExportData={props.onExportData} items={props.items}/>}
      </>}
      {receiptRequest && <ReceiptPrintView order={receiptRequest.order}/>}
    </div></div>;
}

function DeveloperInsights({ salesSummary, monthlySalesSummary, dailyLoading, monthlyLoading, dailyError, monthlyError, onLoadDaily, onLoadMonthly, onOpenDaily, onOpenMonthly, onOpenExport, onOpenCustomize, temporaryOpening, temporaryOpeningPending, onToggleTemporaryOpening }: {
  salesSummary: SalesSummary | null; monthlySalesSummary: MonthlySalesSummary | null; dailyLoading: boolean; monthlyLoading: boolean; dailyError: string; monthlyError: string;
  onLoadDaily: () => void; onLoadMonthly: () => void; onOpenDaily: () => void; onOpenMonthly: () => void; onOpenExport: () => void; onOpenCustomize: () => void;
  temporaryOpening: boolean; temporaryOpeningPending: boolean; onToggleTemporaryOpening: (enabled: boolean) => Promise<void>;
}) {
  useEffect(() => { onLoadDaily(); onLoadMonthly(); }, [onLoadDaily, onLoadMonthly]);
  const bestItems = salesSummary?.items_sold.slice(0, 6) ?? [];
  const monthDays = monthlySalesSummary?.daily_breakdown.slice(-14) ?? [];
  const highestDay = Math.max(1, ...monthDays.map((entry) => entry.paid_sales_paisa));
  return <section className="owner-content developer-insights"><div className="owner-panel developer-welcome"><span className="section-kicker">PRIVATE MAINTENANCE SPACE</span><h2>CedarBite at a glance</h2><p>Review sales performance and maintain site content when a change is needed. Day-to-day canteen work stays in the staff stations.</p><div className="developer-quick-actions"><button type="button" onClick={onOpenDaily}>Daily analysis <span>↗</span></button><button type="button" onClick={onOpenMonthly}>Monthly analysis <span>↗</span></button><button type="button" onClick={onOpenExport}>Export workbook <span>↗</span></button><button type="button" onClick={onOpenCustomize}>Website content <span>↗</span></button></div></div>
    <section className={`owner-panel temporary-opening-panel ${temporaryOpening ? "is-open" : ""}`}><div><span className="section-kicker">OPERATING HOURS</span><h2>{temporaryOpening ? "Canteen is open temporarily" : "Temporary opening"}</h2><p>{temporaryOpening ? "All interfaces are active while this temporary opening is on." : "For an approved opening outside the regular Monday–Thursday, 8:00 AM–5:00 PM schedule. All interfaces, including student ordering and the cash desk, will be available."}</p></div><button type="button" className={temporaryOpening ? "temporary-opening-close" : "blue-button temporary-opening-open"} disabled={temporaryOpeningPending} onClick={() => void onToggleTemporaryOpening(!temporaryOpening)}>{temporaryOpeningPending ? "Saving…" : temporaryOpening ? "Close temporary opening" : "Open temporarily"}</button></section>
    <div className="sales-kpi-grid developer-kpis" aria-busy={dailyLoading || monthlyLoading}><article><span>TODAY · PAID SALES</span><b>{dailyLoading ? "…" : money(salesSummary?.paid_sales_paisa ?? 0)}</b><small>{salesSummary?.date || pakistanDay()}</small></article><article><span>TODAY · PAID ORDERS</span><b>{dailyLoading ? "…" : salesSummary?.paid_orders ?? 0}</b><small>Recorded as paid</small></article><article><span>THIS MONTH · PAID SALES</span><b>{monthlyLoading ? "…" : money(monthlySalesSummary?.paid_sales_paisa ?? 0)}</b><small>{monthlySalesSummary?.month || pakistanDay().slice(0, 7)}</small></article><article><span>THIS MONTH · ITEMS SOLD</span><b>{monthlyLoading ? "…" : monthlySalesSummary?.units_sold ?? 0}</b><small>{monthlySalesSummary?.paid_orders ?? 0} paid orders</small></article></div>
    {(dailyError || monthlyError) && <div className="panel-empty large" role="alert">{dailyError || monthlyError}</div>}
    <div className="developer-chart-grid"><section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">MONTHLY TREND</span><h2>Paid sales by day</h2></div><button type="button" onClick={onOpenMonthly}>Open monthly audit →</button></div>{monthDays.length ? <div className="sales-item-chart developer-daily-bars">{monthDays.map((entry) => <div className="sales-item-bar" key={entry.date}><b>{new Date(`${entry.date}T12:00:00.000Z`).toLocaleDateString("en-PK", { timeZone: "Asia/Karachi", day: "numeric", month: "short" })}</b><div className="sales-item-track"><span style={{ width: `${Math.max(3, entry.paid_sales_paisa / highestDay * 100)}%` }}/></div><strong>{money(entry.paid_sales_paisa)}</strong></div>)}</div> : <div className="panel-empty">{monthlyLoading ? "Loading monthly sales…" : "Monthly sales will appear here when the report loads."}</div>}</section>
      <section className="owner-panel"><div className="panel-heading"><div><span className="section-kicker">TODAY'S BEST SELLERS</span><h2>Items sold</h2></div><button type="button" onClick={onOpenDaily}>Open daily report →</button></div>{bestItems.length ? <div className="sales-item-chart">{bestItems.map((item) => <div className="sales-item-bar" key={item.name}><b>{item.name}</b><div className="sales-item-track"><span style={{ width: `${Math.max(4, item.quantity / Math.max(1, ...bestItems.map((entry) => entry.quantity)) * 100)}%` }}/></div><strong>{item.quantity}</strong></div>)}</div> : <div className="panel-empty">{dailyLoading ? "Loading today’s paid item sales…" : "No paid item sales have been recorded for today."}</div>}</section></div>
  </section>;
}

function DeveloperExport({ onExportData, items }: { onExportData: (from: string, to: string) => Promise<DeveloperExportPayload>; items: (Item & { category: string })[] }) {
  const [to, setTo] = useState(pakistanDay());
  const [from, setFrom] = useState(() => { const date = new Date(); date.setDate(date.getDate() - 30); return pakistanDay(date); });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function downloadWorkbook() {
    setMessage(""); setError("");
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    if (!isValidSalesDate(from) || !isValidSalesDate(to) || from > to || to > pakistanDay() || span > 31) { setError("Choose a valid date range of up to 31 days, ending today or earlier."); return; }
    setBusy(true);
    try {
      let data: DeveloperExportPayload;
      try { data = await onExportData(from, to); }
      catch (caught) {
        const reason = caught instanceof Error ? caught.message : "";
        const localServiceUnavailable = caught instanceof ApiResponseError && caught.localServiceUnavailable;
        if (IS_NETLIFY_HOSTED || (!localServiceUnavailable && !/SUPABASE_SECRET_KEY/i.test(reason))) throw caught;
        const pkDay = (value: string) => {
          const date = new Date(value);
          return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(date) : "";
        };
        const localOrders = readLocalOrderQueue()
          .filter((order) => { const day = pkDay(order.created_at); return day && day >= from && day <= to; })
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        data = {
          period: { from, to, timezone: "Asia/Karachi", generated_at: new Date().toISOString() },
          orders: localOrders.map((order) => ({
            order_id: String(order.id), pickup_number: order.pickup_code, placed_at: order.created_at,
            completed_at: order.completed_at ?? "", customer_type: order.customer_type ?? "",
            student_id: order.customer_type === "STUDENT" ? order.student_id ?? "" : "",
            customer_name: order.customer_name ?? "", source: order.source ?? "LOCAL", order_type: order.mode,
            status: order.status, items: order.items.map((item) => `${item.quantity} × ${item.name}`).join("; "),
            units: order.items.reduce((sum, item) => sum + item.quantity, 0), total_paisa: order.total_paisa ?? 0,
            payment_method: order.payment_method ?? "", payment_status: order.payment_status ?? "",
            refunded: order.refund_status === "REFUNDED", refund_amount_paisa: order.refund_amount_paisa ?? 0,
            refunded_at: order.refunded_at ?? "",
          })), sales_by_day: [], sales_by_month: [], wallet_entries: [],
          menu_items: items.map((item) => ({ section: item.category, name: item.name, description: item.description, price_paisa: item.price_paisa, available: item.available, pickup_type: [item.quick_allowed && "Quick", item.scheduled_allowed && "Scheduled"].filter(Boolean).join(" + "), options: (item.options ?? []).map((option) => `${option.name}${option.available ? "" : " (out of stock)"}`).join("; "), image_available: Boolean(item.image_data) })),
        };
      }
      const { Workbook } = await import("exceljs");
      const workbook = new Workbook();
      workbook.creator = "CedarBite";
      workbook.subject = "Canteen operations export";
      workbook.created = new Date();
      const overview = workbook.addWorksheet("Overview");
      overview.columns = [{ width: 32 }, { width: 48 }];
      overview.addRows([
        ["CEDARBITE · OPERATIONS EXPORT", ""], ["Period", `${data.period.from} to ${data.period.to}`],
        ["Created", new Date(data.period.generated_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })],
        ["Included", "Daily and monthly sales analysis, order history, wallet ledger, and current menu."],
        ["Order dates", "Orders are selected by their placement date within the chosen period."],
        ["Order rows included", data.orders.length],
        ["Customer details", "Student rows include their student ID and name. Teacher rows include name only. Email addresses and account IDs are excluded."],
        ["Sales totals", "Sales sheets show payments recorded within each report day for orders placed in the selected period."],
        ["Wallet records", "Wallet activity is filtered by its recorded timestamp; IDs are retained for audit matching."],
        ["Menu", "This is the current menu and Item of the day schedule, not a historical menu snapshot."],
      ]);
      overview.getRow(1).font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
      overview.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF102B4C" } };
      overview.eachRow((row, index) => { if (index > 1) row.getCell(1).font = { bold: true, color: { argb: "FF102B4C" } }; });
      function addSheet(name: string, headers: string[], rows: (string | number | boolean)[][]) {
        const sheet = workbook.addWorksheet(name);
        sheet.addRow(headers);
        rows.forEach((row) => sheet.addRow(row));
        sheet.columns = headers.map((header) => ({ header, width: Math.max(14, Math.min(34, header.length + 5)) }));
        sheet.views = [{ state: "frozen", ySplit: 1 }];
        if (sheet.rowCount > 1) sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(sheet.columnCount).letter}1` };
        const header = sheet.getRow(1);
        header.font = { bold: true, color: { argb: "FFFFFFFF" } };
        header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF102B4C" } };
        return sheet;
      }
      const asText = (value: unknown) => value == null ? "" : String(value);
      const asNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
      addSheet("Daily sales", ["Date", "Orders placed", "Placed value (PKR)", "Paid orders", "Paid sales (PKR)", "Pending payment", "Units sold"], data.sales_by_day.map((row) => [row.date, row.orders_placed, row.placed_order_value_paisa / 100, row.paid_orders, row.paid_sales_paisa / 100, row.pending_payment_orders, row.units_sold]));
      addSheet("Monthly sales", ["Month", "Orders placed", "Placed value (PKR)", "Paid orders", "Paid sales (PKR)", "Refunds", "Refunded (PKR)", "Net sales (PKR)", "Units sold"], data.sales_by_month.map((row) => [row.month, row.orders_placed, row.placed_order_value_paisa / 100, row.paid_orders, row.paid_sales_paisa / 100, row.refunds, row.refunds_paisa / 100, row.net_sales_paisa / 100, row.units_sold]));
      addSheet("Item sales", ["Date", "Item", "Quantity sold"], data.sales_by_day.flatMap((day) => day.items_sold.map((item) => [day.date, item.name, item.quantity])));
      addSheet("Payment methods", ["Date", "Method", "Paid orders", "Amount (PKR)"], data.sales_by_day.flatMap((day) => day.payment_methods.map((entry) => [day.date, entry.method, entry.count, entry.amount_paisa / 100])));
      addSheet("Order history", ["Order ID", "Pickup number", "Placed at", "Completed at", "Customer type", "Student ID", "Customer name", "Source", "Order type", "Status", "Items", "Units", "Total (PKR)", "Payment method", "Payment status", "Refunded", "Refund (PKR)", "Refunded at"], data.orders.map((row) => [asText(row.order_id), asText(row.pickup_number), asText(row.placed_at), asText(row.completed_at), asText(row.customer_type), asText(row.student_id), asText(row.customer_name), asText(row.source), asText(row.order_type), asText(row.status), asText(row.items), asNumber(row.units), asNumber(row.total_paisa) / 100, asText(row.payment_method), asText(row.payment_status), Boolean(row.refunded), asNumber(row.refund_amount_paisa) / 100, asText(row.refunded_at)]));
      addSheet("Wallet ledger", ["Date", "Student ID", "Entry", "Amount (PKR)", "Method", "Description", "Recorded by", "Order ID", "Entry ID"], data.wallet_entries.map((row) => [asText(row.created_at), asText(row.student_id), asText(row.kind), asNumber(row.amount_paisa) / 100, asText(row.method), asText(row.label), asText(row.recorded_by), asText(row.order_id), asText(row.id)]));
      addSheet("Menu", ["Section", "Item", "Description", "Price (PKR)", "Available", "Pickup type", "Choices", "Image saved"], data.menu_items.map((row) => [asText(row.section), asText(row.name), asText(row.description), asNumber(row.price_paisa) / 100, Boolean(row.available), asText(row.pickup_type), asText(row.options), Boolean(row.image_available)]));
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl; anchor.download = `CedarBite_Operations_${data.period.from}_${data.period.to}.xlsx`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setMessage("Workbook downloaded.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The workbook could not be created."); }
    finally { setBusy(false); }
  }
  return <section className="owner-content developer-export"><header className="developer-page-heading"><span className="section-kicker">REPORTS & DATA</span><h2>Export CedarBite data</h2><p>Download one Excel workbook with the analysis and operational records needed for review and reconciliation.</p></header><section className="owner-panel developer-export-panel"><div className="developer-export-range"><label>From date<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)}/></label><label>To date<input type="date" value={to} max={pakistanDay()} min={from} onChange={(event) => setTo(event.target.value)}/></label><button type="button" className="blue-button" onClick={() => void downloadWorkbook()} disabled={busy || !from || !to}>{busy ? "Preparing workbook…" : "Download Excel workbook"}</button></div>{error && <p className="form-message error-message" role="alert">{error}</p>}{message && <p className="form-message" role="status">{message}</p>}</section><div className="developer-export-grid">{[["Sales analysis", "Daily and monthly totals, refunds, payment-method split, and item quantities."], ["Order history", "Pickup number, order status, items, payment state, and refund details. Email addresses are excluded."], ["Wallet ledger", "Student ID, credit or debit, amount, time, method, and staff attribution."], ["Current menu", "Prices, availability, pickup type, item choices, and Item of the day schedule."]].map(([title, copy]) => <article className="owner-panel developer-export-card" key={title}><span aria-hidden="true">▤</span><div><h3>{title}</h3><p>{copy}</p></div></article>)}</div><p className="developer-export-note">Exports are limited to 31 days at a time. Store downloaded files securely: order and wallet records contain student IDs.</p></section>;
}

function HeroCarousel({ slides, index, onIndexChange, onPause, onResume }: { slides: HeroSlide[]; index: number; onIndexChange: (index: number) => void; onPause: () => void; onResume: () => void }) {
  const activeSlides = slides.filter((slide) => slide.active);
  if (!activeSlides.length) return null;
  const slideIndex = index % activeSlides.length;
  const slide = activeSlides[slideIndex];
  function moveBy(offset: number) { onIndexChange((slideIndex + offset + activeSlides.length) % activeSlides.length); }
  return <section className="promo-hero" aria-label="CedarBite featured menu" onFocusCapture={onPause} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onResume(); }}>
    <div className="hero-slide" key={slide.id}>
      <img className="hero-banner-image" src={slide.image_data} alt="CedarBite canteen banner" />
    </div>
    {activeSlides.length > 1 && <div className="hero-carousel-controls"><button type="button" className="hero-carousel-arrow" aria-label="Previous banner" onClick={() => moveBy(-1)}><span aria-hidden="true">‹</span></button><div className="hero-carousel-dots" aria-label="Choose banner slide">{activeSlides.map((item, dotIndex) => <button type="button" key={item.id} aria-label={`Show banner ${dotIndex + 1}`} aria-current={dotIndex === slideIndex ? "true" : undefined} onClick={() => onIndexChange(dotIndex)}/>)}</div><button type="button" className="hero-carousel-arrow" aria-label="Next banner" onClick={() => moveBy(1)}><span aria-hidden="true">›</span></button></div>}
  </section>;
}

function HeroSlidesEditor({ slides, message, pending, onSave }: { slides: HeroSlide[]; message: string; pending: boolean; onSave: (slides: HeroSlide[]) => Promise<void> }) {
  const [draft, setDraft] = useState(slides.map((slide) => ({ ...slide, active: true })));
  const [imageBusyId, setImageBusyId] = useState("");
  const [imageError, setImageError] = useState("");
  useEffect(() => setDraft(slides.map((slide) => ({ ...slide, active: true }))), [slides]);
  function updateImage(id: string, image_data: string) { setDraft((current) => current.map((slide) => slide.id === id ? { ...slide, image_data, active: true } : slide)); }
  return <section className="owner-content hero-slides-editor"><div className="panel-heading"><div><span className="section-kicker">STUDENT DASHBOARD</span><h2>Homepage banner</h2><p>Add or replace the images shown at the top of the student menu.</p></div></div><p className="hero-image-size-guidance">Recommended image size: 1600 × 600 px (landscape).</p>
    <div className="hero-editor-list">{draft.map((slide, index) => <article className="hero-editor-card" key={slide.id}><div className="hero-editor-card-top"><b>Banner image {index + 1}</b>{draft.length > 1 && <button type="button" className="hero-remove-image" aria-label={`Remove banner image ${index + 1}`} onClick={() => setDraft((current) => current.filter((item) => item.id !== slide.id))}>Remove</button>}</div>
      <div className="hero-editor-image-row"><img src={slide.image_data} alt={`Banner preview ${index + 1}`}/><label className="hero-image-select">{slide.image_data ? "Replace image" : "Add image"}<input type="file" accept="image/*" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; setImageError(""); if (!file) return; setImageBusyId(slide.id); void resizeHeroImage(file).then((image_data) => updateImage(slide.id, image_data)).catch((error) => setImageError(error instanceof Error ? error.message : "This image could not be prepared.")).finally(() => { setImageBusyId(""); input.value = ""; }); }}/></label>{imageBusyId === slide.id && <span role="status">Preparing image…</span>}</div>
    </article>)}</div>
    {draft.length < 5 && <button type="button" className="hero-add-slide" onClick={() => setDraft((current) => [...current, { ...defaultHeroSlides[0], id: crypto.randomUUID(), active: true }])}>＋ Add image</button>}
    {(imageError || message) && <p className={`form-message ${imageError ? "error-message" : ""}`} role="status">{imageError || message}</p>}
    <div className="hero-editor-save"><button type="button" className="blue-button" disabled={pending || Boolean(imageBusyId) || !draft.length} onClick={() => void onSave(draft.map((slide) => ({ ...slide, active: true })))}>{pending ? "Saving…" : "Save banner"}</button></div>
  </section>;
}

function PickupLookup({ queue, pendingIds, onConfirm }: { queue: Order[]; pendingIds: string[]; onConfirm: (order: Order) => void }) {
  const [value, setValue] = useState("");
  const [searched, setSearched] = useState("");
  const match = searched ? queue.find((order) => order.pickup_code.toUpperCase() === searched) : undefined;
  return <section className="pickup-lookup"><div><span className="section-kicker">COLLECTION CHECK</span><h3>Enter pickup ID</h3><p>Find the matching order before handing it over.</p></div><form onSubmit={(event) => { event.preventDefault(); setSearched(value.trim().toUpperCase()); }}><label htmlFor="pickup-id">Pickup ID</label><div><input id="pickup-id" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Enter the number shown to the student" required/><button className="blue-button" type="submit">Find order</button></div></form>{searched && (match ? <div className="pickup-match" role="status"><b>Order {match.pickup_code} · {human(match.status)}</b><span>{orderCustomerLabel(match)}</span><span>{match.items.map((item) => `${item.quantity} × ${item.name}`).join(" · ")}</span>{match.status === "READY" ? <button className="blue-button" disabled={pendingIds.includes(String(match.id))} onClick={() => onConfirm(match)}>{pendingIds.includes(String(match.id)) ? "Confirming…" : "Confirm pickup"}</button> : <small>Pickup can be confirmed after the order is marked ready.</small>}</div> : <p className="pickup-not-found" role="status">No active order matches pickup ID {searched}. Refresh the queue and check the number.</p>)}</section>;
}

function StationDirectory({ onNavigate, onBack, darkMode, onToggleTheme }: { onNavigate: (page: Page) => void; onBack: () => void; darkMode: boolean; onToggleTheme: () => void }) {
  const stations: { title: string; path: Page; description: string; icon: string }[] = [
    { title: "Counter", path: "counter", description: "Place in-person orders for students and send them into the shared queue.", icon: "01" },
    { title: "Cash desk", path: "cashdesk", description: "Record wallet cash top-ups and cash received for pay-at-pickup orders.", icon: "02" },
    { title: "Order manager", path: "order-manager", description: "Accept orders, manage preparation progress, menu availability, and order history.", icon: "03" },
    { title: "Kitchen monitor", path: "kitchen", description: "Show only orders that the order manager has marked as preparing.", icon: "04" },
  ];
  return <main className="stations-page"><div className="station-directory-top"><button className="back-to-store" onClick={onBack}>← Student menu</button><ThemeSwitch darkMode={darkMode} onToggle={onToggleTheme} className="station-directory-theme"/></div><span className="section-kicker">CEDARBITE STAFF</span><h1>Choose your station.</h1><p>Each station has its own sign-in and only the tools needed for that role.</p><div className="station-cards">{stations.map((station) => <button className="station-card" key={station.path} onClick={() => onNavigate(station.path)}><span>{station.icon}</span><h2>{station.title}</h2><p>{station.description}</p><b>Open station <i>↗</i></b></button>)}</div></main>;
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
  return <details className="staff-password-panel"><summary>Change password</summary><form className="owner-form" onSubmit={(event) => void submit(event)}><label>New password<input name="new_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="Enter new password"/></label><label>Confirm new password<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="Confirm new password"/></label>{message && <p className="form-message" role="status">{message}</p>}<button className="blue-button" disabled={saving}>{saving ? "Saving…" : "Save new password"}</button></form></details>;
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
  return <form className="owner-form" onSubmit={(event) => void submit(event)}><label>Staff station<select name="station" required defaultValue="order_taker"><option value="order_taker">Counter</option><option value="cashier">Cash desk</option><option value="kitchen">Kitchen monitor</option></select></label><label>New password<input name="new_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="Enter new password"/></label><label>Confirm new password<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="Confirm new password"/></label>{message && <p className="form-message" role="status">{message}</p>}<button className="blue-button" disabled={saving}>{saving ? "Resetting…" : "Reset station password"}</button></form>;
}

function StationSwitchPrompt({ activeStation, activeUser, targetStation, onSignOut, onReturn }: { activeStation: string | null; activeUser: User | null; targetStation: string; onSignOut: () => void; onReturn: () => void }) {
  const activeName = stationName(activeStation, activeUser);
  return <div className="station-switch-scrim"><section className="station-switch-dialog" role="dialog" aria-modal="true" aria-labelledby="station-switch-title"><div className="station-switch-icon" aria-hidden="true">↔</div><span className="section-kicker">ACCOUNT ALREADY SIGNED IN</span><h2 id="station-switch-title">Sign out before switching?</h2><p>This browser is signed in to <b>{activeName}</b>. Sign out before entering credentials for <b>{stationName(targetStation)}</b> to avoid a session conflict.</p><button className="blue-button" onClick={onSignOut}>Sign out and continue</button><button className="station-switch-return" onClick={onReturn}>Return to {activeName}</button></section></div>;
}

function CounterStation({ user, categories, items, pending, darkMode, onToggleTheme, onSignIn, onSignOut, onReturnToActive, onChangePassword, onLookupStudent, onSaveStudentName, onCreate }: { user: User | null; categories: Category[]; items: Item[]; pending: boolean; darkMode: boolean; onToggleTheme: () => void; onSignIn: (username: string, password: string) => Promise<void>; onSignOut: () => void; onReturnToActive: () => void; onChangePassword: (password: string) => Promise<void>; onLookupStudent: (student_id: string) => Promise<StudentLookup>; onSaveStudentName: (student_id: string, full_name: string) => Promise<StudentLookup>; onCreate: (customer: { customer_type: "STUDENT" | "NON_STUDENT"; student_id: string | null; customer_name: string | null }, lines: { item_id: number; option_id?: string; quantity: number; addon_selected: boolean }[]) => Promise<Order> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [addonSelections, setAddonSelections] = useState<Record<string, boolean>>({});
  const [optionPromptItem, setOptionPromptItem] = useState<Item | null>(null);
  const [optionDraftQuantities, setOptionDraftQuantities] = useState<Record<string, number>>({});
  const [optionDraftAddons, setOptionDraftAddons] = useState<Record<string, boolean>>({});
  const [counterCategoryId, setCounterCategoryId] = useState<number | "all">("all");
  const [customerType, setCustomerType] = useState<"STUDENT" | "NON_STUDENT">("STUDENT");
  const [counterStudentId, setCounterStudentId] = useState("");
  const [counterStudent, setCounterStudent] = useState<StudentLookup | null>(null);
  const [manualStudentName, setManualStudentName] = useState("");
  const [counterStudentLookupBusy, setCounterStudentLookupBusy] = useState(false);
  const [counterStudentSaveBusy, setCounterStudentSaveBusy] = useState(false);
  const [counterStudentLookupError, setCounterStudentLookupError] = useState("");
  const counterStudentLookupVersion = useRef(0);
  const [pickupId, setPickupId] = useState("");
  const [success, setSuccess] = useState("");
  const [receiptRequest, setReceiptRequest] = useState<{ order: Order; key: string } | null>(null);
  const placeOrderButtonRef = useRef<HTMLButtonElement | null>(null);
  const [showJumpToOrder, setShowJumpToOrder] = useState(false);
  useAutoPrintReceipt(receiptRequest);
  const stationUser = user?.role === "DEMO_CANTEEN" && storageGet("session", CANTEEN_ROLE_KEY) === "order_taker";
  const activeStation = storageGet("session", CANTEEN_ROLE_KEY);
  const stationConflict = Boolean((activeStation && activeStation !== "order_taker") || (user && (user.role !== "DEMO_CANTEEN" || activeStation !== "order_taker")));
  async function lookupCounterStudent(studentId: string) {
    const version = ++counterStudentLookupVersion.current;
    setCounterStudent(null);
    setCounterStudentLookupError("");
    setCounterStudentLookupBusy(true);
    try {
      const student = await onLookupStudent(studentId);
      if (version === counterStudentLookupVersion.current) setCounterStudent(student);
    } catch (reason) {
      if (version === counterStudentLookupVersion.current) setCounterStudentLookupError(reason instanceof Error ? reason.message : "Student profile could not be checked.");
    } finally {
      if (version === counterStudentLookupVersion.current) setCounterStudentLookupBusy(false);
    }
  }
  async function saveCounterStudentName() {
    const name = manualStudentName.trim().replace(/\s+/g, " ");
    if (!counterStudent || counterStudent.student_id !== counterStudentId || !name) {
      setCounterStudentLookupError("Enter the student’s name before saving.");
      return;
    }
    setCounterStudentSaveBusy(true);
    setCounterStudentLookupError("");
    try {
      const saved = await onSaveStudentName(counterStudentId, name);
      setCounterStudent(saved);
      setManualStudentName("");
    } catch (reason) {
      setCounterStudentLookupError(reason instanceof Error ? reason.message : "The student name could not be saved.");
    } finally {
      setCounterStudentSaveBusy(false);
    }
  }
  const visibleCategories = categories.map((category) => ({ ...category, items: category.items.filter((item) => item.available && (item.quick_allowed || item.scheduled_allowed)) })).filter((category) => category.items.length > 0);
  const listedCategories = visibleCategories;
  const lineKey = (itemId: number, optionId?: string) => `${itemId}::${optionId ?? ""}`;
  const optionSummary = (item: Item) => (item.options ?? []).filter((option) => option.available && (quantities[lineKey(item.id, option.id)] ?? 0) > 0).map((option) => `${option.name} × ${quantities[lineKey(item.id, option.id)]}`).join(" · ");
  function openOptionPrompt(item: Item) {
    setOptionDraftQuantities(Object.fromEntries((item.options ?? []).map((option) => [lineKey(item.id, option.id), option.available ? quantities[lineKey(item.id, option.id)] ?? 0 : 0])));
    setOptionDraftAddons(Object.fromEntries((item.options ?? []).map((option) => [lineKey(item.id, option.id), option.available && Boolean(addonSelections[lineKey(item.id, option.id)])])));
    setOptionPromptItem(item);
  }
  function saveOptionPrompt() {
    if (!optionPromptItem) return;
    setQuantities((current) => { const next = { ...current }; for (const option of optionPromptItem.options ?? []) next[lineKey(optionPromptItem.id, option.id)] = option.available ? optionDraftQuantities[lineKey(optionPromptItem.id, option.id)] ?? 0 : 0; return next; });
    setAddonSelections((current) => { const next = { ...current }; for (const option of optionPromptItem.options ?? []) next[lineKey(optionPromptItem.id, option.id)] = option.available && Boolean(optionDraftAddons[lineKey(optionPromptItem.id, option.id)]); return next; });
    setOptionPromptItem(null);
  }
  const selectedCount = Object.values(quantities).reduce((sum, count) => sum + count, 0);
  useEffect(() => {
    const button = placeOrderButtonRef.current;
    if (!stationUser || selectedCount === 0 || !button || success) {
      setShowJumpToOrder(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setShowJumpToOrder(!entry.isIntersecting), {
      threshold: 0.15,
      rootMargin: "0px 0px -24px 0px",
    });
    observer.observe(button);
    return () => observer.disconnect();
  }, [selectedCount, stationUser, success]);
  const jumpToPlaceOrder = () => placeOrderButtonRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  const orderTotal = items.reduce((sum, item) => {
    const options = item.options ?? [];
    if (options.length) return sum + options.filter((option) => option.available).reduce((itemSum, option) => { const key = lineKey(item.id, option.id); return itemSum + (item.price_paisa + (addonSelections[key] && item.addon_name ? item.addon_price_paisa ?? 0 : 0)) * (quantities[key] ?? 0); }, 0);
    const key = lineKey(item.id);
    return sum + (item.price_paisa + (addonSelections[key] && item.addon_name ? item.addon_price_paisa ?? 0 : 0)) * (quantities[key] ?? 0);
  }, 0);
  const orderLines = items.flatMap((item) => {
    const availableOptions = item.options?.filter((option) => option.available) ?? [];
    const choices = item.options?.length ? availableOptions.map((option) => ({ option_id: option.id, key: lineKey(item.id, option.id) })) : [{ option_id: undefined, key: lineKey(item.id) }];
    return choices.flatMap((choice) => (quantities[choice.key] ?? 0) > 0 ? [{ item_id: item.id, ...(choice.option_id ? { option_id: choice.option_id } : {}), quantity: quantities[choice.key], addon_selected: Boolean(addonSelections[choice.key] && item.addon_name) }] : []);
  });
  const quantityControl = (item: Item, optionId?: string) => {
    const key = lineKey(item.id, optionId);
    const quantity = quantities[key] ?? 0;
    const choiceName = optionId ? item.options?.find((option) => option.id === optionId)?.name : item.name;
    return <div className="counter-quantity-control"><button type="button" disabled={quantity <= 0} onClick={() => setQuantities((current) => ({ ...current, [key]: Math.max(0, (current[key] ?? 0) - 1) }))} aria-label={`Remove one ${choiceName}`}>−</button><input type="number" min="0" max="20" value={quantity} onChange={(event) => setQuantities((current) => ({ ...current, [key]: Math.min(20, Math.max(0, Number(event.target.value))) }))} aria-label={`Quantity for ${choiceName}`}/><button type="button" disabled={quantity >= 20} onClick={() => setQuantities((current) => ({ ...current, [key]: Math.min(20, (current[key] ?? 0) + 1) }))} aria-label={`Add one ${choiceName}`}>+</button></div>;
  };
  const optionDraftControl = (item: Item, option: MenuOption) => {
    const key = lineKey(item.id, option.id);
    const quantity = optionDraftQuantities[key] ?? 0;
    return <div className="counter-quantity-control"><button type="button" disabled={quantity <= 0} onClick={() => setOptionDraftQuantities((current) => ({ ...current, [key]: Math.max(0, (current[key] ?? 0) - 1) }))} aria-label={`Remove one ${option.name}`}>−</button><input type="number" min="0" max="20" value={quantity} onChange={(event) => setOptionDraftQuantities((current) => ({ ...current, [key]: Math.min(20, Math.max(0, Number(event.target.value))) }))} aria-label={`Quantity for ${option.name}`}/><button type="button" disabled={quantity >= 20} onClick={() => setOptionDraftQuantities((current) => ({ ...current, [key]: Math.min(20, (current[key] ?? 0) + 1) }))} aria-label={`Add one ${option.name}`}>+</button></div>;
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSuccess("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const studentId = counterStudentId;
    const nonStudentName = String(form.get("non_student_name") ?? "").trim();
    if (customerType === "STUDENT" && !/^\d{7}$/.test(studentId)) { setError("Enter the student’s 7-digit Cedar ID."); return; }
    if (customerType === "STUDENT" && counterStudent?.student_id !== studentId) { setError("Enter a valid student ID and wait for the lookup to finish."); return; }
    const studentName = counterStudent?.full_name?.trim() || manualStudentName.trim();
    if (customerType === "STUDENT" && (!studentName || studentName.length > 100)) { setError("Check the student ID and enter the student’s name as shown on their Cedar ID."); return; }
    if (customerType === "NON_STUDENT" && (!nonStudentName || nonStudentName.length > 100)) { setError("Enter the teacher or guest name (up to 100 characters)."); return; }
    if (!orderLines.length) { setError("Add at least one menu item."); return; }
    const customer = { customer_type: customerType, student_id: customerType === "STUDENT" ? studentId : null, customer_name: customerType === "STUDENT" ? studentName : nonStudentName };
    try { const order = await onCreate(customer, orderLines); setPickupId(order.pickup_code); setSuccess("In-person order sent to the canteen queue."); setReceiptRequest({ order, key: createUuid() }); setQuantities({}); setAddonSelections({}); formElement.reset(); setCustomerType("STUDENT"); setCounterStudentId(""); setCounterStudent(null); setManualStudentName(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The order could not be placed."); }
  }
  return <><main className="stations-page station-workspace"><div className="station-topline"><a href="/stations">← All staff stations</a><div className="station-top-actions">{stationUser && <ChangePasswordForm station="order_taker" onChange={onChangePassword}/>}{stationUser && <button onClick={onSignOut}>Sign out</button>}<ThemeSwitch darkMode={darkMode} onToggle={onToggleTheme} className="station-theme-toggle"/></div></div><span className="section-kicker">COUNTER · IN-PERSON ORDERS</span><h1>Counter station</h1>{stationConflict ? <StationSwitchPrompt activeStation={activeStation} activeUser={user} targetStation="order_taker" onSignOut={onSignOut} onReturn={onReturnToActive}/> : !stationUser ? <form className="owner-lock station-login" onSubmit={(event) => { event.preventDefault(); setError(""); void onSignIn(username, password).catch((reason) => setError(reason instanceof Error ? reason.message : "Sign-in failed.")); }}><h2>Staff sign-in</h2><label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} required placeholder="Enter username" autoComplete="username"/></label><label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} required type="password" placeholder="Enter password" autoComplete="current-password"/></label>{error && <p className="form-message error-message">{error}</p>}<button className="blue-button">Open counter</button><p className="password-help">Forgot your password? Ask the order manager to reset the counter password.</p></form> : <><form className="counter-order-form" onSubmit={(event) => void submit(event)}><label>Order placed for<select name="customer_type" value={customerType} onChange={(event) => { setCustomerType(event.target.value as "STUDENT" | "NON_STUDENT"); setCounterStudentId(""); setCounterStudent(null); setManualStudentName(""); setCounterStudentLookupError(""); }}><option value="STUDENT">Student</option><option value="NON_STUDENT">Teacher / Guest</option></select></label>{customerType === "STUDENT" ? <><label>Student ID<input name="student_id" required inputMode="numeric" pattern="[0-9]{7}" minLength={7} maxLength={7} placeholder="Enter student ID" value={counterStudentId} onChange={(event) => { const id = event.target.value.replace(/\D/g, "").slice(0, 7); counterStudentLookupVersion.current += 1; setCounterStudentId(id); setCounterStudent(null); setManualStudentName(""); setCounterStudentLookupBusy(false); setCounterStudentLookupError(""); if (id.length === 7) void lookupCounterStudent(id); }}/></label>{counterStudentLookupBusy && <p className="form-message" role="status">Checking the Cedar student account…</p>}{counterStudent && counterStudent.student_id === counterStudentId && counterStudent.full_name && <div className="counter-student-found" role="status"><span>Student found</span><b>{counterStudent.full_name}</b><small>Student ID {counterStudent.student_id}{counterStudent.source === "counter" && <> · Saved for future counter orders</>}</small></div>}{counterStudent && counterStudent.student_id === counterStudentId && !counterStudent.full_name && <div className="counter-student-missing"><p className="form-message error-message" role="status"><b>ID not found</b></p><label>Student name<input name="student_name" required maxLength={100} autoComplete="name" placeholder="Enter name as shown on Cedar ID" value={manualStudentName} onChange={(event) => setManualStudentName(event.target.value)}/></label><button type="button" className="blue-button" disabled={!manualStudentName.trim() || counterStudentSaveBusy} onClick={() => void saveCounterStudentName()}>{counterStudentSaveBusy ? "Saving…" : "Save student name"}</button></div>}{counterStudentLookupError && <p className="form-message error-message" role="alert">{counterStudentLookupError}</p>}</> : <label>Teacher or guest name<input name="non_student_name" required maxLength={100} autoComplete="name" placeholder="Enter their name"/></label>}<p className="counter-pickup-note">One menu for every item. Counter orders are placed for immediate collection; no pickup slot is needed.</p><div className="counter-items-heading"><div><h2>Choose items</h2><p>{customerType === "NON_STUDENT" ? "Select the items for this teacher or guest." : "Select items for this student."}</p></div><span>{selectedCount} selected</span></div><div className="menu-layout counter-menu-layout"><nav className="category-sidebar counter-category-sidebar" aria-label="Counter menu categories"><div className="counter-category-heading"><b>Browse categories</b><span>{visibleCategories.length}</span></div><button type="button" className={counterCategoryId === "all" ? "active" : ""} aria-pressed={counterCategoryId === "all"} onClick={() => { setCounterCategoryId("all"); document.querySelector(".counter-menu-category")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>All items</button>{visibleCategories.map((category) => <button type="button" key={category.id} className={counterCategoryId === category.id ? "active" : ""} aria-pressed={counterCategoryId === category.id} onClick={() => { setCounterCategoryId(category.id); document.getElementById("counter-menu-category-" + category.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{category.name}</button>)}</nav><div className="menu-results counter-menu-results"><div className="counter-category-list">{listedCategories.map((category) => <section className="counter-menu-category" id={"counter-menu-category-" + category.id} key={category.id}><h3>{category.name}</h3><div className="counter-item-list">{category.items.map((item) => <article className={`counter-item-card ${(item.options?.length ? item.options.some((option) => (quantities[lineKey(item.id, option.id)] ?? 0) > 0) : (quantities[lineKey(item.id)] ?? 0) > 0) ? "is-selected" : ""}`} key={item.id}><div className="counter-item-picture"><MenuItemVisual item={item} className="counter-item-visual"/><span className="counter-item-mode">{item.category_id === -1 ? "ITEM OF THE DAY" : "IN-PERSON PICKUP"}</span></div><div className="counter-item-card-info"><div><b>{item.name}</b><strong>{item.price_display}</strong></div><small>{item.description || (item.prep_minutes ? `Ready in about ${item.prep_minutes} minutes` : "Cedar canteen menu item")}</small>{item.options?.length ? <div className="counter-choice-launch"><button type="button" className="counter-choice-open" disabled={!item.options.some((option) => option.available)} onClick={() => openOptionPrompt(item)}>{optionSummary(item) ? "Edit choices" : "Choose options"}<span aria-hidden="true">⌄</span></button>{optionSummary(item) && <small className="counter-choice-summary">{optionSummary(item)}</small>}</div> : <>{item.addon_name && <label className="counter-addon-option"><input type="checkbox" checked={addonSelections[lineKey(item.id)] ?? false} onChange={(event) => setAddonSelections((current) => ({ ...current, [lineKey(item.id)]: event.target.checked }))}/> Add {item.addon_name} · +{money(item.addon_price_paisa ?? 0)}</label>}{quantityControl(item)}</>}</div></article>)}</div></section>)}</div></div></div><div className="counter-total"><span>Order total</span><strong>{money(orderTotal)}</strong></div>{error && <p className="form-message error-message" role="alert">{error}</p>}{success && <div className="counter-order-success" role="status"><b>{success}</b><span>Pickup number: <strong>{pickupId}</strong></span><small>Payment due in cash at pickup.</small></div>}<button ref={placeOrderButtonRef} className="blue-button" disabled={pending}>{pending ? "Sending order…" : "Place in-person order"}</button></form>{showJumpToOrder && <button type="button" className="counter-jump-to-order" onClick={jumpToPlaceOrder} aria-label="Go to place order"><span aria-hidden="true">↓</span><span>Place order</span></button>}</>}</main>{optionPromptItem && <div className="addon-prompt-scrim counter-choice-scrim" onClick={() => setOptionPromptItem(null)}><section className="addon-prompt option-prompt counter-choice-prompt" role="dialog" aria-modal="true" aria-labelledby="counter-choice-title" onClick={(event) => event.stopPropagation()}><span className="section-kicker">COUNTER ORDER</span><h2 id="counter-choice-title">Choose {optionPromptItem.name}</h2><p>Set a quantity for each choice. You can add more than one type of drink.</p><div className="counter-choice-modal-list">{(optionPromptItem.options ?? []).map((option) => <article className={`counter-choice-modal-row ${option.available ? "" : "is-unavailable"}`} key={option.id}><div className="counter-choice-modal-heading"><b>{option.name}</b><span>{option.available ? optionPromptItem.price_display : "Out of stock"}</span></div>{option.available ? <>{optionPromptItem.addon_name && <label className="counter-addon-option"><input type="checkbox" checked={optionDraftAddons[lineKey(optionPromptItem.id, option.id)] ?? false} onChange={(event) => setOptionDraftAddons((current) => ({ ...current, [lineKey(optionPromptItem.id, option.id)]: event.target.checked }))}/> Add {optionPromptItem.addon_name} · +{money(optionPromptItem.addon_price_paisa ?? 0)}</label>}{optionDraftControl(optionPromptItem, option)}</> : <small>This drink is currently unavailable.</small>}</article>)}</div><div className="addon-prompt-actions"><button type="button" onClick={() => setOptionPromptItem(null)}>Cancel</button><button type="button" className="blue-button" onClick={saveOptionPrompt}>Save drink choices</button></div></section></div>}{receiptRequest && <ReceiptPrintView order={receiptRequest.order}/>}</>;
}

function KitchenStation({ user, queue, pendingIds, darkMode, onToggleTheme, onSignIn, onSignOut, onReturnToActive, onChangePassword }: { user: User | null; queue: Order[]; pendingIds: string[]; darkMode: boolean; onToggleTheme: () => void; onSignIn: (username: string, password: string) => Promise<void>; onSignOut: () => void; onReturnToActive: () => void; onChangePassword: (password: string) => Promise<void> }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  const stationUser = user?.role === "DEMO_CANTEEN" && storageGet("session", CANTEEN_ROLE_KEY) === "kitchen";
  const activeStation = storageGet("session", CANTEEN_ROLE_KEY);
  const stationConflict = Boolean((activeStation && activeStation !== "kitchen") || (user && (user.role !== "DEMO_CANTEEN" || activeStation !== "kitchen")));
  return <main className="kitchen-screen"><header><div><a className="kitchen-back-link" href="/stations">← All staff stations</a><span className="section-kicker">CEDARBITE · KITCHEN</span><h1>Preparing now</h1><p>Only orders in the Preparing stage appear here.</p></div><div className="station-top-actions">{stationUser && <ChangePasswordForm station="kitchen" onChange={onChangePassword}/>}{stationUser && <button onClick={onSignOut}>Sign out</button>}<ThemeSwitch darkMode={darkMode} onToggle={onToggleTheme} className="station-theme-toggle"/></div></header>{stationConflict ? <StationSwitchPrompt activeStation={activeStation} activeUser={user} targetStation="kitchen" onSignOut={onSignOut} onReturn={onReturnToActive}/> : !stationUser ? <form className="owner-lock station-login" onSubmit={(event) => { event.preventDefault(); setError(""); void onSignIn(username, password).catch((reason) => setError(reason instanceof Error ? reason.message : "Sign-in failed.")); }}><h2>Kitchen monitor sign-in</h2><label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} required placeholder="Enter username" autoComplete="username"/></label><label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} required type="password" placeholder="Enter password" autoComplete="current-password"/></label>{error && <p className="form-message error-message">{error}</p>}<button className="blue-button">Open kitchen monitor</button><p className="password-help">Forgot your password? Ask the order manager to reset the kitchen password.</p></form> : <>{queue.length ? <div className="kitchen-ticket-grid">{queue.filter((order) => order.status === "PREPARING").map((order) => <article className="kitchen-ticket" key={order.id}><span>PREPARING</span><h2>{order.pickup_code}</h2><small>{order.mode === "SCHEDULED" && order.pickup_window ? new Date(order.pickup_window.start_at).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" }) : "Quick pickup"}</small><ul>{order.items.map((item, index) => <li key={`${item.name}-${index}`}><b>{item.quantity}×</b> {item.name}</li>)}</ul>{pendingIds.includes(String(order.id)) && <small>Updating…</small>}</article>)}</div> : <div className="kitchen-empty">No orders are being prepared right now.</div>}</>}</main>;
}

function AvailabilitySwitch({ item, disabled, onToggle }: { item: Item; disabled: boolean; onToggle: (item: Item) => void }) { return <button type="button" className={`availability-switch ${item.available ? "is-on" : "is-off"}`} disabled={disabled} onClick={() => onToggle(item)} aria-pressed={item.available} aria-label={`${disabled ? "Saving availability for" : item.available ? "Mark unavailable" : "Mark available"}: ${item.name}`} title={disabled ? "Saving availability…" : item.available ? "Click to mark unavailable" : "Click to mark available"}><span aria-hidden="true">{disabled ? "…" : item.available ? "✓" : "×"}</span><small>{disabled ? "Saving…" : item.available ? "Available · click to pause" : "Unavailable · click to enable"}</small></button>; }
function CategorySortControls({ category, categories, disabled, onMove }: { category: Category; categories: Category[]; disabled: boolean; onMove: (sourceId: number, targetId: number) => void }) {
  const index = categories.findIndex((entry) => entry.id === category.id);
  return <div className="menu-sort-arrows category-sort-arrows" aria-label={`Reorder ${category.name} category`}><button type="button" disabled={disabled || index <= 0} onClick={() => onMove(category.id, categories[index - 1].id)} aria-label={`Move ${category.name} category up`} title="Move category up">↑</button><button type="button" disabled={disabled || index < 0 || index >= categories.length - 1} onClick={() => onMove(category.id, categories[index + 1]?.id)} aria-label={`Move ${category.name} category down`} title="Move category down">↓</button></div>;
}
function MenuSortHandle({ item, items, disabled, onMove }: { item: Item; items: Item[]; disabled: boolean; onMove: (sourceId: number, targetId: number) => void }) {
  const index = items.findIndex((entry) => entry.id === item.id);
  function finishPointerSort(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-menu-item-id]");
    const targetId = Number(target?.dataset.menuItemId);
    if (targetId && targetId !== item.id) onMove(item.id, targetId);
  }
  return <div className="menu-sort-controls" aria-label={`Reorder ${item.name}`}>
    <button type="button" className="menu-drag-handle" disabled={disabled} aria-label={`Drag ${item.name} to reorder`} title="Drag to reorder" onPointerDown={(event) => { if (disabled || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return; event.preventDefault(); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The arrow controls remain available if pointer capture is unsupported. */ } }} onPointerUp={finishPointerSort} onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>⠿</button>
    <span className="menu-sort-arrows"><button type="button" disabled={disabled || index <= 0} onClick={() => onMove(item.id, items[index - 1].id)} aria-label={`Move ${item.name} up`} title="Move up">↑</button><button type="button" disabled={disabled || index < 0 || index >= items.length - 1} onClick={() => onMove(item.id, items[index + 1]?.id)} aria-label={`Move ${item.name} down`} title="Move down">↓</button></span>
  </div>;
}
function QueueItem({ order, onAdvance, onDelete, pending = false }: { order: Order; onAdvance: (order: Order) => void; onDelete?: (order: Order) => void; pending?: boolean }) {
  const next: Record<string, string> = { SUBMITTED: "Accept order", ACCEPTED: "Mark order ready", PREPARING: "Mark order ready", READY: "Mark collected" };
  return <article className="queue-item"><div className="queue-number" aria-label={`Pickup number ${order.pickup_code}`}>{order.pickup_code}<small>Pickup number</small></div><div className="queue-details"><div><b>{human(order.status)}</b><small>{order.mode === "QUICK" ? "Quick pickup" : order.pickup_window ? `Pickup ${new Date(order.pickup_window.start_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Scheduled"} · {order.waiting_minutes ?? 0} min</small><small className="queue-student-id">{orderCustomerLabel(order)}</small></div><p>{order.items.map((line, index) => <span key={`${line.name}-${index}`}>{line.quantity} × {line.name}</span>)}</p></div><div className="queue-amount">{order.total_display}</div><div className="queue-actions">{next[order.status] && <button type="button" className="blue-button queue-action" disabled={pending} onClick={() => onAdvance(order)}>{pending ? "Saving…" : `${next[order.status]} →`}</button>}{onDelete && order.status === "SUBMITTED" && <button type="button" className="queue-delete-button" disabled={pending} onClick={() => onDelete(order)} aria-label={`Delete new order ${order.pickup_code}`} title="Delete accidental order"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2m2 0-.7 10H6.7L6 6m2.5 2.5v5m3-5v5"/></svg></button>}</div></article>;
}
