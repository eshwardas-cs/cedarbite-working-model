// SERVER ONLY. Wallet reads and writes use Supabase tables and database RPCs.

export class WalletStoreError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "WalletStoreError";
    this.status = status;
  }
}

function connection() {
  const url = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key) throw new WalletStoreError("The wallet database is not connected. Add SUPABASE_SECRET_KEY and run the CedarBite database migration.", 503);
  return { url, key };
}

async function call(path, { method = "GET", body } = {}) {
  const { url, key } = connection();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    console.error("CedarBite wallet database request failed", { path: path.split("?")[0], status: response.status });
    throw new WalletStoreError("The wallet could not be updated right now. Please try again.", 502);
  }
  return data;
}

function requireOk(result) {
  if (!result?.ok) {
    const errors = {
      INVALID_TOPUP: ["Top-up details are invalid.", 400],
      INVALID_LEGACY_WALLET: ["The previous wallet record could not be imported.", 400],
      REFERENCE_REUSED: ["This transaction reference was already used for a different top-up.", 409],
      INSUFFICIENT_WALLET_BALANCE: ["The student wallet does not have enough balance.", 409],
      WALLET_STUDENT_ONLY: ["Wallet payment is available only for a verified student account.", 403],
    };
    const [message, status] = errors[result?.error] ?? ["The wallet could not complete that transaction.", 400];
    throw new WalletStoreError(message, status);
  }
  return result;
}

export async function readStudentWallet(studentId) {
  const id = String(studentId ?? "");
  if (!/^\d{7}$/.test(id)) throw new Error("A valid student ID is required.");
  const [accounts, entries] = await Promise.all([
    call(`wallet_accounts?select=balance_paisa&student_id=eq.${encodeURIComponent(id)}`),
    call(`wallet_entries?select=id,student_id,kind,amount_paisa,method,label,created_at&student_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=200`),
  ]);
  return { balance_paisa: Number(accounts?.[0]?.balance_paisa ?? 0), entries: Array.isArray(entries) ? entries : [] };
}

export async function listWalletEntries(limit = 200) {
  const entries = await call(`wallet_entries?select=id,student_id,kind,amount_paisa,method,label,recorded_by,order_id,created_at&order=created_at.desc&limit=${Math.max(1, Math.min(Number(limit) || 200, 500))}`);
  return Array.isArray(entries) ? entries : [];
}

export async function recordCashTopup({ studentId, amountPaisa, reference, label, actor }) {
  const result = await call("rpc/cedar_wallet_cash_topup", {
    method: "POST",
    body: { p_student_id: String(studentId), p_amount_paisa: amountPaisa, p_idempotency_key: reference, p_label: label, p_actor: actor },
  });
  return requireOk(result);
}

export async function importLegacyWallet({ studentId, balancePaisa, entries, complete = false }) {
  const result = await call("rpc/cedar_import_legacy_wallet", {
    method: "POST",
    body: { p_student_id: String(studentId), p_balance_paisa: balancePaisa, p_entries: entries, p_complete: complete },
  });
  return requireOk(result);
}

export async function refundWalletOrder(orderId, actor) {
  const result = await call("rpc/cedar_wallet_refund_order", {
    method: "POST",
    body: { p_order_id: String(orderId), p_actor: actor },
  });
  return result ?? null;
}
