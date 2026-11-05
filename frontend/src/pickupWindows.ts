export type PickupWindow = {
  id: number;
  start_at: string;
  end_at: string;
  remaining: number;
};

const PAKISTAN_OFFSET_MS = 5 * 60 * 60 * 1000;
const SLOT_MS = 10 * 60 * 1000;
const MINIMUM_LEAD_MS = 10 * 60 * 1000;
const OPENING_MINUTE = 8 * 60;
const PREVIEW_MINUTE = OPENING_MINUTE - 10;
const CLOSING_MINUTE = 16 * 60;

function pakistanClock(now: Date) {
  const shifted = new Date(now.getTime() + PAKISTAN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function isPakistanDate(value: Date, year: number, month: number, day: number) {
  const local = pakistanClock(value);
  return local.year === year && local.month === month && local.day === day;
}

/** Build today's 10-minute schedule using Pakistan local time, independent of device timezone. */
export function samplePickupWindows(now: Date = new Date()): PickupWindow[] {
  const { year, month, day } = pakistanClock(now);
  const localMidnightUtc = Date.UTC(year, month, day) - PAKISTAN_OFFSET_MS;
  const windows: PickupWindow[] = [];

  for (let minute = OPENING_MINUTE; minute < CLOSING_MINUTE; minute += 10) {
    const start = new Date(localMidnightUtc + minute * 60_000);
    const end = new Date(start.getTime() + SLOT_MS);
    windows.push({
      id: -start.getTime(),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      remaining: 8,
    });
  }

  return windows;
}

/** Keep the next six valid slots, starting only once the 7:50 AM preview opens. */
export function availablePickupWindows(windows: PickupWindow[], now: Date = new Date()): PickupWindow[] {
  const localNow = pakistanClock(now);
  if (localNow.minute < PREVIEW_MINUTE || localNow.minute >= CLOSING_MINUTE) return [];

  const earliestStart = Math.ceil((now.getTime() + MINIMUM_LEAD_MS) / SLOT_MS) * SLOT_MS;
  return windows
    .filter((window) => {
      const start = new Date(window.start_at);
      const end = new Date(window.end_at);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return false;
      const startMinute = pakistanClock(start).minute;
      return window.remaining > 0 &&
        isPakistanDate(start, localNow.year, localNow.month, localNow.day) &&
        start.getTime() >= earliestStart &&
        startMinute >= OPENING_MINUTE && startMinute < CLOSING_MINUTE &&
        startMinute % 10 === 0 && end.getTime() - start.getTime() === SLOT_MS &&
        pakistanClock(end).minute <= CLOSING_MINUTE;
    })
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))
    .slice(0, 6);
}

export function formatPickupTime(value: string) {
  return new Date(value).toLocaleTimeString("en-PK", {
    timeZone: "Asia/Karachi",
    hour: "numeric",
    minute: "2-digit",
  });
}
