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

async function studentProfileRow(id) {
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
  if (!profile || profile.role !== "student" || String(profile.email).toLowerCase() !== email) return null;
  return profile;
}

async function counterStudentNameRow(id) {
  const { url, key } = connection();
  const response = await fetch(
    `${url}/rest/v1/counter_student_names?select=student_id,full_name,recorded_by&student_id=eq.${encodeURIComponent(id)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!response.ok) {
    console.error("CedarBite counter name lookup failed", { status: response.status });
    throw new CustomerAuthError("The saved student name could not be checked right now. Try again.", 502);
  }
  const [record] = (await response.json().catch(() => [])) ?? [];
  return record ?? null;
}

// Resolves an ID against the authenticated Cedar profile first. The counter may
// fall back to a staff-entered name for in-person orders; cash desk lookups do not.
export async function studentProfileFromId(studentId, { allowCounterName = false, allowMissingName = false } = {}) {
  const id = String(studentId ?? "").trim();
  if (!/^\d{7}$/.test(id)) throw new CustomerAuthError("Enter a valid 7-digit Cedar student ID.", 400);
  const profile = await studentProfileRow(id);
  const profileName = String(profile?.full_name ?? "").trim();
  if (profileName) return { student_id: id, full_name: profileName, source: "profile", profile_exists: true };
  if (allowCounterName) {
    const savedName = await counterStudentNameRow(id);
    if (savedName?.full_name) return { student_id: id, full_name: String(savedName.full_name).trim(), source: "counter", profile_exists: Boolean(profile) };
  }
  if (allowMissingName) return { student_id: id, full_name: null, source: "missing", profile_exists: Boolean(profile) };
  if (profile) throw new CustomerAuthError("This student’s Cedar profile does not have a name to verify.", 409);
  throw new CustomerAuthError("No Cedar student account was found for that ID.", 404);
}

export async function saveCounterStudentName(studentId, fullName, recordedBy) {
  const id = String(studentId ?? "").trim();
  const name = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (!/^\d{7}$/.test(id) || !name || name.length > 100) {
    throw new CustomerAuthError("Enter a valid student ID and name (up to 100 characters).", 400);
  }
  // An authenticated Supabase profile is authoritative; never replace it with a
  // name typed at the counter, even if that profile was created moments ago.
  const profile = await studentProfileRow(id);
  const profileName = String(profile?.full_name ?? "").trim();
  if (profileName) return { student_id: id, full_name: profileName, source: "profile", profile_exists: true };

  const { url, key } = connection();
  const response = await fetch(`${url}/rest/v1/counter_student_names?on_conflict=student_id`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({
      student_id: id,
      full_name: name,
      recorded_by: String(recordedBy ?? "counter").trim().slice(0, 80),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    console.error("CedarBite could not save a counter-entered student name", { status: response.status });
    throw new CustomerAuthError("The student name could not be saved. The order was not placed; try again.", 502);
  }
  const [record] = (await response.json().catch(() => [])) ?? [];
  if (!record?.full_name) throw new CustomerAuthError("The student name could not be confirmed after saving. The order was not placed; try again.", 502);
  return { student_id: id, full_name: String(record.full_name).trim(), source: "counter", profile_exists: Boolean(profile) };
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
