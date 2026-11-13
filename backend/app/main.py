"""CedarBite API. Run in development with:
    uvicorn app.main:create_app --factory --reload
"""
import secrets
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.auth_routes import router as auth_router
from app.api.menu_routes import router as menu_router
from app.api.order_routes import router as order_router
from app.api.owner_routes import router as owner_router
from app.api.wallet_routes import router as wallet_router
from app.auth.throttle import LoginThrottle
from app.core.config import Settings, load_settings
from app.db.base import Base, make_engine, make_session_factory
from app.notifications.email import sender_for


def create_app(settings: Settings | None = None, session_factory=None, email_sender=None) -> FastAPI:
    settings = settings or load_settings()   # raises in production if config is unsafe
    prod = settings.env == "production"

    if session_factory is None:
        from app import models as _models  # noqa: F401  (registers the tables)
        engine = make_engine(settings.database_url)
        if not prod:
            Base.metadata.create_all(engine)   # dev convenience; production uses migrations
        session_factory = make_session_factory(engine)

    app = FastAPI(
        title="CedarBite API",
        docs_url=None if prod else "/docs",
        redoc_url=None,
        openapi_url=None if prod else "/openapi.json",
    )
    app.state.settings = settings
    app.state.session_factory = session_factory
    app.state.csrf_secret = settings.session_secret or secrets.token_hex(32)
    app.state.throttle = LoginThrottle()
    # Campus Wi-Fi shares IPs, so registration limits are much looser than login limits.
    app.state.registration_throttle = LoginThrottle(max_failures=30, window_seconds=3600)
    app.state.email_sender = email_sender or sender_for(settings)
    web_root = Path(__file__).parent / "web"
    app.mount("/assets", StaticFiles(directory=web_root / "assets"), name="assets")
    app.include_router(auth_router)
    app.include_router(owner_router)
    app.include_router(menu_router)
    app.include_router(order_router)
    app.include_router(wallet_router)

    @app.get("/", include_in_schema=False)
    def website():
        return FileResponse(web_root / "index.html")

    @app.get("/verify-email", include_in_schema=False)
    def verify_email_page():
        return FileResponse(web_root / "index.html")

    @app.get("/owner", include_in_schema=False)
    @app.get("/owner/{path:path}", include_in_schema=False)
    @app.get("/stations", include_in_schema=False)
    @app.get("/counter", include_in_schema=False)
    @app.get("/cash-desk", include_in_schema=False)
    @app.get("/order-manager", include_in_schema=False)
    @app.get("/kitchen", include_in_schema=False)
    @app.get("/my-orders", include_in_schema=False)
    @app.get("/about", include_in_schema=False)
    @app.get("/privacy-policy", include_in_schema=False)
    @app.get("/contact-us", include_in_schema=False)
    def web_app(path: str = ""):
        # The canteen workspace is a separate app entry point in the shared web bundle.
        return FileResponse(web_root / "index.html")

    @app.get("/health")
    def health():
        return {"status": "ok"}   # deliberately minimal: no config, no secrets

    @app.get("/api/payments/status")
    def payments_status():
        methods = [
            {"id": "easypaisa", "label": "EasyPaisa", "type": "digital", "available": False},
            {"id": "jazzcash", "label": "JazzCash", "type": "digital", "available": False},
            {"id": "bank_transfer", "label": "Bank / Raast transfer", "type": "digital", "available": False},
            {"id": "card", "label": "Debit or credit card", "type": "digital", "available": False},
            {"id": "cash", "label": "Cash at the counter", "type": "cash", "available": False},
        ]
        if not settings.payments_configured:
            return {"configured": False, "ordering_enabled": False,
                    "message": "Payment methods are awaiting canteen approval and provider setup.",
                    "methods": methods}
        return {"configured": True, "ordering_enabled": False,
                "message": "Test provider selected; live payments are disabled.", "methods": methods}

    return app
