const PICKUP_SLOT_MS = 10 * 60 * 1000;
const PAKISTAN_OFFSET_MS = 5 * 60 * 60 * 1000;
const PICKUP_SLOT_CAPACITY = 20;
const OPEN_DAYS = new Set([1, 2, 3, 4]);
const PREVIEW_START_MINUTE = 7 * 60 + 50;
const OPENING_MINUTE = 8 * 60;
const CLOSING_MINUTE = 17 * 60;

function pakistanClock(now = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  const local = new Date(timestamp + PAKISTAN_OFFSET_MS);
  return {
    timestamp,
    day: local.getUTCDay(),
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    date: local.getUTCDate(),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

export function isCanteenOperatingDay(now = Date.now()) {
  return OPEN_DAYS.has(pakistanClock(now).day);
}

export function isCanteenOpenNow(now = Date.now()) {
  const clock = pakistanClock(now);
  return OPEN_DAYS.has(clock.day) && clock.minute >= OPENING_MINUTE && clock.minute < CLOSING_MINUTE;
}

export function isPickupSlotWindowOpen(now = Date.now()) {
  const clock = pakistanClock(now);
  return OPEN_DAYS.has(clock.day) && clock.minute >= PREVIEW_START_MINUTE && clock.minute < CLOSING_MINUTE;
}

export function listPickupWindows(orders = [], now = Date.now()) {
  const clock = pakistanClock(now);
  if (!isPickupSlotWindowOpen(now)) return [];

  const { timestamp, year, month, date: day } = clock;
  const localMidnightUtc = Date.UTC(year, month, day) - PAKISTAN_OFFSET_MS;
  const earliestStart = Math.ceil((timestamp + PICKUP_SLOT_MS) / PICKUP_SLOT_MS) * PICKUP_SLOT_MS;
  const counts = new Map();
  for (const order of orders) {
    if (order?.mode !== "SCHEDULED") continue;
    const start = Date.parse(order.pickup_window?.start_at);
    if (Number.isFinite(start)) counts.set(start, (counts.get(start) ?? 0) + 1);
  }

  const windows = [];
  for (let minute = OPENING_MINUTE; minute < CLOSING_MINUTE; minute += 10) {
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
  const { timestamp, year, month, date: day, minute: minuteNow } = pakistanClock(now);
  const pakistanStart = new Date(start + PAKISTAN_OFFSET_MS);
  const minuteStart = pakistanStart.getUTCHours() * 60 + pakistanStart.getUTCMinutes();
  const earliestStart = Math.ceil((timestamp + PICKUP_SLOT_MS) / PICKUP_SLOT_MS) * PICKUP_SLOT_MS;
  const pakistanEnd = new Date(end + PAKISTAN_OFFSET_MS);
  const minuteEnd = pakistanEnd.getUTCHours() * 60 + pakistanEnd.getUTCMinutes();
  return isPickupSlotWindowOpen(now) &&
    pakistanStart.getUTCFullYear() === year &&
    pakistanStart.getUTCMonth() === month &&
    pakistanStart.getUTCDate() === day &&
    start >= earliestStart && minuteStart >= OPENING_MINUTE && minuteStart < CLOSING_MINUTE &&
    minuteStart % 10 === 0 && minuteEnd <= CLOSING_MINUTE;
}
