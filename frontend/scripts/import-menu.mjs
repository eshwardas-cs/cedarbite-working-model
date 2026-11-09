// One-time import: copies the menu from src/catalog.json into Supabase.
//   - creates the categories and items
//   - turns each embedded photo back into a .jpg and uploads it to the menu-images folder
//
// Run from the frontend folder:
//   node scripts/import-menu.mjs            (dry run: checks everything, changes nothing)
//   node scripts/import-menu.mjs --go       (really imports)
//
// Needs: frontend/.env.local (URL) and ../supabase/.env.admin (secret key).
// Refuses to run if menu_items already has rows, so it can't create duplicates.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
const GO = process.argv.includes("--go");

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const url = readEnv(join(here, "../.env.local")).VITE_SUPABASE_URL;
const secret = readEnv(join(here, "../../supabase/.env.admin")).SUPABASE_SECRET_KEY;
if (!url) throw new Error("VITE_SUPABASE_URL is missing in frontend/.env.local");
if (!secret) throw new Error("SUPABASE_SECRET_KEY is empty in supabase/.env.admin");
if (!secret.startsWith("sb_secret_") && !secret.startsWith("eyJ")) {
  throw new Error("That doesn't look like a secret key (should start with sb_secret_). Check you didn't paste the publishable key.");
}

const supabase = createClient(url, secret, { auth: { persistSession: false } });
const BUCKET = "menu-images";

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

const { categories } = JSON.parse(readFileSync(join(here, "../src/catalog.json"), "utf8"));
const itemCount = categories.reduce((n, c) => n + c.items.length, 0);
console.log(`Menu file: ${categories.length} categories, ${itemCount} items.`);

// Safety: never double-import.
const { count, error: countErr } = await supabase.from("menu_items").select("*", { count: "exact", head: true });
if (countErr) throw new Error(`Could not reach menu_items: ${countErr.message}`);
if (count > 0) {
  console.log(`menu_items already has ${count} rows. Stopping so nothing is duplicated.`);
  process.exit(1);
}
console.log("Connected with the secret key; menu_items is empty.");

if (!GO) {
  console.log("Dry run finished. Nothing was changed. Run again with --go to import.");
  process.exit(0);
}

// 1. Categories (upsert by name, so re-running is harmless)
const { data: savedCats, error: catErr } = await supabase
  .from("menu_categories")
  .upsert(categories.map((c, i) => ({ name: c.name, sort_order: i + 1 })), { onConflict: "name" })
  .select("id, name");
if (catErr) throw new Error(`Categories failed: ${catErr.message}`);
const catIdByName = Object.fromEntries(savedCats.map((c) => [c.name, c.id]));
console.log(`✓ ${savedCats.length} categories saved`);

// 2. Photos + items
const rows = [];
let uploaded = 0;
for (const cat of categories) {
  for (const item of cat.items) {
    let image_path = null;
    if (item.image_data) {
      const [header, b64] = item.image_data.split(",", 2);
      const contentType = header.match(/^data:(.*?);base64$/)?.[1] ?? "image/jpeg";
      const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
      image_path = `items/${slug(item.name)}.${ext}`;
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(image_path, Buffer.from(b64, "base64"), { contentType, upsert: true });
      if (error) throw new Error(`Photo upload failed for "${item.name}": ${error.message}`);
      uploaded++;
    }
    rows.push({
      category_id: catIdByName[cat.name],
      name: item.name,
      description: item.description ?? "",
      price_paisa: item.price_paisa,
      addon_name: item.addon_name ?? null,
      addon_price_paisa: item.addon_price_paisa ?? 0,
      is_available: item.available ?? true,
      is_active: true,
      quick_allowed: item.quick_allowed ?? false,
      scheduled_allowed: item.scheduled_allowed ?? true,
      prep_minutes: item.prep_minutes ?? null,
      image_path,
    });
  }
}
console.log(`✓ ${uploaded} photos uploaded`);

const { error: itemErr, count: inserted } = await supabase.from("menu_items").insert(rows, { count: "exact" });
if (itemErr) throw new Error(`Items failed: ${itemErr.message}`);
console.log(`✓ ${inserted} items saved`);
console.log("Import complete.");
