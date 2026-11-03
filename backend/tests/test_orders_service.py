import unittest
import uuid
from datetime import timedelta

from app.auth.roles import Role
from app.auth.service import create_owner, create_user
from app.db.base import Base, make_engine, make_session_factory, utcnow
from app.menu import service as menu
from app.models import Order, OrderStatusHistory
from app.orders import service as svc
from app.orders.service import Line, OrderError
from app.orders.state_machine import OrderStatus as S
from app.scheduling.modes import Mode

PW = "a-good-password-1"


class OrderTestBase(unittest.TestCase):
    def setUp(self):
        self.engine = make_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.db = make_session_factory(self.engine)()
        db = self.db
        self.owner = create_owner(db, "owner@example.edu.pk", PW)
        self.s1 = create_user(db, "s1@example.edu.pk", PW, Role.STUDENT, True)
        self.s2 = create_user(db, "s2@example.edu.pk", PW, Role.STUDENT, True)
        self.s3 = create_user(db, "s3@example.edu.pk", PW, Role.STUDENT, True)
        self.unverified = create_user(db, "u@example.edu.pk", PW, Role.STUDENT, False)
        cat = menu.create_category(db, self.owner, "Food")

        def mk(name, price, quick, sched, prep=None):
            return menu.create_item(db, self.owner, category_id=cat.id, name=name, price_paisa=price,
                                    quick_allowed=quick, scheduled_allowed=sched, prep_minutes=prep).id
        self.water = mk("Water", 8000, True, True)
        self.chips = mk("Chips", 10000, True, False)
        self.burger = mk("Burger", 35000, False, True, 12)
        self.fries = mk("Fries", 18000, False, True, 8)
        self.now = utcnow()
        self.win = svc.create_window(db, self.owner, self.now + timedelta(hours=2),
                                     self.now + timedelta(hours=3), 2)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def place(self, lines, user=None, key=None, **kw):
        return svc.create_order(self.db, user or self.s1, [Line(i, q) for i, q in lines],
                                idempotency_key=key or uuid.uuid4().hex[:16], **kw)


class QuoteTests(OrderTestBase):
    def quote(self, lines):
        return svc.price_cart(self.db, [Line(i, q) for i, q in lines])

    def test_quick_cart(self):
        q = self.quote([(self.water, 2), (self.chips, 1)])
        self.assertEqual((q.mode, q.total_paisa, q.problems), (Mode.QUICK, 26000, []))

    def test_scheduled_cart(self):
        q = self.quote([(self.burger, 1), (self.fries, 2)])
        self.assertEqual((q.mode, q.total_paisa), (Mode.SCHEDULED, 71000))

    def test_item_allowing_both_modes_joins_a_scheduled_cart(self):
        self.assertEqual(self.quote([(self.water, 1), (self.burger, 1)]).mode, Mode.SCHEDULED)

    def test_quick_only_and_scheduled_only_must_be_split(self):
        q = self.quote([(self.chips, 1), (self.burger, 1)])
        self.assertIsNone(q.mode)
        self.assertTrue(any("separate orders" in p for p in q.problems))

    def test_unavailable_and_archived_items_are_reported(self):
        menu.set_availability(self.db, self.owner, self.water, False)
        menu.archive_item(self.db, self.owner, self.chips)
        problems = " ".join(self.quote([(self.water, 1), (self.chips, 1)]).problems)
        self.assertIn("currently unavailable", problems)
        self.assertIn("no longer on the menu", problems)

    def test_bad_quantities_duplicates_and_empty(self):
        self.assertTrue(self.quote([(self.water, 0)]).problems)
        self.assertTrue(self.quote([(self.water, 11)]).problems)
        self.assertTrue(self.quote([(self.water, 1), (self.water, 1)]).problems)
        self.assertTrue(self.quote([]).problems)
        self.assertTrue(self.quote([(9999, 1)]).problems)

    def test_total_quantity_limit(self):
        q = self.quote([(self.water, 10), (self.chips, 10), (self.burger, 10), (self.fries, 10)])
        self.assertTrue(any("in total" in p for p in q.problems))


class CreateOrderTests(OrderTestBase):
    def test_quick_order(self):
        order, created = self.place([(self.water, 2), (self.chips, 1)])
        self.assertTrue(created)
        self.assertEqual((order.status, order.mode, order.total_paisa), (S.AWAITING_PAYMENT, Mode.QUICK, 26000))
        self.assertIsNone(order.pickup_window_id)
        self.assertEqual(len(order.pickup_code), 6)
        self.assertEqual(self.db.query(OrderStatusHistory).count(), 1)

    def test_quick_order_refuses_a_pickup_window(self):
        with self.assertRaises(OrderError):
            self.place([(self.water, 1)], pickup_window_id=self.win.id)

    def test_scheduled_order_needs_a_window(self):
        with self.assertRaises(OrderError):
            self.place([(self.burger, 1)])
        order, _ = self.place([(self.burger, 1)], pickup_window_id=self.win.id)
        self.assertEqual(order.pickup_window_id, self.win.id)
        self.assertEqual(order.mode, Mode.SCHEDULED)

    def test_window_too_soon_for_preparation_time(self):
        soon = svc.create_window(self.db, self.owner, self.now + timedelta(minutes=3),
                                 self.now + timedelta(minutes=30), 5)
        with self.assertRaises(OrderError) as ctx:
            self.place([(self.burger, 1)], pickup_window_id=soon.id)   # needs 12 minutes
        self.assertIn("too soon", str(ctx.exception))

    def test_unknown_or_closed_window(self):
        with self.assertRaises(OrderError):
            self.place([(self.burger, 1)], pickup_window_id=9999)
        self.win.is_open = False
        self.db.commit()
        with self.assertRaises(OrderError):
            self.place([(self.burger, 1)], pickup_window_id=self.win.id)

    def test_capacity_is_enforced(self):
        self.place([(self.burger, 1)], user=self.s1, pickup_window_id=self.win.id)
        self.place([(self.burger, 1)], user=self.s2, pickup_window_id=self.win.id)
        with self.assertRaises(OrderError) as ctx:
            self.place([(self.burger, 1)], user=self.s3, pickup_window_id=self.win.id)
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(svc.list_windows(self.db)[0]["remaining"], 0)

    def test_unpaid_reservation_expires(self):
        first, _ = self.place([(self.burger, 1)], user=self.s1, pickup_window_id=self.win.id)
        self.place([(self.burger, 1)], user=self.s2, pickup_window_id=self.win.id)
        first.created_at = utcnow() - timedelta(minutes=svc.RESERVATION_MINUTES + 5)
        self.db.commit()
        self.place([(self.burger, 1)], user=self.s3, pickup_window_id=self.win.id)   # slot freed

    def test_cancelling_frees_a_slot(self):
        first, _ = self.place([(self.burger, 1)], user=self.s1, pickup_window_id=self.win.id)
        self.place([(self.burger, 1)], user=self.s2, pickup_window_id=self.win.id)
        svc.change_status(self.db, first.id, S.CANCELLED, "student", self.s1.id)
        self.place([(self.burger, 1)], user=self.s3, pickup_window_id=self.win.id)

    def test_same_idempotency_key_returns_the_same_order(self):
        a, created_a = self.place([(self.water, 1)], key="same-key-123")
        b, created_b = self.place([(self.water, 1)], key="same-key-123")
        self.assertEqual((a.id, created_a, created_b), (b.id, True, False))
        self.assertEqual(self.db.query(Order).count(), 1)
        c, created_c = self.place([(self.water, 1)], user=self.s2, key="same-key-123")
        self.assertTrue(created_c)
        self.assertNotEqual(c.id, a.id)

    def test_price_change_is_caught_before_ordering(self):
        with self.assertRaises(OrderError) as ctx:
            self.place([(self.water, 1)], expected_total_paisa=1)
        self.assertEqual(ctx.exception.status, 409)
        order, _ = self.place([(self.water, 1)], expected_total_paisa=8000)
        self.assertEqual(order.total_paisa, 8000)

    def test_order_keeps_the_price_it_was_placed_at(self):
        order, _ = self.place([(self.water, 1)])
        menu.update_item(self.db, self.owner, self.water, {"price_paisa": 9900})
        self.db.refresh(order)
        self.assertEqual(order.items[0].unit_price_paisa, 8000)
        self.assertEqual(self.place([(self.water, 1)])[0].total_paisa, 9900)

    def test_unverified_or_disabled_users_cannot_order(self):
        with self.assertRaises(OrderError) as ctx:
            self.place([(self.water, 1)], user=self.unverified)
        self.assertEqual(ctx.exception.status, 403)
        self.s1.is_active = False
        self.db.commit()
        with self.assertRaises(OrderError):
            self.place([(self.water, 1)], user=self.s1)

    def test_unavailable_item_blocks_the_order(self):
        menu.set_availability(self.db, self.owner, self.water, False)
        with self.assertRaises(OrderError):
            self.place([(self.water, 1)])


class StatusTests(OrderTestBase):
    def paid_order(self):
        order, _ = self.place([(self.water, 1)])
        # TEST ONLY: stands in for a payment the provider has verified.
        svc.change_status(self.db, order.id, S.PAYMENT_PENDING, "system")
        return svc.change_status(self.db, order.id, S.SUBMITTED, "system")

    def test_full_lifecycle_and_history(self):
        o = self.paid_order()
        for target in (S.ACCEPTED, S.PREPARING, S.READY, S.COLLECTED):
            o = svc.change_status(self.db, o.id, target, "staff")
        self.assertEqual(o.status, S.COLLECTED)
        self.assertEqual(self.db.query(OrderStatusHistory).filter_by(order_id=o.id).count(), 7)

    def test_cannot_skip_steps_or_collect_twice(self):
        o = self.paid_order()
        with self.assertRaises(OrderError):
            svc.change_status(self.db, o.id, S.COLLECTED, "staff")
        for target in (S.ACCEPTED, S.PREPARING, S.READY, S.COLLECTED):
            svc.change_status(self.db, o.id, target, "staff")
        with self.assertRaises(OrderError) as ctx:
            svc.change_status(self.db, o.id, S.COLLECTED, "staff")
        self.assertEqual(ctx.exception.status, 409)

    def test_students_cannot_mark_orders_paid_or_ready(self):
        order, _ = self.place([(self.water, 1)])
        svc.change_status(self.db, order.id, S.PAYMENT_PENDING, "system")
        with self.assertRaises(OrderError):
            svc.change_status(self.db, order.id, S.SUBMITTED, "student")
        paid = self.paid_order()
        with self.assertRaises(OrderError):
            svc.change_status(self.db, paid.id, S.READY, "student")

    def test_staff_cannot_cancel_a_paid_order_but_a_manager_can(self):
        o = self.paid_order()
        with self.assertRaises(OrderError):
            svc.change_status(self.db, o.id, S.CANCELLED, "staff")
        self.assertEqual(svc.change_status(self.db, o.id, S.CANCELLED, "manager", self.owner.id).status, S.CANCELLED)

    def test_unknown_order(self):
        with self.assertRaises(OrderError) as ctx:
            svc.change_status(self.db, 9999, S.ACCEPTED, "staff")
        self.assertEqual(ctx.exception.status, 404)

    def test_queue_shows_only_active_paid_orders_and_no_identity(self):
        self.place([(self.water, 1)])                      # unpaid: not in queue
        o = self.paid_order()
        queue = svc.queue_view(self.db)
        self.assertEqual([q["id"] for q in queue], [o.id])
        self.assertEqual(set(queue[0]), {"id", "pickup_code", "status", "mode", "created_at",
                                         "waiting_minutes", "pickup_window", "items"})
        svc.change_status(self.db, o.id, S.ACCEPTED, "staff")
        for t in (S.PREPARING, S.READY, S.COLLECTED):
            svc.change_status(self.db, o.id, t, "staff")
        self.assertEqual(svc.queue_view(self.db), [])      # collected orders leave the queue


class WindowTests(OrderTestBase):
    def test_validation(self):
        n = self.now
        for start, end, cap in ((n + timedelta(hours=3), n + timedelta(hours=2), 5),
                                (n - timedelta(hours=1), n + timedelta(hours=1), 5),
                                (n + timedelta(hours=1), n + timedelta(hours=9), 5),
                                (n + timedelta(hours=1), n + timedelta(hours=2), 0),
                                (n + timedelta(hours=1), n + timedelta(hours=2), 201)):
            with self.assertRaises(OrderError):
                svc.create_window(self.db, self.owner, start, end, cap)

    def test_pause_flag(self):
        self.assertFalse(svc.get_flag(self.db, "ordering_paused"))
        svc.set_ordering_paused(self.db, self.owner, True)
        self.assertTrue(svc.get_flag(self.db, "ordering_paused"))
        svc.set_ordering_paused(self.db, self.owner, False)
        self.assertFalse(svc.get_flag(self.db, "ordering_paused"))


if __name__ == "__main__":
    unittest.main()
