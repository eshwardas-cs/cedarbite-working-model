import hashlib, hmac, unittest
from app.core.config import ConfigError, load_settings
from app.core.money import format_pkr, rupees_to_paisa
from app.orders.state_machine import InvalidTransition, OrderStatus as S, check_transition
from app.payments.base import (NotConfiguredProvider, ProviderNotConfigured, hmac_hex_matches)
from app.scheduling.modes import ItemRules, Mode, NoValidMode, resolve_order_mode


class MoneyTests(unittest.TestCase):
    def test_no_float_error(self):
        self.assertEqual(rupees_to_paisa("0.1") + rupees_to_paisa("0.2"), rupees_to_paisa("0.3"))
    def test_parse_and_format(self):
        self.assertEqual(rupees_to_paisa("125.50"), 12550)
        self.assertEqual(format_pkr(1234567), "Rs 12,345.67")
    def test_negative_rejected(self):
        with self.assertRaises(ValueError):
            rupees_to_paisa("-1")


class ConfigTests(unittest.TestCase):
    def test_dev_defaults_and_payments_off(self):
        s = load_settings({})
        self.assertFalse(s.payments_configured)
        selected = load_settings({"CEDARBITE_ENV": "development", "PAYMENT_PROVIDER": "jazzcash"})
        self.assertFalse(selected.payments_configured)
        self.assertNotIn("secret", str(s.safe_summary()).lower())
    def test_production_rejects_unsafe(self):
        with self.assertRaises(ConfigError):
            load_settings({"CEDARBITE_ENV": "production"})
    def test_production_ok(self):
        s = load_settings({"CEDARBITE_ENV": "production", "SESSION_SECRET": "x" * 40,
                           "DATABASE_URL": "postgresql://u:p@h/db", "ALLOWED_EMAIL_DOMAIN": "Example.edu.pk",
                           "PUBLIC_BASE_URL": "https://cedarbite.example.pk", "EMAIL_BACKEND": "smtp",
                           "SMTP_HOST": "smtp.example.test", "SMTP_USERNAME": "mailer",
                           "SMTP_PASSWORD": "test-secret", "SMTP_FROM_EMAIL": "noreply@example.test"})
        self.assertEqual(s.allowed_email_domain, "example.edu.pk")
    def test_bad_env(self):
        with self.assertRaises(ConfigError):
            load_settings({"CEDARBITE_ENV": "prod"})


class StateMachineTests(unittest.TestCase):
    def test_student_cannot_mark_paid(self):
        with self.assertRaises(InvalidTransition):
            check_transition(S.PAYMENT_PENDING, S.SUBMITTED, "student")
    def test_staff_cannot_mark_paid(self):
        with self.assertRaises(InvalidTransition):
            check_transition(S.PAYMENT_PENDING, S.SUBMITTED, "staff")
    def test_system_can_after_verification(self):
        check_transition(S.PAYMENT_PENDING, S.SUBMITTED, "system")
    def test_cannot_skip_to_collected(self):
        with self.assertRaises(InvalidTransition):
            check_transition(S.SUBMITTED, S.COLLECTED, "owner")
    def test_no_double_collect(self):
        with self.assertRaises(InvalidTransition):
            check_transition(S.COLLECTED, S.COLLECTED, "staff")
    def test_happy_path(self):
        for a, b, r in [(S.SUBMITTED, S.ACCEPTED, "staff"), (S.ACCEPTED, S.PREPARING, "staff"),
                        (S.PREPARING, S.READY, "staff"), (S.READY, S.COLLECTED, "staff")]:
            check_transition(a, b, r)
    def test_staff_cannot_cancel_paid_order(self):
        with self.assertRaises(InvalidTransition):
            check_transition(S.SUBMITTED, S.CANCELLED, "staff")
    def test_refunded_is_terminal(self):
        with self.assertRaises(InvalidTransition):
            check_transition(S.REFUNDED, S.READY, "owner")


class ModeTests(unittest.TestCase):
    Q = ItemRules(True, False); SC = ItemRules(False, True); BOTH = ItemRules(True, True)
    def test_all_quick(self):
        self.assertEqual(resolve_order_mode([self.Q, self.BOTH]), Mode.QUICK)
    def test_mixed_becomes_scheduled(self):
        self.assertEqual(resolve_order_mode([self.BOTH, self.SC]), Mode.SCHEDULED)
    def test_quick_only_plus_scheduled_only_must_split(self):
        with self.assertRaises(NoValidMode):
            resolve_order_mode([self.Q, self.SC])
    def test_empty_and_impossible(self):
        with self.assertRaises(NoValidMode): resolve_order_mode([])
        with self.assertRaises(NoValidMode): resolve_order_mode([ItemRules(False, False)])


class PaymentTests(unittest.TestCase):
    def test_not_configured_never_succeeds(self):
        p = NotConfiguredProvider()
        for call in (lambda: p.create_checkout("o", 100, "k"), lambda: p.get_status("r"),
                     lambda: p.verify_webhook(b"{}", {})):
            with self.assertRaises(ProviderNotConfigured): call()
    def test_hmac_check(self):
        body, secret = b'{"a":1}', "s3cret"
        good = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        self.assertTrue(hmac_hex_matches(secret, body, good))
        self.assertFalse(hmac_hex_matches(secret, body + b" ", good))
        self.assertFalse(hmac_hex_matches("wrong", body, good))


if __name__ == "__main__":
    unittest.main()
