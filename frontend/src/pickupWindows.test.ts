import { describe, expect, it } from "vitest";
import { availablePickupWindows, samplePickupWindows } from "./pickupWindows";

const pk = (time: string) => new Date(time);

describe("scheduled pickup slots (Pakistan time)", () => {
  it("waits until 7:50 AM, then offers 8:00–8:10 AM", () => {
    expect(availablePickupWindows(samplePickupWindows(pk("2026-11-05T02:49:00Z")), pk("2026-11-05T02:49:00Z"))).toHaveLength(0);
    const now = pk("2026-11-05T02:50:00Z");
    const slots = availablePickupWindows(samplePickupWindows(now), now);
    expect(slots[0]).toMatchObject({ start_at: "2026-11-05T03:00:00.000Z", end_at: "2026-11-05T03:10:00.000Z" });
  });

  it("rounds the ten-minute lead forward and returns only the next six", () => {
    const now = pk("2026-11-05T02:51:00Z");
    const slots = availablePickupWindows(samplePickupWindows(now), now);
    expect(slots).toHaveLength(6);
    expect(slots[0].start_at).toBe("2026-11-05T03:10:00.000Z");
    for (let i = 0; i < slots.length; i += 1) {
      expect(Date.parse(slots[i].end_at) - Date.parse(slots[i].start_at)).toBe(10 * 60 * 1000);
      if (i > 0) expect(Date.parse(slots[i].start_at) - Date.parse(slots[i - 1].start_at)).toBe(10 * 60 * 1000);
    }
  });

  it("hides full, passed, malformed, and non-ten-minute windows", () => {
    const now = pk("2026-11-05T03:00:00Z");
    const valid = samplePickupWindows(now)[0];
    const slots = availablePickupWindows([
      { ...valid, remaining: 0 },
      { ...valid, id: 99, start_at: "2026-11-05T02:50:00Z", end_at: "2026-11-05T03:00:00Z" },
      { ...valid, id: 100, end_at: "2026-11-05T04:00:00Z" },
      { ...valid, id: 101, start_at: "not-a-date" },
      ...samplePickupWindows(now),
    ], now);
    expect(slots.every((slot) => slot.remaining > 0)).toBe(true);
    expect(slots.every((slot) => Date.parse(slot.end_at) - Date.parse(slot.start_at) === 10 * 60 * 1000)).toBe(true);
    expect(slots.some((slot) => slot.id === 99 || slot.id === 100 || slot.id === 101)).toBe(false);
  });

  it("stops at 4 PM and shows nothing after closing", () => {
    const beforeLast = pk("2026-11-05T10:39:00Z");
    const last = availablePickupWindows(samplePickupWindows(beforeLast), beforeLast);
    expect(last.map((slot) => [slot.start_at, slot.end_at])).toContainEqual(["2026-11-05T10:50:00.000Z", "2026-11-05T11:00:00.000Z"]);
    const closing = pk("2026-11-05T11:00:00Z");
    expect(availablePickupWindows(samplePickupWindows(closing), closing)).toHaveLength(0);
    const evening = pk("2026-11-05T14:23:00Z");
    expect(availablePickupWindows(samplePickupWindows(evening), evening)).toHaveLength(0);
  });

  it("generates the correct Pakistan calendar day regardless of device timezone", () => {
    const now = pk("2026-11-05T20:30:00Z");
    const slots = samplePickupWindows(now);
    expect(slots).toHaveLength(48);
    expect(slots[0].start_at).toBe("2026-11-06T03:00:00.000Z");
    expect(slots.at(-1)?.end_at).toBe("2026-11-06T11:00:00.000Z");
  });
});
