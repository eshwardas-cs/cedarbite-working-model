import unittest
import uuid
from datetime import timedelta

from fastapi.testclient import TestClient

from app.auth.roles import Role
from app.auth.service import create_owner, create_user
from app.core.config import load_settings
from app.db.base import Base, make_engine, make_session_factory, utcnow
from app.main import create_app
from app.menu import service as menu
from app.orders import service as svc
from app.orders.state_machine import OrderStatus as S

PW = "a-good-password-1"


class OrdersApiTests(unittest.TestCase):
    PROVIDER = "test-provider"   # test environment only; this cannot enable real checkout

    def setUp(self):
        self.engine = make_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.sf = make_session_factory(self.engine)
        db = self.sf()
        owner = create_owner(db, "owner@example.edu.pk", PW)
        for email, role, verified in (("s1@example.edu.pk", Role.STUDENT, True), ("s2@example.edu.pk", Role.STUDENT, True),
                                      ("s3@example.edu.pk", Role.STUDENT, True), ("unv@example.edu.pk", Role.STUDENT, False),
                                      ("staff@example.edu.pk", Role.STAFF, True), ("mgr@example.edu.pk", Role.MANAGER, True)):
            create_user(db, email, PW, role, verified)
        cat = menu.create_category(db, owner, "Food")
        mk = lambda n, p, q, s, prep=None: menu.create_item(db, owner, category_id=cat.id, name=n, price_paisa=p,
                                                           quick_allowed=q, scheduled_allowed=s, prep_minutes=prep).id
        self.water, self.chips = mk("Water", 8000, True, True), mk("Chips", 10000, True, False)
        self.burger = mk("Burger", 35000, False, True, 12)
        now = utcnow()
        self.win = svc.create_window(db, owner, now + timedelta(hours=2), now + timedelta(hours=3), 2).id
        db.close()
        self.app = create_app(load_settings({"CEDARBITE_ENV": "test", "PAYMENT_PROVIDER": self.PROVIDER}),
                              session_factory=self.sf)

    def tearDown(self):
        self.engine.dispose()

    def login(self, email):
        c = TestClient(self.app)
        r = c.post("/api/auth/login", json={"email": email, "password": PW})
        return c, {"X-CSRF-Token": r.json()["csrf_token"]}

    def place(self, c, h, lines, key=None, **extra):
        headers = {**h, "Idempotency-Key": key or uuid.uuid4().hex[:16]}
        return c.post("/api/orders", headers=headers,
                      json={"lines": [{"item_id": i, "quantity": q} for i, q in lines], **extra})

    def mark_paid(self, order_id):
        # TEST ONLY: stands in for a payment the provider has verified.
        db = self.sf()
        svc.change_status(db, order_id, S.PAYMENT_PENDING, "system")
        svc.change_status(db, order_id, S.SUBMITTED, "system")
        db.close()

    def test_placing_and_repeating_an_order(self):
        c, h = self.login("s1@example.edu.pk")
        r = self.place(c, h, [(self.water, 2)], key="retry-key-0001")
        self.assertEqual(r.status_code, 201)
        body = r.json()
        self.assertEqual((body["status"], body["total_paisa"], len(body["pickup_code"])), ("AWAITING_PAYMENT", 16000, 6))
        again = self.place(c, h, [(self.water, 2)], key="retry-key-0001")
        self.assertEqual((again.status_code, again.json()["id"]), (200, body["id"]))
        self.assertEqual(len(c.get("/api/orders").json()["orders"]), 1)

    def test_idempotency_key_is_required(self):
        c, h = self.login("s1@example.edu.pk")
        r = c.post("/api/orders", headers=h, json={"lines": [{"item_id": self.water, "quantity": 1}]})
        self.assertEqual(r.status_code, 422)

    def test_ordering_is_blocked_while_no_payment_provider_is_configured(self):
        app = create_app(load_settings({"CEDARBITE_ENV": "test"}), session_factory=self.sf)
        c = TestClient(app)
        r = c.post("/api/auth/login", json={"email": "s1@example.edu.pk", "password": PW})
        h = {"X-CSRF-Token": r.json()["csrf_token"]}
        self.assertEqual(self.place(c, h, [(self.water, 1)]).status_code, 503)
        status = c.get("/api/ordering/status").json()
        self.assertFalse(status["accepting_orders"])
        self.assertIn("not enabled", status["reason"])
        quote = c.post("/api/orders/quote", headers=h, json={"lines": [{"item_id": self.water, "quantity": 2}]})
        self.assertEqual((quote.status_code, quote.json()["total_paisa"]), (200, 16000))

    def test_who_can_order(self):
        c, h = self.login("staff@example.edu.pk")
        self.assertEqual(self.place(c, h, [(self.water, 1)]).status_code, 403)
        c, h = self.login("unv@example.edu.pk")
        self.assertEqual(self.place(c, h, [(self.water, 1)]).status_code, 403)
        anon = TestClient(self.app)
        self.assertIn(anon.post("/api/orders", json={"lines": []}).status_code, (401, 403))

    def test_students_only_see_their_own_orders(self):
        c1, h1 = self.login("s1@example.edu.pk")
        oid = self.place(c1, h1, [(self.water, 1)]).json()["id"]
        c2, h2 = self.login("s2@example.edu.pk")
        self.assertEqual(c2.get(f"/api/orders/{oid}").status_code, 404)
        self.assertEqual(c2.get("/api/orders").json()["orders"], [])
        self.assertEqual(c2.post(f"/api/orders/{oid}/cancel", headers=h2).status_code, 404)
        self.assertEqual(c1.get(f"/api/orders/{oid}").status_code, 200)
        cm, _ = self.login("mgr@example.edu.pk")
        self.assertEqual(cm.get(f"/api/orders/{oid}").status_code, 200)

    def test_staff_queue_and_fulfilment(self):
        c1, h1 = self.login("s1@example.edu.pk")
        oid = self.place(c1, h1, [(self.water, 1)]).json()["id"]
        cs, hs = self.login("staff@example.edu.pk")
        self.assertEqual(cs.get("/api/queue").json()["orders"], [])        # unpaid orders are invisible
        self.mark_paid(oid)
        orders = cs.get("/api/queue").json()["orders"]
        self.assertEqual([o["id"] for o in orders], [oid])
        self.assertNotIn("email", str(orders).lower())
        self.assertEqual(c1.get("/api/queue").status_code, 403)             # students can't see the queue
        post = lambda to, c=cs, h=hs: c.post(f"/api/orders/{oid}/status", headers=h, json={"to": to})
        self.assertEqual(post("COLLECTED").status_code, 409)                # can't skip ahead
        for to in ("ACCEPTED", "PREPARING", "READY", "COLLECTED"):
            self.assertEqual(post(to).status_code, 200, to)
        self.assertEqual(post("COLLECTED").status_code, 409)                # not twice
        self.assertEqual(post("SUBMITTED", c1, h1).status_code, 403)        # students can't do this
        self.assertEqual(post("NONSENSE").status_code, 400)

    def test_cancelling(self):
        c1, h1 = self.login("s1@example.edu.pk")
        oid = self.place(c1, h1, [(self.water, 1)]).json()["id"]
        self.assertEqual(c1.post(f"/api/orders/{oid}/cancel", headers=h1).json()["status"], "CANCELLED")
        oid2 = self.place(c1, h1, [(self.water, 1)]).json()["id"]
        self.mark_paid(oid2)
        self.assertEqual(c1.post(f"/api/orders/{oid2}/cancel", headers=h1).status_code, 409)   # paid: ask staff
        cs, hs = self.login("staff@example.edu.pk")
        self.assertEqual(cs.post(f"/api/orders/{oid2}/status", headers=hs, json={"to": "CANCELLED"}).status_code, 403)
        cm, hm = self.login("mgr@example.edu.pk")
        self.assertEqual(cm.post(f"/api/orders/{oid2}/status", headers=hm, json={"to": "CANCELLED"}).status_code, 200)

    def test_pausing_orders(self):
        c1, h1 = self.login("s1@example.edu.pk")
        self.assertEqual(c1.post("/api/ordering/pause", headers=h1, json={"paused": True}).status_code, 403)
        cs, hs = self.login("staff@example.edu.pk")
        self.assertEqual(cs.post("/api/ordering/pause", headers=hs, json={"paused": True}).status_code, 200)
        self.assertEqual(self.place(c1, h1, [(self.water, 1)]).status_code, 503)
        self.assertFalse(c1.get("/api/ordering/status").json()["accepting_orders"])
        cs.post("/api/ordering/pause", headers=hs, json={"paused": False})
        self.assertEqual(self.place(c1, h1, [(self.water, 1)]).status_code, 201)

    def test_pickup_windows(self):
        anon = TestClient(self.app)
        self.assertEqual(anon.get("/api/pickup-windows").json()["windows"][0]["remaining"], 2)
        c1, h1 = self.login("s1@example.edu.pk")
        start = (utcnow() + timedelta(hours=5)).isoformat()
        end = (utcnow() + timedelta(hours=6)).isoformat()
        body = {"start_at": start, "end_at": end, "capacity": 4}
        self.assertEqual(c1.post("/api/pickup-windows", headers=h1, json=body).status_code, 403)
        cm, hm = self.login("mgr@example.edu.pk")
        self.assertEqual(cm.post("/api/pickup-windows", headers=hm, json=body).status_code, 201)
        self.assertEqual(cm.post("/api/pickup-windows", headers=hm, json={**body, "end_at": start}).status_code, 400)
        naive = {**body, "start_at": "2030-01-01T10:00:00", "end_at": "2030-01-01T11:00:00"}
        self.assertEqual(cm.post("/api/pickup-windows", headers=hm, json=naive).status_code, 422)

    def test_scheduled_orders_and_capacity(self):
        for email in ("s1@example.edu.pk", "s2@example.edu.pk"):
            c, h = self.login(email)
            r = self.place(c, h, [(self.burger, 1)], pickup_window_id=self.win)
            self.assertEqual(r.status_code, 201)
            self.assertEqual(r.json()["pickup_window"]["id"], self.win)
        c, h = self.login("s3@example.edu.pk")
        self.assertEqual(self.place(c, h, [(self.burger, 1)], pickup_window_id=self.win).status_code, 409)
        self.assertEqual(self.place(c, h, [(self.burger, 1)]).status_code, 400)   # slot required

    def test_mixed_cart_is_scheduled_and_price_change_is_refused(self):
        c, h = self.login("s1@example.edu.pk")
        r = self.place(c, h, [(self.chips, 1), (self.burger, 1)], pickup_window_id=self.win)
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["mode"], "SCHEDULED")
        r = self.place(c, h, [(self.water, 1)], expected_total_paisa=1)
        self.assertEqual(r.status_code, 409)
        self.assertIn("Prices have changed", r.json()["detail"])

    def test_client_cannot_set_its_own_price_or_status(self):
        c, h = self.login("s1@example.edu.pk")
        headers = {**h, "Idempotency-Key": "price-attack-1"}
        r = c.post("/api/orders", headers=headers, json={
            "lines": [{"item_id": self.water, "quantity": 1, "price_paisa": 1}], "status": "SUBMITTED",
            "total_paisa": 1})
        self.assertEqual(r.status_code, 201)
        self.assertEqual((r.json()["total_paisa"], r.json()["status"]), (8000, "AWAITING_PAYMENT"))


if __name__ == "__main__":
    unittest.main()
