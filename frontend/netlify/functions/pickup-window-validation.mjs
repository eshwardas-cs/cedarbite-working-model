const PICKUP_SLOT_MS = 10 * 60 * 1000;
const PAKISTAN_OFFSET_MS = 5 * 60 * 60 * 1000;

export function validScheduledPickupWindow(window, now = Date.now()) {
  if (!window || typeof window !== "object") return false;
  const start = Date.parse(window.start_at);
  const end = Date.parse(window.end_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== PICKUP_SLOT_MS) return false;
  const pakistanNow = new Date(now + PAKISTAN_OFFSET_MS);
  const pakistanStart = new Date(start + PAKISTAN_OFFSET_MS);
  const minuteNow = pakistanNow.getUTCHours() * 60 + pakistanNow.getUTCMinutes();
  const minuteStart = pakistanStart.getUTCHours() * 60 + pakistanStart.getUTCMinutes();
  const earliestStart = Math.ceil((now + PICKUP_SLOT_MS) / PICKUP_SLOT_MS) * PICKUP_SLOT_MS;
  const pakistanEnd = new Date(end + PAKISTAN_OFFSET_MS);
  const minuteEnd = pakistanEnd.getUTCHours() * 60 + pakistanEnd.getUTCMinutes();
  return minuteNow >= 7 * 60 + 50 && minuteNow < 16 * 60 &&
    pakistanStart.getUTCFullYear() === pakistanNow.getUTCFullYear() &&
    pakistanStart.getUTCMonth() === pakistanNow.getUTCMonth() &&
    pakistanStart.getUTCDate() === pakistanNow.getUTCDate() &&
    start >= earliestStart && minuteStart >= 8 * 60 && minuteStart < 16 * 60 &&
    minuteStart % 10 === 0 && minuteEnd <= 16 * 60;
}
