# Decisions and assumptions
1. **Mixed carts**: all items quick-eligible -> Quick Order (no slot). Else all
   scheduled-eligible -> whole order Scheduled. Else ask the student to split.
   Chosen as the simplest operationally sound option; confirm with canteen staff.
2. **Money**: integer paisa, never floats.
3. **Config**: stdlib dataclass reading env vars; production refuses weak secrets,
   SQLite, or a missing email domain.
4. **Payments**: ordering that needs payment stays disabled while no provider is configured.

## Orders (added with the order system)
5. **Cart**: the browser keeps the list of (item, quantity); the server never trusts it.
   `POST /api/orders/quote` prices a cart from current database prices and lists problems
   (unavailable items, bad quantities, mixed modes). `POST /api/orders` re-checks everything.
   If the browser sends the total it saw and prices have since changed, the order is refused (409)
   and the new total is shown. Extra fields such as a client "price" or "status" are ignored.
6. **Mixed carts**: quick-only + made-to-order-only items cannot share an order; the student is
   asked to place two orders. Items that allow both modes can join either kind of cart.
7. **Quick vs Scheduled**: Quick orders must not carry a pickup window; Scheduled orders must.
   A window must start at least (longest preparation time, minimum 5 minutes) after the order is placed.
8. **Capacity**: each window has a maximum number of orders. Paid orders count; unpaid orders hold a
   slot for 15 minutes, then it frees up automatically. Cancelled orders free their slot. On PostgreSQL
   the window row is locked while an order is placed so two students cannot take the last slot.
9. **Retry safety**: every order request needs an `Idempotency-Key` header. Repeating a key returns the
   original order. Status changes are compare-and-swap, so two people clicking at once cannot both win
   (this is what stops an order being collected twice).
10. **Pickup code**: students show a random 6-character code at the counter (no 0/O/1/I/L). Order
    numbers are never used as the handover identifier.
11. **Ordering gate**: placing orders is refused with "Digital payments are not yet available" until a
    payment provider is configured. Staff/managers can also pause ordering. Menu browsing and
    price quotes always work.
12. **Not yet built**: payments (orders stay AWAITING_PAYMENT), notifications, cleanup of expired unpaid orders.

## Open question for the canteen
Would the pilot accept **pay at the counter** (cash) as a first payment method before an online provider is
approved? It is a real payment, not a fake one, but it is a different workflow (staff confirm cash received)
and needs the canteen's agreement. Not built.
