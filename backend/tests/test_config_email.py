import unittest

from app.core.config import ConfigError, load_settings
from app.notifications.email import ConsoleEmailSender, NullEmailSender, SMTPEmailSender, sender_for

PROD = {"CEDARBITE_ENV": "production", "SESSION_SECRET": "x" * 40,
        "DATABASE_URL": "postgresql://u:p@h/db", "ALLOWED_EMAIL_DOMAIN": "example.edu.pk",
        "PUBLIC_BASE_URL": "https://cedarbite.example.pk", "EMAIL_BACKEND": "smtp",
        "SMTP_HOST": "smtp.example.test", "SMTP_USERNAME": "mailer",
        "SMTP_PASSWORD": "test-secret", "SMTP_FROM_EMAIL": "noreply@example.test"}


class EmailConfigTests(unittest.TestCase):
    def test_defaults_send_nothing(self):
        s = load_settings({})
        self.assertEqual(s.email_backend, "none")
        self.assertIsInstance(sender_for(s), NullEmailSender)
        self.assertFalse(sender_for(s).send("a@b.c", "x", "y"))

    def test_console_backend_in_development(self):
        self.assertIsInstance(sender_for(load_settings({"EMAIL_BACKEND": "console"})), ConsoleEmailSender)

    def test_smtp_backend_uses_configured_sender_without_exposing_secret(self):
        settings = load_settings({"EMAIL_BACKEND": "smtp", "SMTP_HOST": "smtp.example.test",
                                  "SMTP_FROM_EMAIL": "noreply@example.test"})
        self.assertIsInstance(sender_for(settings), SMTPEmailSender)
        self.assertNotIn("smtp_password", settings.safe_summary())

    def test_unknown_backend_rejected(self):
        with self.assertRaises(ConfigError):
            load_settings({"EMAIL_BACKEND": "carrier-pigeon"})

    def test_production_refuses_console_email(self):
        with self.assertRaises(ConfigError):
            load_settings({**PROD, "EMAIL_BACKEND": "console"})

    def test_production_requires_smtp_credentials(self):
        with self.assertRaises(ConfigError):
            load_settings({key: value for key, value in PROD.items()
                           if key not in {"SMTP_USERNAME", "SMTP_PASSWORD"}})

    def test_production_requires_https_base_url(self):
        with self.assertRaises(ConfigError):
            load_settings({**PROD, "PUBLIC_BASE_URL": "http://cedarbite.example.pk"})

    def test_production_ok(self):
        self.assertEqual(load_settings(PROD).public_base_url, "https://cedarbite.example.pk")

    def test_trailing_slash_removed(self):
        self.assertEqual(load_settings({"PUBLIC_BASE_URL": "http://x.test/"}).public_base_url, "http://x.test")


if __name__ == "__main__":
    unittest.main()
