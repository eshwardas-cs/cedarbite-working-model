// Sign-in with Google through Supabase, and reading the signed-in person's profile.
// The real "Cedar accounts only" protection lives in the database (0002_auth_cedar_only.sql).
// Nothing in this file is security: it only starts the sign-in and shows the result.
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

export type SupabaseAppUser = {
  source: "supabase";
  email: string;
  role: string; // student | teacher | staff | manager | owner (from the profiles table)
  full_name: string | null;
  email_verified: boolean;
  student_id: string | null;
  permissions: string[];
  csrf_token: string;
};

export async function signInWithGoogle(returnPath = "/") {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}${returnPath}`,
      // hd only tells Google which accounts to SHOW. It is not protection: the database rule is.
      queryParams: { hd: "cedar.edu.pk", prompt: "select_account" },
    },
  });
  if (error) throw new Error(error.message);
}

export async function signOutOfSupabase() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

// Builds the app's user from the person's row in the profiles table.
export async function userFromSession(session: Session | null): Promise<SupabaseAppUser | null> {
  if (!session) return null;
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("email, full_name, role")
    .eq("id", session.user.id)
    .single();
  if (error || !profile) {
    // Signed in but no profile means something is wrong; don't let them in half-way.
    await supabase.auth.signOut();
    return null;
  }
  const match = /^(\d{7})@cedar\.edu\.pk$/i.exec(profile.email);
  return {
    source: "supabase",
    email: profile.email,
    role: profile.role,
    full_name: profile.full_name,
    email_verified: true,
    student_id: match ? match[1] : null, // worked out from the email, never stored separately
    permissions: [],
    csrf_token: "",
  };
}

// If Supabase refused a sign-in, it sends the person back with an error in the address bar.
// This reads it, turns it into a friendly message, and tidies the address bar.
export function takeSignInErrorFromUrl(): string | null {
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const description = search.get("error_description") ?? hash.get("error_description");
  const code = search.get("error") ?? hash.get("error");
  if (!description && !code) return null;

  for (const key of ["error", "error_code", "error_description"]) search.delete(key);
  const cleanSearch = search.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ""}`);

  if (/database error saving new user/i.test(description ?? "")) {
    return "CedarBite is only for Cedar College accounts. Please sign in with your @cedar.edu.pk Google account.";
  }
  if (code === "access_denied") return "Sign-in was cancelled.";
  return `Sign-in failed: ${description ?? code}`;
}
