import unittest

from fastapi.testclient import TestClient

from app.auth.roles import Role
from app.auth.service import create_owner, create_user
from app.core.config import load_settings
from app.db.base import Base, make_engine, make_session_factory
from app.main import create_app
from app.models import User

PW = "a-good-password-1"


class AuthApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = make_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.sf = make_session_factory(self.engine)
        db = self.sf()
        create_owner(db, "owner@example.edu.pk", PW)
        create_user(db, "student@example.edu.pk", PW, Role.STUDENT, email_verified=True)
        create_user(db, "canteen@example.edu.pk", PW, Role.MANAGER, email_verified=True)
        db.close()
        self.app = create_app(load_settings({"CEDARBITE_ENV": "test"}), session_factory=self.sf)

    def tearDown(self):
        self.engine.dispose()

    def client(self):
        return TestClient(self.app)

    def login(self, email, password=PW):
        c = self.client()
        r = c.post("/api/auth/login", json={"email": email, "password": password})
        return c, r

    def test_login_success_sets_httponly_cookie(self):
        c, r = self.login("student@example.edu.pk")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["role"], "student")
        self.assertIn("httponly", r.headers["set-cookie"].lower())

    def test_wrong_password_and_unknown_email_look_identical(self):
        _, a = self.login("student@example.edu.pk", "wrong-password-1")
        _, b = self.login("nobody@example.edu.pk")
        self.assertEqual((a.status_code, a.json()), (b.status_code, b.json()))
        self.assertEqual(a.status_code, 401)

    def test_disabled_account_cannot_login(self):
        db = self.sf()
        u = db.query(User).filter_by(email="student@example.edu.pk").one()
        u.is_active = False
        db.commit()
        db.close()
        _, r = self.login("student@example.edu.pk")
        self.assertEqual(r.status_code, 401)

    def test_me_requires_login(self):
        self.assertEqual(self.client().get("/api/auth/me").status_code, 401)
        c, _ = self.login("student@example.edu.pk")
        r = c.get("/api/auth/me")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("payment.config", r.json()["permissions"])

    def test_logout_needs_csrf_then_ends_session(self):
        c, r = self.login("student@example.edu.pk")
        token = r.json()["csrf_token"]
        self.assertEqual(c.post("/api/auth/logout").status_code, 403)
        self.assertEqual(c.post("/api/auth/logout", headers={"X-CSRF-Token": "wrong"}).status_code, 403)
        self.assertEqual(c.post("/api/auth/logout", headers={"X-CSRF-Token": token}).status_code, 200)
        self.assertEqual(c.get("/api/auth/me").status_code, 401)

    def test_login_is_throttled(self):
        for _ in range(5):
            self.assertEqual(self.login("student@example.edu.pk", "wrong-password-1")[1].status_code, 401)
        self.assertEqual(self.login("student@example.edu.pk")[1].status_code, 429)

    def _transfer(self, c, token, **over):
        body = {"new_owner_email": "canteen@example.edu.pk", "old_owner_new_role": "college_admin",
                "password": PW, "confirm": "TRANSFER OWNERSHIP"}
        body.update(over)
        return c.post("/api/owner/transfer-ownership", json=body, headers={"X-CSRF-Token": token})

    def test_student_cannot_transfer_ownership(self):
        c, r = self.login("student@example.edu.pk")
        self.assertEqual(self._transfer(c, r.json()["csrf_token"]).status_code, 403)

    def test_manager_cannot_transfer_ownership(self):
        c, r = self.login("canteen@example.edu.pk")
        self.assertEqual(self._transfer(c, r.json()["csrf_token"]).status_code, 403)

    def test_owner_transfer_needs_confirmation_and_password(self):
        c, r = self.login("owner@example.edu.pk")
        t = r.json()["csrf_token"]
        self.assertEqual(self._transfer(c, t, confirm="yes").status_code, 400)
        self.assertEqual(self._transfer(c, t, password="wrong-password-1").status_code, 403)

    def test_owner_transfer_succeeds_and_swaps_roles(self):
        c, r = self.login("owner@example.edu.pk")
        self.assertEqual(self._transfer(c, r.json()["csrf_token"]).status_code, 200)
        db = self.sf()
        roles = {u.email: u.role for u in db.query(User).all()}
        db.close()
        self.assertEqual(roles["canteen@example.edu.pk"], Role.OWNER)
        self.assertEqual(roles["owner@example.edu.pk"], Role.COLLEGE_ADMIN)
        # the previous owner immediately loses owner powers
        self.assertEqual(self._transfer(c, r.json()["csrf_token"]).status_code, 403)


if __name__ == "__main__":
    unittest.main()
