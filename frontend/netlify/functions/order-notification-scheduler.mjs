import * as orderStore from "../../shared/order-store.mjs";
import { deliverOrderEmail, processPendingEmailDeliveries } from "../../shared/notifications.mjs";

export default async () => {
  try {
    const readyOrders = await orderStore.listScheduledReady(1000);
    for (const order of readyOrders) {
      if (order.customer_email) await deliverOrderEmail(order, "ready_receipt");
    }
    const retried = await processPendingEmailDeliveries(orderStore);
    console.info("CedarBite scheduled-order email check finished.", { readyOrdersChecked: readyOrders.length, retried });
  } catch (error) {
    console.error("CedarBite notification schedule could not complete.", { error: String(error?.message ?? error) });
  }
};

export const config = { schedule: "* * * * *" };
