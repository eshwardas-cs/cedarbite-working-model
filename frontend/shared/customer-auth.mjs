// SERVER ONLY. Works out WHO is placing an online order, from their Supabase (Google) sign-in.
// The browser sends the signed-in person's access token; we ask Supabase who it belongs to and
// read their profile with the SECRET key. Nothing the browser says about the person is trusted.
// Never import this file from src/ (anything under src/ is shipped to every visitor's browser).

export class CustomerAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "CustomerAuthError";
    this.status = status;
  }
}

const SIGN_IN_AGAIN = "Your sign-in has expired. Sign in again with your Cedar Google account, then try again.";

function connection() {
  const url = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "")
    .trim()
    .replace(/\/rest\/v1\/?$/, "")
    .replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key) throw new CustomerAuthError("Online ordering is not connected yet. Add SUPABASE_SECRET_KEY in Netlify, then redeploy.", 503);
  return { url, key };
}

// Resolves a Cedar student ID against the server-owned profile table. This is
// used by staff screens only; never expose a general profile search endpoint.
export async function studentProfileFromId(studentId) {
  const id = String(studentId ?? "").trim();
  if (!/^\d{7}$/.test(id)) throw new CustomerAuthError("Enter a valid 7-digit Cedar student ID.", 400);
  const { url, key } = connection();
  const email = `${id}@cedar.edu.pk`;
  const response = await fetch(
    `${url}/rest/v1/profiles?select=email,full_name,role&email=eq.${encodeURIComponent(email)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!response.ok) {
    console.error("CedarBite student lookup failed", { status: response.status });
    throw new CustomerAuthError("The student profile could not be checked right now. Try again.", 502);
  }
  const [profile] = (await response.json().catch(() => [])) ?? [];
  if (!profile || profile.role !== "student" || String(profile.email).toLowerCase() !== email) {
    throw new CustomerAuthError("No Cedar student account was found for that ID.", 404);
  }
  const full_name = String(profile.full_name ?? "").trim();
  if (!full_name) throw new CustomerAuthError("This student’s Cedar profile does not have a name to verify.", 409);
  return { student_id: id, full_name };
}

export async function profileFromEmail(email) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@cedar\.edu\.pk$/.test(normalized)) return null;
  const { url, key } = connection();
  const response = await fetch(
    `${url}/rest/v1/profiles?select=email,full_name,role&email=eq.${encodeURIComponent(normalized)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!response.ok) throw new CustomerAuthError("The Cedar profile could not be checked right now. Try again.", 502);
  const [profile] = (await response.json().catch(() => [])) ?? [];
  if (!profile || String(profile.email).toLowerCase() !== normalized) return null;
  return { email: normalized, role: String(profile.role), full_name: String(profile.full_name ?? "").trim() || null };
}

// Returns { user_id, email, role, student_id } for a signed-in Cedar account, or throws CustomerAuthError.
export async function customerFromRequest(request) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new CustomerAuthError("Sign in with your Cedar Google account to continue.");
  const token = match[1];
  const { url, key } = connection();

  // 1. Supabase checks the token's signature and expiry and tells us whose it is.
  const userResponse = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (userResponse.status === 401 || userResponse.status === 403) throw new CustomerAuthError(SIGN_IN_AGAIN);
  if (!userResponse.ok) {
    console.error("CedarBite sign-in check failed", { status: userResponse.status });
    throw new CustomerAuthError("Your sign-in could not be checked right now. Please try again.", 502);
  }
  const authUser = await userResponse.json().catch(() => null);
  if (!authUser?.id) throw new CustomerAuthError(SIGN_IN_AGAIN);

  // 2. Their profile only exists if the Cedar-only rule let them in (see 0002_auth_cedar_only.sql).
  const profileResponse = await fetch(
    `${url}/rest/v1/profiles?select=email,full_name,role&id=eq.${encodeURIComponent(authUser.id)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!profileResponse.ok) {
    console.error("CedarBite profile lookup failed", { status: profileResponse.status });
    throw new CustomerAuthError("Your account could not be checked right now. Please try again.", 502);
  }
  const [profile] = (await profileResponse.json().catch(() => [])) ?? [];
  if (!profile?.email) throw new CustomerAuthError("This account is not allowed to use CedarBite ordering. Sign in with your Cedar Google account.", 403);

  const email = String(profile.email).toLowerCase();
  const studentNumber = /^(\d{7})@cedar\.edu\.pk$/.exec(email);
  return {
    user_id: authUser.id,
    email,
    role: String(profile.role),
    full_name: String(profile.full_name ?? "").trim() || null,
    student_id: profile.role === "student" && studentNumber ? studentNumber[1] : null,
  };
}
