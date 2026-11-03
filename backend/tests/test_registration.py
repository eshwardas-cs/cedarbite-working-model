import re
import unittest
from datetime import timedelta

from fastapi.testclient import TestClient

from app.auth.passwords import check_password_policy
from app.core.config import load_settings
from app.db.base import Base, make_engine, make_session_factory, utcnow
from app.main import create_app
from app.models import EmailToken, User
from app.notifications.email import EmailSender

PW = "a-good-password-1"


class CaptureSender(EmailSender):
    def __init__(self):
        self.sent = []

    def send(self, to, subject, body):
        self.sent.append((to, subject, body))
        return True

    def token(self):
        return re.search(r"token=([A-Za-z0-9_\-]+)", self.sent[-1][2]).group(1)


class PasswordPolicyTests(unittest.TestCase):
    def test_limits(self):
        check_password_policy("x" * 10)
        check_password_policy("x" * 128)
        for bad in ("short", "x" * 129, " " * 12):
            with self.assertRaises(ValueError, msg=bad[:10]):
                check_password_policy(bad)


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = make_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.sf = make_session_factory(self.engine)
        self.sender = CaptureSender()
        settings = load_settings({"CEDARBITE_ENV": "test", "ALLOWED_EMAIL_DOMAIN": "cedar.edu.pk"})
        self.client = TestClient(create_app(settings, session_factory=self.sf, email_sender=self.sender))

    def tearDown(self):
        self.engine.dispose()

    def register(self, email="2526245@cedar.edu.pk", password=PW):
        return self.client.post("/api/auth/register", json={"email": email, "password": password})

    def user(self, email="2526245@cedar.edu.pk"):
        db = self.sf()
        try:
            return db.query(User).filter_by(email=email).one_or_none()
        finally:
            db.close()

    def test_register_then_verify(self):
        r = self.register()
        self.assertEqual(r.status_code, 202)
        u = self.user()
        self.assertEqual(u.role.value, "student")
        self.assertFalse(u.email_verified)
        self.assertEqual(self.sender.sent[0][0], "2526245@cedar.edu.pk")
        v = self.client.post("/api/auth/verify-email", json={"token": self.sender.token()})
        self.assertEqual(v.status_code, 200)
        self.assertTrue(self.user().email_verified)

    def test_token_is_single_use(self):
        self.register()
        token = self.sender.token()
        self.assertEqual(self.client.post("/api/auth/verify-email", json={"token": token}).status_code, 200)
        self.assertEqual(self.client.post("/api/auth/verify-email", json={"token": token}).status_code, 400)

    def test_garbage_token_rejected(self):
        self.assertEqual(self.client.post("/api/auth/verify-email", json={"token": "nope"}).status_code, 400)

    def test_expired_token_rejected(self):
        self.register()
        db = self.sf()
        row = db.query(EmailToken).one()
        row.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()
        db.close()
        self.assertEqual(self.client.post("/api/auth/verify-email",
                                          json={"token": self.sender.token()}).status_code, 400)
        self.assertFalse(self.user().email_verified)

    def test_other_domains_refused_and_no_email_sent(self):
        r = self.register("ali@gmail.com")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.sender.sent, [])
        self.assertIsNone(self.user("ali@gmail.com"))

    def test_registration_requires_seven_digit_cedar_student_id(self):
        for email in ("ali@cedar.edu.pk", "252624@cedar.edu.pk", "25262458@cedar.edu.pk"):
            with self.subTest(email=email):
                response = self.register(email)
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.sender.sent, [])

    def test_duplicate_registration_looks_identical_and_sends_nothing(self):
        first = self.register()
        again = self.register()
        self.assertEqual((first.status_code, first.json()), (again.status_code, again.json()))
        self.assertEqual(len(self.sender.sent), 1)

    def test_weak_password_refused(self):
        self.assertEqual(self.register(password="short").status_code, 400)
        self.assertEqual(self.sender.sent, [])

    def test_response_says_email_delivery_is_not_configured(self):
        # settings have EMAIL_BACKEND=none, so the API must not imply email is working
        self.assertFalse(self.register().json()["email_delivery_configured"])

    def test_unverified_user_can_log_in_but_is_marked_unverified(self):
        self.register()
        r = self.client.post("/api/auth/login", json={"email": "2526245@cedar.edu.pk", "password": PW})
        self.assertEqual(r.status_code, 200)
        me = self.client.get("/api/auth/me").json()
        self.assertFalse(me["email_verified"])
        self.assertEqual(me["student_id"], "2526245")


if __name__ == "__main__":
    unittest.main()
