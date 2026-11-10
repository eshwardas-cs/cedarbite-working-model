// SERVER ONLY. The Netlify function uses this to read and change the menu in Supabase.
// It uses the Supabase SECRET key (Netlify environment variable SUPABASE_SECRET_KEY),
// so it must never be imported by browser code (anything under src/).
//
// The station-password check happens in shared-data.mjs BEFORE any change here is made.
import { randomUUID } from "node:crypto";

const BUCKET = "menu-images";
// Each item's selectable options (e.g. drink flavours), see supabase/migrations/0006_menu_options.sql.
const OPTION_SELECT = "menu_item_options(id,name,is_available,sort_order)";
const ITEM_COLUMNS = "id,category_id,name,description,price_paisa,addon_name,addon_price_paisa,is_available,quick_allowed,scheduled_allowed,prep_minutes,image_path,sort_order";

export class MenuStoreError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "MenuStoreError";
    this.status = status;
  }
}

function connection() {
  const url = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "")
    .trim()
    .replace(/\/rest\/v1\/?$/, "")
    .replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url || !key) throw new MenuStoreError("The menu database is not connected yet. Add SUPABASE_SECRET_KEY in Netlify, then redeploy.", 503);
  return { url, key };
}

async function call(path, { method = "GET", body, prefer, raw, contentType = "application/json" } = {}) {
  const { url, key } = connection();
  const response = await fetch(`${url}${path}`, {
    method,
    // Same two headers the official Supabase library sends (and that worked for the photo import).
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": contentType, ...(prefer ? { Prefer: prefer } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) {
    const message = String(data?.message ?? "");
    if (message.startsWith("MENU_STALE")) throw new MenuStoreError("The menu was changed on another screen. Refresh the menu and try again.", 409);
    if (message.startsWith("MENU_INVALID")) throw new MenuStoreError(message.replace(/^MENU_INVALID:\s*/, ""), 400);
    if (data?.code === "23505") throw new MenuStoreError("A category with that name already exists.", 409);
    console.error("CedarBite menu database request failed", { path: path.split("?")[0], status: response.status, data });
    throw new MenuStoreError("The menu database could not save that change. Refresh and try again.", 502);
  }
  return data;
}

const rest = (path, options) => call(`/rest/v1/${path}`, options);

const money = (paisa) =>
  `Rs ${(paisa / 100).toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export function publicImageUrl(imagePath) {
  return imagePath ? `${connection().url}/storage/v1/object/public/${BUCKET}/${imagePath}` : null;
}

// Same shape the website already uses (see src/menuApi.ts), so screens need no changes.
function toItem(row) {
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    price_paisa: row.price_paisa,
    price_display: money(row.price_paisa),
    available: row.is_available,
    quick_allowed: row.quick_allowed,
    scheduled_allowed: row.scheduled_allowed,
    prep_minutes: row.prep_minutes,
    addon_name: row.addon_name,
    addon_price_paisa: row.addon_price_paisa,
    image_data: publicImageUrl(row.image_path),
    options: toOptions(row.menu_item_options),
  };
}

function toOptions(rows) {
  return (Array.isArray(rows) ? [...rows] : [])
    .sort((a, b) => a.sort_order - b.sort_order || String(a.id).localeCompare(String(b.id)))
    .map((option) => ({ id: option.id, name: option.name, available: option.is_available }));
}

/**
 * Checks the options sent by the staff screen (same rules as Eshwar's design):
 * at most 25, each with a 1-80 character name, names unique for the item, available on/off.
 */
function cleanOptions(options) {
  if (!Array.isArray(options) || options.length > 25) throw new MenuStoreError("An item can have at most 25 choices.", 400);
  const names = new Set();
  return options.map((option) => {
    const name = typeof option?.name === "string" ? option.name.trim() : "";
    if (!name || name.length > 80) throw new MenuStoreError("Each choice needs a name of 1 to 80 characters.", 400);
    if (names.has(name.toLowerCase())) throw new MenuStoreError("Choice names must be unique for this item.", 400);
    names.add(name.toLowerCase());
    if (option.available != null && typeof option.available !== "boolean") throw new MenuStoreError("Choice availability must be on or off.", 400);
    if (option.id != null && (typeof option.id !== "string" || option.id.length > 36)) throw new MenuStoreError("A choice reference is invalid. Refresh and try again.", 400);
    return { id: option.id ?? null, name, available: option.available ?? true };
  });
}

/** Makes the item's options exactly this list, in this order (keeps the IDs of options that already exist). */
async function replaceOptions(itemId, options) {
  const existing = new Set((await rest(`menu_item_options?select=id&menu_item_id=eq.${itemId}`) ?? []).map((row) => row.id));
  const rows = options.map((option, index) => ({
    id: option.id && existing.has(option.id) ? option.id : randomUUID().replaceAll("-", ""),
    menu_item_id: itemId,
    name: option.name,
    is_available: option.available,
    sort_order: index,
  }));
  if (rows.length) await rest("menu_item_options?on_conflict=id", { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
  const keep = rows.map((row) => row.id);
  await rest(`menu_item_options?menu_item_id=eq.${itemId}${keep.length ? `&id=not.in.(${keep.join(",")})` : ""}`, { method: "DELETE", prefer: "return=minimal" });
}

/** The live menu: categories in staff order, each with its active items in staff order. */
export async function readCatalog() {
  const rows = await rest(
    `menu_categories?select=id,name,sort_order,menu_items(${ITEM_COLUMNS},${OPTION_SELECT})` +
      "&menu_items.is_active=eq.true&order=sort_order.asc,id.asc&menu_items.order=sort_order.asc,id.asc",
  );
  return {
    categories: (rows ?? []).map((category) => ({
      id: category.id,
      name: category.name,
      items: (category.menu_items ?? []).map(toItem),
    })),
  };
}

const allItems = (catalog) => catalog.categories.flatMap((category) => category.items);
const nextItemPosition = async (categoryId) => {
  const rows = await rest(`menu_items?select=sort_order&category_id=eq.${categoryId}&order=sort_order.desc&limit=1`);
  return (rows?.[0]?.sort_order ?? 0) + 1;
};

async function uploadJpeg(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const imagePath = `items/${randomUUID()}.jpg`;
  await call(`/storage/v1/object/${BUCKET}/${imagePath}`, {
    method: "POST",
    raw: Buffer.from(base64, "base64"),
    contentType: "image/jpeg",
  });
  return imagePath;
}

async function updateActiveItem(itemId, changes) {
  const rows = await rest(`menu_items?id=eq.${itemId}&is_active=eq.true&select=${ITEM_COLUMNS},${OPTION_SELECT}`, { method: "PATCH", body: changes, prefer: "return=representation" });
  if (!rows?.length) throw new MenuStoreError("This item is no longer on the menu. Refresh the menu and try again.", 409);
  return rows[0];
}

export async function setAvailability(itemId, available) {
  return toItem(await updateActiveItem(itemId, { is_available: available }));
}

export async function setPrice(itemId, pricePaisa) {
  return toItem(await updateActiveItem(itemId, { price_paisa: pricePaisa }));
}

export async function removeItem(itemId) {
  // Hidden, not deleted: past orders still point at it.
  await updateActiveItem(itemId, { is_active: false });
}

export async function addItem(item) {
  const options = item.options == null ? [] : cleanOptions(item.options);
  const catalog = await readCatalog();
  if (!catalog.categories.some((category) => category.id === item.category_id)) throw new MenuStoreError("That category is no longer on the menu. Refresh and choose a current category.", 409);
  if (allItems(catalog).length >= 200) throw new MenuStoreError("The menu has reached its 200-item limit.", 409);
  const imagePath = item.image_data ? await uploadJpeg(item.image_data) : null;
  const addonName = item.addon_name?.trim() || null;
  const rows = await rest("menu_items", {
    method: "POST",
    prefer: "return=representation",
    body: {
      category_id: item.category_id,
      name: item.name.trim(),
      description: item.description.trim(),
      price_paisa: item.price_paisa,
      addon_name: addonName,
      addon_price_paisa: addonName ? item.addon_price_paisa ?? 0 : 0,
      quick_allowed: item.quick_allowed,
      scheduled_allowed: item.scheduled_allowed,
      prep_minutes: item.prep_minutes ?? null,
      image_path: imagePath,
      sort_order: await nextItemPosition(item.category_id),
    },
  });
  if (!options.length) return toItem(rows[0]);
  await replaceOptions(rows[0].id, options);
  const [saved] = await rest(`menu_items?select=${ITEM_COLUMNS},${OPTION_SELECT}&id=eq.${rows[0].id}`) ?? [];
  return toItem(saved ?? rows[0]);
}

/**
 * image_data from the edit form is one of:
 *   null            -> photo removed
 *   the current URL -> photo unchanged
 *   data:image/jpeg -> new photo uploaded
 */
export async function updateItem(item) {
  // Options are only changed when the screen sends them (older screens don't, and then they stay as they are).
  const options = item.options === undefined ? undefined : cleanOptions(item.options ?? []);
  const [current] = await rest(`menu_items?select=${ITEM_COLUMNS}&id=eq.${item.id}&is_active=eq.true`) ?? [];
  if (!current) throw new MenuStoreError("This item is no longer on the menu. Refresh the menu and try again.", 409);
  const catalog = await readCatalog();
  if (!catalog.categories.some((category) => category.id === item.category_id)) throw new MenuStoreError("That category is no longer on the menu. Refresh and choose a current category.", 409);

  let imagePath = current.image_path;
  if (item.image_data == null) imagePath = null;
  else if (item.image_data.startsWith("data:image/jpeg;base64,")) imagePath = await uploadJpeg(item.image_data);
  else if (item.image_data !== publicImageUrl(current.image_path)) throw new MenuStoreError("The photo could not be read. Choose the photo again.", 400);

  const addonName = item.addon_name?.trim() || null;
  const changes = {
    category_id: item.category_id,
    name: item.name.trim(),
    description: item.description.trim(),
    price_paisa: item.price_paisa,
    addon_name: addonName,
    addon_price_paisa: addonName ? item.addon_price_paisa ?? 0 : 0,
    quick_allowed: item.quick_allowed,
    scheduled_allowed: item.scheduled_allowed,
    prep_minutes: item.prep_minutes ?? null,
    image_path: imagePath,
  };
  if (current.category_id !== item.category_id) changes.sort_order = await nextItemPosition(item.category_id);
  if (options !== undefined) await replaceOptions(item.id, options);
  return toItem(await updateActiveItem(item.id, changes));
}

export async function addCategory(name) {
  const rows = await rest("menu_categories?select=sort_order&order=sort_order.desc&limit=1");
  await rest("menu_categories", { method: "POST", body: { name: name.trim(), sort_order: (rows?.[0]?.sort_order ?? 0) + 1 } });
}

export async function removeCategory(categoryId, targetCategoryId) {
  await rest("rpc/staff_remove_category", { method: "POST", body: { p_category_id: categoryId, p_target_category_id: targetCategoryId ?? null } });
}

/** categories = [{ id, items: [{ id }, ...] }, ...] in the new order. */
export async function reorderMenu(categories) {
  await rest("rpc/staff_reorder_menu", {
    method: "POST",
    body: { p_categories: categories.map((category) => ({ id: category.id, item_ids: category.items.map((item) => item.id) })) },
  });
}
