// Loads the menu from Supabase and reshapes it into the format the rest of the app already uses.
import { supabase, supabaseConfigured } from "./supabaseClient";

const IMAGE_BUCKET = "menu-images";

const money = (paisa: number) =>
  `Rs ${(paisa / 100).toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

type MenuItemRow = {
  id: number;
  category_id: number;
  name: string;
  description: string;
  price_paisa: number;
  addon_name: string | null;
  addon_price_paisa: number;
  is_available: boolean;
  quick_allowed: boolean;
  scheduled_allowed: boolean;
  prep_minutes: number | null;
  image_path: string | null;
};

export async function fetchMenuFromSupabase() {
  if (!supabaseConfigured) throw new Error("Supabase is not configured.");
  // One request: every category, with its items nested inside, in menu order.
  // The security rules already hide removed items (is_active = false).
  const { data, error } = await supabase
    .from("menu_categories")
    .select(
      "id, name, sort_order, menu_items(id, category_id, name, description, price_paisa, addon_name, addon_price_paisa, is_available, quick_allowed, scheduled_allowed, prep_minutes, image_path)",
    )
    .order("sort_order")
    .order("id")
    // Items in the order staff set (sort_order, added by 0003_menu_editing.sql); id breaks ties.
    .order("sort_order", { referencedTable: "menu_items" })
    .order("id", { referencedTable: "menu_items" });

  if (error) throw new Error(`Supabase menu error: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Supabase returned an empty menu.");

  return data.map((category) => ({
    id: category.id,
    name: category.name,
    items: (category.menu_items as MenuItemRow[]).map((item) => ({
      id: item.id,
      category_id: item.category_id,
      name: item.name,
      description: item.description,
      price_paisa: item.price_paisa,
      price_display: money(item.price_paisa),
      available: item.is_available,
      quick_allowed: item.quick_allowed,
      scheduled_allowed: item.scheduled_allowed,
      prep_minutes: item.prep_minutes,
      addon_name: item.addon_name,
      addon_price_paisa: item.addon_price_paisa,
      // The app shows whatever is in image_data as the photo, so we give it the photo's public link.
      image_data: item.image_path
        ? supabase.storage.from(IMAGE_BUCKET).getPublicUrl(item.image_path).data.publicUrl
        : null,
    })),
  }));
}
