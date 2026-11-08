type OrderWithPickupCode = { pickup_code: string };
type OrderResponse<T> = { order?: T | null };

/**
 * Retry an order with the same ID and recover a successful save if the POST
 * response was lost between Netlify and the browser.
 */
export async function submitOrderWithRecovery<T extends OrderWithPickupCode>(
  order: T,
  submit: (order: T) => Promise<OrderResponse<T>>,
  verify: (order: T) => Promise<OrderResponse<T>>,
  wait: (milliseconds: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await submit(order);
      if (response.order?.pickup_code) return response.order;
      throw new Error("The canteen did not confirm this order. Your bucket is still here.");
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      try {
        const saved = await verify(order);
        if (saved.order?.pickup_code === order.pickup_code) return saved.order;
      } catch (verificationError) {
        if (!(verificationError instanceof TypeError)) throw verificationError;
      }
      if (attempt < 2) await wait(400 * (attempt + 1));
    }
  }

  throw new Error("CedarBite could not confirm the order connection. Your bucket is unchanged. Please ask the canteen to check before retrying.");
}
