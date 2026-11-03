"""Settings from environment variables. Fails safely in production."""
import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    env: str
    database_url: str
    session_secret: str
    allowed_email_domain: str
    payment_provider: str
    email_backend: str = "none"            # none | console | smtp
    public_base_url: str = "http://localhost:5173"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from_email: str = ""
    smtp_starttls: bool = True
    google_client_id: str = ""
    google_client_secret: str = ""

    @property
    def google_signin_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def payments_configured(self) -> bool:
        # A selected provider is not proof of a working, approved integration.
        # Only test-mode API tests may open this gate; development/production stay closed
        # until a real provider adapter and its server-side verification are implemented.
        return self.env == "test" and self.payment_provider not in {"", "none"}

    def safe_summary(self) -> dict:
        """Never include secrets or the database URL (it may hold a password)."""
        return {"env": self.env, "payments_configured": self.payments_configured,
                "email_domain_set": bool(self.allowed_email_domain)}


def load_settings(environ=None) -> Settings:
    e = os.environ if environ is None else environ
    env = e.get("CEDARBITE_ENV", "development")
    if env not in {"development", "test", "production"}:
        raise ConfigError(f"invalid CEDARBITE_ENV: {env!r}")
    s = Settings(
        env=env,
        database_url=e.get("DATABASE_URL", "sqlite:///./cedarbite_dev.sqlite3"),
        session_secret=e.get("SESSION_SECRET", ""),
        allowed_email_domain=e.get("ALLOWED_EMAIL_DOMAIN", "").lower().strip(),
        payment_provider=e.get("PAYMENT_PROVIDER", "none").lower().strip(),
        email_backend=e.get("EMAIL_BACKEND", "none").lower().strip(),
        public_base_url=e.get("PUBLIC_BASE_URL", "http://localhost:5173").strip().rstrip("/"),
        smtp_host=e.get("SMTP_HOST", "").strip(),
        smtp_port=int(e.get("SMTP_PORT", "587")),
        smtp_username=e.get("SMTP_USERNAME", "").strip(),
        smtp_password=e.get("SMTP_PASSWORD", ""),
        smtp_from_email=e.get("SMTP_FROM_EMAIL", "").strip(),
        smtp_starttls=e.get("SMTP_STARTTLS", "true").strip().lower() in {"1", "true", "yes", "on"},
        google_client_id=e.get("GOOGLE_CLIENT_ID", "").strip(),
        google_client_secret=e.get("GOOGLE_CLIENT_SECRET", "").strip(),
    )
    if s.email_backend not in {"none", "console", "smtp"}:
        raise ConfigError(f"invalid EMAIL_BACKEND: {s.email_backend!r}")
    if not 1 <= s.smtp_port <= 65535:
        raise ConfigError("SMTP_PORT must be between 1 and 65535")
    if bool(s.smtp_username) != bool(s.smtp_password):
        raise ConfigError("SMTP_USERNAME and SMTP_PASSWORD must be configured together")
    if s.email_backend == "smtp" and (not s.smtp_host or not s.smtp_from_email):
        raise ConfigError("SMTP_HOST and SMTP_FROM_EMAIL are required for EMAIL_BACKEND=smtp")
    if env == "production":
        problems = []
        if len(s.session_secret) < 32 or s.session_secret.startswith("change-me"):
            problems.append("SESSION_SECRET must be a long random value")
        if s.database_url.startswith("sqlite"):
            problems.append("production must use PostgreSQL, not SQLite")
        if not s.allowed_email_domain:
            problems.append("ALLOWED_EMAIL_DOMAIN is required")
        if s.email_backend == "console":
            problems.append("EMAIL_BACKEND=console is for development only")
        if s.email_backend != "smtp":
            problems.append("EMAIL_BACKEND=smtp is required for production verification emails")
        if s.email_backend == "smtp" and (not s.smtp_username or not s.smtp_password):
            problems.append("SMTP_USERNAME and SMTP_PASSWORD are required in production")
        if s.email_backend == "smtp" and not s.smtp_starttls:
            problems.append("SMTP_STARTTLS must be enabled in production")
        if not s.public_base_url.startswith("https://"):
            problems.append("PUBLIC_BASE_URL must start with https://")
        if problems:
            raise ConfigError("unsafe production config: " + "; ".join(problems))
    return s
