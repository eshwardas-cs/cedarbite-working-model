"""Vercel entrypoint for the FastAPI service."""
from app.core.config import load_settings
from app.main import create_app

settings = load_settings()
if settings.env != "production":
    raise RuntimeError("Set CEDARBITE_ENV=production in Vercel before serving the backend.")

app = create_app(settings=settings)
