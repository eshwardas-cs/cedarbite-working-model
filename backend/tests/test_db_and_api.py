import unittest

from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app.auth.passwords import hash_password, verify_password
from app.core.config import ConfigError, load_settings
from app.db.base import Base, make_engine, make_session_factory
from app.main import create_app
from app.models import MenuCategory, MenuItem, Order, OrderItem, Role, User
from app.orders.state_machine import OrderStatus
from app.scheduling.modes import Mode


class PasswordTests(unittest.TestCase):
    def test_hash_is_not_plaintext_and_verifies(self):
        h = hash_password("correct horse battery")
        self.assertNotIn("correct horse", h)
        self.assertTrue(h.startswith("$argon2id$"))
        self.assertTrue(verify_password("correct horse battery", h))
        self.assertFalse(verify_password("wrong password!!", h))

    def test_garbage_hash_is_false_not_crash(self):
        self.assertFalse(verify_password("whatever-password", "not-a-hash"))

    def test_short_password_rejected(self):
        with self.assertRaises(ValueError):
            hash_password("short")


class ApiTests(unittest.TestCase):
    def test_built_website_is_served_from_the_api(self):
        c = TestClient(create_app(load_settings({})))
        response = c.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn('id="root"', response.text)
        self.assertIn("/assets/", response.text)

    def test_health(self):
        c = TestClient(create_app(load_settings({})))
        r = c.get("/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"status": "ok"})

    def test_payments_not_configured_never_claims_success(self):
        c = TestClient(create_app(load_settings({})))
        j = c.get("/api/payments/status").json()
        self.assertFalse(j["configured"])
        self.assertFalse(j["ordering_enabled"])
        self.assertEqual({m["id"] for m in j["methods"]},
                         {"easypaisa", "jazzcash", "bank_transfer", "card", "cash"})
        self.assertTrue(all(not m["available"] for m in j["methods"]))

    def test_unsafe_production_config_stops_startup(self):
        with self.assertRaises(ConfigError):
            create_app(load_settings({"CEDARBITE_ENV": "production"}))


class DbTests(unittest.TestCase):
    def setUp(self):
        self.engine = make_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.db = make_session_factory(self.engine)()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.engine.dispose()

    def _user(self, email="a@example.edu.pk"):
        u = User(email=email, password_hash="x", role=Role.STUDENT)
        self.db.add(u)
        self.db.commit()
        return u

    def test_duplicate_email_rejected(self):
        self._user()
        self.db.add(User(email="a@example.edu.pk", password_hash="y"))
        with self.assertRaises(IntegrityError):
            self.db.commit()

    def test_negative_price_rejected(self):
        cat = MenuCategory(name="Drinks")
        self.db.add(cat)
        self.db.commit()
        self.db.add(MenuItem(category_id=cat.id, name="Water", price_paisa=-1))
        with self.assertRaises(IntegrityError):
            self.db.commit()

    def test_order_with_items_round_trip(self):
        u = self._user()
        cat = MenuCategory(name="Drinks")
        self.db.add(cat)
        self.db.commit()
        water = MenuItem(category_id=cat.id, name="Water", price_paisa=8000, quick_allowed=True)
        self.db.add(water)
        self.db.commit()
        o = Order(user_id=u.id, mode=Mode.QUICK, total_paisa=16000, pickup_code="AAAAAA")
        o.items.append(OrderItem(menu_item_id=water.id, name_snapshot="Water",
                                 unit_price_paisa=8000, quantity=2))
        self.db.add(o)
        self.db.commit()
        got = self.db.get(Order, o.id)
        self.assertEqual(got.status, OrderStatus.AWAITING_PAYMENT)
        self.assertEqual(got.items[0].quantity, 2)

    def test_zero_quantity_rejected(self):
        u = self._user()
        cat = MenuCategory(name="Snacks")
        self.db.add(cat)
        self.db.commit()
        item = MenuItem(category_id=cat.id, name="Chips", price_paisa=5000)
        self.db.add(item)
        self.db.commit()
        o = Order(user_id=u.id, mode=Mode.QUICK, total_paisa=0, pickup_code="BBBBBB")
        o.items.append(OrderItem(menu_item_id=item.id, name_snapshot="Chips",
                                 unit_price_paisa=5000, quantity=0))
        self.db.add(o)
        with self.assertRaises(IntegrityError):
            self.db.commit()

    def test_order_for_missing_user_rejected(self):
        self.db.add(Order(user_id=9999, mode=Mode.QUICK, total_paisa=0, pickup_code="CCCCCC"))
        with self.assertRaises(IntegrityError):
            self.db.commit()


if __name__ == "__main__":
    unittest.main()
