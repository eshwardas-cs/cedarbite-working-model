import { describe, expect, it, vi } from "vitest";
import { submitOrderWithRecovery } from "./orderSubmission";

const order = { id: "2f8e0942-21a1-49db-8134-26b6fc73e008", pickup_code: "CB12AB34" };
const noWait = async () => {};

describe("student order submission recovery", () => {
  it("recovers an order saved before its POST response was lost", async () => {
    const saved = { ...order, status: "SUBMITTED" };
    const submit = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    const verify = vi.fn().mockResolvedValue({ order: saved });

    await expect(submitOrderWithRecovery(order, submit, verify, noWait)).resolves.toEqual(saved);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(order);
  });

  it("retries the exact same order when no saved order can be found", async () => {
    const submit = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    const verify = vi.fn().mockResolvedValue({ order: null });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(submitOrderWithRecovery(order, submit, verify, wait)).rejects.toThrow("Your bucket is unchanged");
    expect(submit).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls.every(([candidate]) => candidate === order)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("does not retry a server validation response", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("Order items are invalid."));
    const verify = vi.fn();

    await expect(submitOrderWithRecovery(order, submit, verify, noWait)).rejects.toThrow("Order items are invalid.");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });
});
