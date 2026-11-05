import assert from "node:assert/strict";
import test from "node:test";
import { validScheduledPickupWindow } from "./pickup-window-validation.mjs";

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
