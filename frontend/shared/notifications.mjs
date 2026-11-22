// SERVER ONLY. Order email and web-push delivery. Never import this from frontend/src.
import * as webPush from "web-push";

function database() {
  const url = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "")
    .trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key) throw new Error("Notification database configuration is missing.");
  return { url, key };
}

async function db(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = database();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch { result = { message: text }; }
  if (!response.ok) throw new Error(`Notification database request failed (${response.status}).`);
  return result;
}

const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const orderUrl = () => `${String(process.env.PUBLIC_SITE_URL || "https://cedarbite.me").replace(/\/+$/, "")}/my-orders`;

function emailContent(order) {
  const lines = (Array.isArray(order.items) ? order.items : []).map((item) => `<tr><td style="padding:9px 0;border-bottom:1px solid #e6eaf0">${safe(item.quantity)} × ${safe(item.name)}</td><td style="padding:9px 0;border-bottom:1px solid #e6eaf0;text-align:right">${item.unit_price_paisa == null ? "" : `Rs ${Math.round(item.unit_price_paisa * item.quantity / 100).toLocaleString("en-PK")}`}</td></tr>`).join("");
  const subject = `Your CedarBite order is ready · ${order.pickup_code}`;
  const intro = "Your scheduled order is ready for collection. Your receipt is below.";
  const paymentSummary = `${order.payment_method ?? "cash"} · ${order.payment_status ?? "unpaid"}`;
  const placedAt = order.created_at ? new Date(order.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" }) : "—";
  const text = [
    `Hello${order.customer_email ? "" : ""},`, intro, `Pickup number: ${order.pickup_code}`,
    ...(order.items ?? []).map((item) => `${item.quantity} × ${item.name}`),
    ...(Number(order.deal_discount_paisa) > 0 ? [`Deal savings: Rs ${Math.round(order.deal_discount_paisa / 100).toLocaleString("en-PK")}`] : []),
    `Total: ${order.total_display ?? "—"}`, `Payment: ${paymentSummary}`, `Placed: ${placedAt}`, `View order status: ${orderUrl()}`,
  ].join("\n");
  const savings = Number(order.deal_discount_paisa) > 0 ? `<tr><td style="padding:9px 0;color:#16734c">Deal savings</td><td style="padding:9px 0;text-align:right;color:#16734c">−Rs ${Math.round(order.deal_discount_paisa / 100).toLocaleString("en-PK")}</td></tr>` : "";
  const html = `<div style="margin:0;padding:28px 12px;background:#f4f7fb;font-family:Arial,sans-serif;color:#102b4c"><div style="max-width:560px;margin:auto;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px"><div style="font-size:23px;font-weight:800">Cedar<span style="color:#d9a900">Bite</span></div><p style="color:#53677f;line-height:1.6">${intro}</p><div style="margin:20px 0;padding:18px;border-radius:12px;background:#102b4c;color:white;text-align:center"><div style="font-size:10px;letter-spacing:2px;color:#ffe08a">PICKUP NUMBER</div><div style="margin-top:6px;font-size:30px;font-weight:800;letter-spacing:3px">${safe(order.pickup_code)}</div></div><table style="width:100%;border-collapse:collapse">${lines}${savings}</table><p style="font-weight:800">Total: ${safe(order.total_display ?? "—")}</p><p style="color:#53677f;font-size:12px;line-height:1.6">Payment: ${safe(paymentSummary)}<br/>Placed: ${safe(placedAt)}</p><p style="margin-top:22px"><a href="${safe(orderUrl())}" style="display:inline-block;padding:12px 16px;border-radius:8px;background:#ffc928;color:#102b4c;text-decoration:none;font-weight:700">View My Orders</a></p><p style="margin:20px 0 0;color:#65758a;font-size:12px;line-height:1.6">Show your pickup number to the canteen staff when collecting your order.</p></div></div>`;
  return { subject, text, html };
}

async function sendEmail(to, content, idempotencyKey) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.CEDARBITE_FROM_EMAIL || "").trim();
  if (!apiKey || !from) throw new Error("Email delivery is not configured (RESEND_API_KEY and CEDARBITE_FROM_EMAIL are required).");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from, to: [to], subject: content.subject, html: content.html, text: content.text }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(`Email provider rejected the message (${response.status}): ${String(detail?.message ?? "delivery error").slice(0, 180)}`);
  }
}

async function enqueue(order, kind) {
  const id = globalThis.crypto.randomUUID();
  await db("notification_deliveries?on_conflict=order_id%2Ckind", {
    method: "POST",
    body: { id, order_id: String(order.id), kind, status: "pending" },
    prefer: "resolution=ignore-duplicates,return=minimal",
  });
  const rows = await db(`notification_deliveries?select=id,status,claimed_at,attempts,last_error&order_id=eq.${encodeURIComponent(String(order.id))}&kind=eq.${encodeURIComponent(kind)}`);
  return rows?.[0] ?? null;
}

async function claim(delivery) {
  if (!delivery || delivery.status === "sent" || delivery.status === "skipped") return false;
  if (delivery.status === "pending" && delivery.last_error && Date.now() - Date.parse(delivery.claimed_at ?? "") < 5 * 60_000) return false;
  const now = new Date().toISOString();
  const id = encodeURIComponent(delivery.id);
  let rows = await db(`notification_deliveries?id=eq.${id}&status=eq.pending`, {
    method: "PATCH", body: { status: "processing", claimed_at: now }, prefer: "return=representation",
  });
  if (rows?.length) return true;
  const cutoff = encodeURIComponent(new Date(Date.now() - 5 * 60_000).toISOString());
  rows = await db(`notification_deliveries?id=eq.${id}&status=eq.processing&claimed_at=lt.${cutoff}`, {
    method: "PATCH", body: { claimed_at: now }, prefer: "return=representation",
  });
  return Boolean(rows?.length);
}

async function finish(delivery, status, fields = {}) {
  await db(`notification_deliveries?id=eq.${encodeURIComponent(delivery.id)}&status=eq.processing`, {
    method: "PATCH", body: { status, ...fields }, prefer: "return=minimal",
  });
}

export async function deliverOrderEmail(order, kind) {
  // Only scheduled orders receive one email, when the canteen marks them ready.
  if (order?.mode !== "SCHEDULED" || kind !== "ready_receipt" || order.status !== "READY") return false;
  if (!order?.customer_email || !/^\d{7}@cedar\.edu\.pk$/i.test(order.customer_email)) {
    console.info("CedarBite skipped order email because this order has no verified Cedar student email.");
    return false;
  }
  let delivery;
  let hasClaim = false;
  try {
    delivery = await enqueue(order, kind);
    hasClaim = await claim(delivery);
    if (!hasClaim) return delivery?.status === "sent";
    await sendEmail(order.customer_email, emailContent(order), `cedarbite-${kind}-${order.id}`);
    await finish(delivery, "sent", { sent_at: new Date().toISOString(), last_error: null, attempts: (delivery.attempts ?? 0) + 1 });
    return true;
  } catch (error) {
    if (hasClaim && delivery) {
      try { await finish(delivery, "pending", { last_error: String(error?.message ?? "Email delivery failed.").slice(0, 240), attempts: (delivery.attempts ?? 0) + 1 }); }
      catch { /* The scheduled retry can recover a stuck processing claim. */ }
    }
    console.error("CedarBite order email could not be sent.", { kind, order_id: order.id, error: String(error?.message ?? error) });
    return false;
  }
}

export async function sendReadyPush(order) {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!publicKey || !privateKey || !order?.customer_user_id) return 0;
  try {
    webPush.setVapidDetails(String(process.env.VAPID_SUBJECT || "mailto:notifications@cedarbite.me"), publicKey, privateKey);
    const subscriptions = await db(`push_subscriptions?select=endpoint,p256dh,auth_secret&user_id=eq.${encodeURIComponent(order.customer_user_id)}`);
    const payload = JSON.stringify({ title: "Your order is ready to collect!", body: `Show pickup number ${order.pickup_code} at the canteen counter.`, url: "/my-orders", tag: `cedarbite-ready-${order.id}` });
    let sent = 0;
    for (const subscription of subscriptions ?? []) {
      try {
        await webPush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth_secret } }, payload, { TTL: 60 * 60 });
        sent += 1;
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE" });
        } else console.error("CedarBite ready alert could not be delivered.", { order_id: order.id, status: error?.statusCode ?? "unknown" });
      }
    }
    return sent;
  } catch (error) {
    console.error("CedarBite push notification could not be sent.", { order_id: order.id, error: String(error?.message ?? error) });
    return 0;
  }
}

export async function registerPushSubscription(userId, subscription) {
  const endpoint = String(subscription?.endpoint ?? "");
  const p256dh = String(subscription?.keys?.p256dh ?? "");
  const auth = String(subscription?.keys?.auth ?? "");
  let host = "";
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { /* rejected below */ }
  const trustedPushHost = host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com"
    || host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com");
  if (!/^https:\/\//i.test(endpoint) || endpoint.length > 2048 || !trustedPushHost || !p256dh || !auth) throw new Error("The browser notification subscription is invalid.");
  await db("push_subscriptions?on_conflict=endpoint", {
    method: "POST",
    body: { endpoint, user_id: userId, p256dh, auth_secret: auth, updated_at: new Date().toISOString() },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

export async function removePushSubscription(userId, endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 2048) return;
  await db(`push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&endpoint=eq.${encodeURIComponent(endpoint)}`, { method: "DELETE" });
}

export function pushConfig() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  return { enabled: Boolean(publicKey && process.env.VAPID_PRIVATE_KEY), public_key: publicKey || null };
}

export async function processPendingEmailDeliveries(orderStore) {
  const staleCutoff = encodeURIComponent(new Date(Date.now() - 5 * 60_000).toISOString());
  await db(`notification_deliveries?status=eq.processing&claimed_at=lt.${staleCutoff}`, {
    method: "PATCH", body: { status: "pending", claimed_at: null }, prefer: "return=minimal",
  });
  const pending = await db(`notification_deliveries?select=id,order_id,kind,status,claimed_at,attempts,last_error&status=eq.pending&or=(claimed_at.is.null,claimed_at.lt.${staleCutoff})&order=created_at.asc&limit=100`);
  let attempted = 0;
  for (const delivery of pending ?? []) {
    const order = await orderStore.getOrder(delivery.order_id);
    if (!order) continue;
    if (delivery.kind !== "ready_receipt" || order.mode !== "SCHEDULED" || order.status !== "READY") {
      await db(`notification_deliveries?id=eq.${encodeURIComponent(delivery.id)}&status=eq.pending`, { method: "PATCH", body: { status: "skipped" }, prefer: "return=minimal" });
      continue;
    }
    attempted += 1;
    await deliverOrderEmail(order, delivery.kind);
  }
  return attempted;
}
