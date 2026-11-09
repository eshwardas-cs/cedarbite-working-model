// The one place CedarBite connects to Supabase.
// Any other file that needs data (menu, users, orders) imports `supabase` from here.
import { createClient } from "@supabase/supabase-js";

// Set in frontend/.env.local for local development, and in Netlify's environment variables for the live site.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Safety switch: when these are not set, Supabase is switched off and the app keeps its old
// menu and sign-in behaviour instead of crashing. Adding both values switches Supabase on.
export const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);
if (!supabaseConfigured) {
  console.info("Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY); using the previous menu and sign-in.");
}

export const supabase = createClient(
  supabaseUrl || "https://supabase-not-configured.invalid",
  supabaseKey || "not-configured",
  { auth: { persistSession: supabaseConfigured, autoRefreshToken: supabaseConfigured, detectSessionInUrl: supabaseConfigured } },
);
