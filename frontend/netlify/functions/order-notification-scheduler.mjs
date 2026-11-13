import * as orderStore from "../../shared/order-store.mjs";
import { deliverOrderEmail, processPendingEmailDeliveries } from "../../shared/notifications.mjs";

export default async () => {
  const now = Date.now();
  const cutoff = new Date(now - 10 * 60_000).toISOString();
  let remindersQueued = 0;
  try {
    const readyOrders = await orderStore.listReadyForReminder(cutoff, 100);
    for (const order of readyOrders) {
      if (order.status === "READY" && order.ready_at && Date.parse(order.ready_at) <= now - 10 * 60_000) {
        await deliverOrderEmail(order, "collection_reminder");
        remindersQueued += 1;
      }
    }
    const retried = await processPendingEmailDeliveries(orderStore);
    console.info("CedarBite notification schedule finished.", { remindersQueued, retried });
  } catch (error) {
    console.error("CedarBite notification schedule could not complete.", { error: String(error?.message ?? error) });
  }
};

export const config = { schedule: "* * * * *" };
