import unittest

from fastapi.testclient import TestClient

from app.auth.roles import Role
from app.auth.service import create_owner, create_user
from app.core.config import load_settings
from app.db.base import Base, make_engine, make_session_factory
from app.main import create_app
from app.menu import service
from app.models import AuditLog, User

PW = "a-good-password-1"


class MenuApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = make_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.sf = make_session_factory(self.engine)
        db = self.sf()
        owner = create_owner(db, "owner@example.edu.pk", PW)
        for email, role in (("manager@example.edu.pk", Role.MANAGER), ("staff@example.edu.pk", Role.STAFF),
                            ("student@example.edu.pk", Role.STUDENT)):
            create_user(db, email, PW, role, email_verified=True)
        cat = service.create_category(db, owner, "Drinks")
        self.cat_id = cat.id
        self.item_id = service.create_item(db, owner, category_id=cat.id, name="Water", price_paisa=8000,
                                           quick_allowed=True, scheduled_allowed=True).id
        db.close()
        self.app = create_app(load_settings({"CEDARBITE_ENV": "test"}), session_factory=self.sf)

    def tearDown(self):
        self.engine.dispose()

    def login(self, email):
        c = TestClient(self.app)
        r = c.post("/api/auth/login", json={"email": email, "password": PW})
        return c, {"X-CSRF-Token": r.json()["csrf_token"]}

    def audit_actions(self):
        db = self.sf()
        try:
            return [a.action for a in db.query(AuditLog).all()]
        finally:
            db.close()

    def test_public_menu_needs_no_login_and_uses_integer_paisa(self):
        r = TestClient(self.app).get("/api/menu")
        self.assertEqual(r.status_code, 200)
        item = r.json()["categories"][0]["items"][0]
        self.assertEqual(item["price_paisa"], 8000)
        self.assertEqual(item["price_display"], "Rs 80.00")
        self.assertTrue(item["available"])

    def test_students_and_anonymous_cannot_manage_menu(self):
        # anonymous is refused (CSRF check or login check, whichever runs first)
        self.assertIn(TestClient(self.app).post("/api/menu/categories", json={"name": "X"}).status_code, (401, 403))
        c, h = self.login("student@example.edu.pk")
        self.assertEqual(c.post("/api/menu/categories", json={"name": "X"}, headers=h).status_code, 403)
        self.assertEqual(c.get("/api/menu/manage").status_code, 403)
        self.assertEqual(c.patch(f"/api/menu/items/{self.item_id}", json={"price_paisa": 1}, headers=h).status_code, 403)

    def test_csrf_is_required_for_changes(self):
        c, _ = self.login("manager@example.edu.pk")
        self.assertEqual(c.post("/api/menu/categories", json={"name": "Snacks"}).status_code, 403)

    def test_manager_creates_and_changes_price_with_audit(self):
        c, h = self.login("manager@example.edu.pk")
        r = c.post("/api/menu/categories", json={"name": "Snacks"}, headers=h)
        self.assertEqual(r.status_code, 201)
        r = c.post("/api/menu/items", headers=h, json={
            "category_id": r.json()["id"], "name": "Chips", "price_paisa": 10000, "quick_allowed": True})
        self.assertEqual(r.status_code, 201)
        r = c.patch(f"/api/menu/items/{r.json()['id']}", json={"price_paisa": 12000}, headers=h)
        self.assertEqual(r.json()["price_paisa"], 12000)
        self.assertIn("menu.price_changed", self.audit_actions())

    def test_staff_can_mark_out_of_stock_but_not_change_price(self):
        c, h = self.login("staff@example.edu.pk")
        r = c.patch(f"/api/menu/items/{self.item_id}/availability", json={"is_available": False}, headers=h)
        self.assertEqual(r.status_code, 200)
        public = TestClient(self.app).get("/api/menu").json()["categories"][0]["items"][0]
        self.assertFalse(public["available"])
        self.assertEqual(c.patch(f"/api/menu/items/{self.item_id}", json={"price_paisa": 1}, headers=h).status_code, 403)

    def test_validation(self):
        c, h = self.login("manager@example.edu.pk")
        base = {"category_id": self.cat_id, "name": "Thing", "price_paisa": 100}
        self.assertEqual(c.post("/api/menu/items", headers=h, json={**base, "price_paisa": -5}).status_code, 422)
        self.assertEqual(c.post("/api/menu/items", headers=h, json={**base, "price_paisa": 1.5}).status_code, 422)
        self.assertEqual(c.post("/api/menu/items", headers=h,
                                json={**base, "quick_allowed": False, "scheduled_allowed": False}).status_code, 422)
        self.assertEqual(c.post("/api/menu/items", headers=h, json={**base, "category_id": 9999}).status_code, 400)
        self.assertEqual(c.post("/api/menu/categories", headers=h, json={"name": "Drinks"}).status_code, 400)

    def test_patch_rules(self):
        c, h = self.login("manager@example.edu.pk")
        url = f"/api/menu/items/{self.item_id}"
        self.assertEqual(c.patch(url, headers=h, json={"quick_allowed": False, "scheduled_allowed": False}).status_code, 400)
        self.assertEqual(c.patch(url, headers=h, json={"price_paisa": None}).status_code, 400)
        self.assertEqual(c.patch("/api/menu/items/9999", headers=h, json={"price_paisa": 5}).status_code, 404)

    def test_archived_items_leave_the_public_menu_but_stay_in_manage_view(self):
        c, h = self.login("manager@example.edu.pk")
        self.assertEqual(c.post(f"/api/menu/items/{self.item_id}/archive", headers=h).status_code, 200)
        self.assertEqual(TestClient(self.app).get("/api/menu").json()["categories"], [])
        manage = c.get("/api/menu/manage").json()["categories"][0]["items"][0]
        self.assertFalse(manage["is_active"])
        self.assertFalse(manage["available"])


if __name__ == "__main__":
    unittest.main()
