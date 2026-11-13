import assert from "node:assert/strict";
import test from "node:test";
import { listPickupWindows, validScheduledPickupWindow } from "../shared/pickup-window-validation.mjs";

const window = (start, end) => ({ start_at: start, end_at: end });

test("accepts a 10-minute Pakistan-time slot with at least ten minutes lead", () => {
  assert.equal(validScheduledPickupWindow(window("2026-11-05T03:00:00Z", "2026-11-05T03:10:00Z"), Date.parse("2026-11-05T02:50:00Z")), true);
});

test("rejects slots before preview time, too soon, and outside operating hours", () => {
  assert.equal(validScheduledPickupWindow(window("2026-11-05T03:00:00Z", "2026-11-05T03:10:00Z"), Date.parse("2026-11-05T02:49:00Z")), false);
  assert.equal(validScheduledPickupWindow(window("2026-11-05T03:00:00Z", "2026-11-05T03:10:00Z"), Date.parse("2026-11-05T02:50:30Z")), false);
  assert.equal(validScheduledPickupWindow(window("2026-11-05T11:00:00Z", "2026-11-05T11:10:00Z"), Date.parse("2026-11-05T10:50:00Z")), false);
});

test("rejects non-ten-minute, misaligned, and cross-day windows", () => {
  const now = Date.parse("2026-11-05T02:50:00Z");
  assert.equal(validScheduledPickupWindow(window("2026-11-05T03:00:00Z", "2026-11-05T04:00:00Z"), now), false);
  assert.equal(validScheduledPickupWindow(window("2026-11-05T03:05:00Z", "2026-11-05T03:15:00Z"), now), false);
  assert.equal(validScheduledPickupWindow(window("2026-11-06T03:00:00Z", "2026-11-06T03:10:00Z"), now), false);
});

test("lists the next 10-minute windows and removes full slots", () => {
  const now = Date.parse("2026-11-05T02:51:00Z");
  const fullSlotOrders = Array.from({ length: 20 }, (_, index) => ({
    id: `order-${index}`,
    mode: "SCHEDULED",
    pickup_window: window("2026-11-05T03:10:00Z", "2026-11-05T03:20:00Z"),
  }));
  const slots = listPickupWindows(fullSlotOrders, now);
  assert.equal(slots[0].start_at, "2026-11-05T03:20:00.000Z");
  assert.equal(slots.length, 46);
  assert.ok(slots.every((slot) => Date.parse(slot.end_at) - Date.parse(slot.start_at) === 10 * 60 * 1000));
});

test("provides no windows before preview time or after closing", () => {
  assert.deepEqual(listPickupWindows([], Date.parse("2026-11-05T02:49:00Z")), []);
  assert.deepEqual(listPickupWindows([], Date.parse("2026-11-05T14:23:00Z")), []);
});
