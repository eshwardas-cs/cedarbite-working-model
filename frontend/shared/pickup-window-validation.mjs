const PICKUP_SLOT_MS = 10 * 60 * 1000;
const PAKISTAN_OFFSET_MS = 5 * 60 * 60 * 1000;
const PICKUP_SLOT_CAPACITY = 20;

export function listPickupWindows(orders = [], now = Date.now()) {
  const pakistanNow = new Date(now + PAKISTAN_OFFSET_MS);
  const minuteNow = pakistanNow.getUTCHours() * 60 + pakistanNow.getUTCMinutes();
  if (minuteNow < 7 * 60 + 50 || minuteNow >= 16 * 60) return [];

  const year = pakistanNow.getUTCFullYear();
  const month = pakistanNow.getUTCMonth();
  const day = pakistanNow.getUTCDate();
  const localMidnightUtc = Date.UTC(year, month, day) - PAKISTAN_OFFSET_MS;
  const earliestStart = Math.ceil((now + PICKUP_SLOT_MS) / PICKUP_SLOT_MS) * PICKUP_SLOT_MS;
  const counts = new Map();
  for (const order of orders) {
    if (order?.mode !== "SCHEDULED") continue;
    const start = Date.parse(order.pickup_window?.start_at);
    if (Number.isFinite(start)) counts.set(start, (counts.get(start) ?? 0) + 1);
  }

  const windows = [];
  for (let minute = 8 * 60; minute < 16 * 60; minute += 10) {
    const startMs = localMidnightUtc + minute * 60_000;
    if (startMs < earliestStart) continue;
    const remaining = Math.max(PICKUP_SLOT_CAPACITY - (counts.get(startMs) ?? 0), 0);
    if (!remaining) continue;
    const start = new Date(startMs);
    windows.push({ id: -startMs, start_at: start.toISOString(), end_at: new Date(startMs + PICKUP_SLOT_MS).toISOString(), remaining });
  }
  return windows;
}

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
