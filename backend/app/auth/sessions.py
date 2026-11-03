"""Server-side sessions. The browser holds a random token; we store only its hash."""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.models.session import UserSession
from app.models.user import User

SESSION_TTL = timedelta(hours=12)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: Session, user: User, ttl: timedelta = SESSION_TTL) -> str:
    token = secrets.token_urlsafe(32)
    db.add(UserSession(token_hash=_hash(token), user_id=user.id, expires_at=utcnow() + ttl))
    db.commit()
    return token


def get_user_for_token(db: Session, token: str) -> User | None:
    row = db.scalar(select(UserSession).where(
        UserSession.token_hash == _hash(token), UserSession.revoked.is_(False)))
    if row is None:
        return None
    expires = row.expires_at
    if expires.tzinfo is None:          # SQLite hands back naive datetimes
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= utcnow():
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    return user


def revoke_session(db: Session, token: str) -> None:
    db.execute(update(UserSession).where(UserSession.token_hash == _hash(token)).values(revoked=True))
    db.commit()


def revoke_all_for_user(db: Session, user_id: int) -> None:
    db.execute(update(UserSession).where(UserSession.user_id == user_id).values(revoked=True))
    db.commit()


def csrf_token_for(secret: str, session_token: str) -> str:
    """Stateless CSRF token: HMAC of the session token. Sent in a header by our frontend."""
    return hmac.new(secret.encode(), session_token.encode(), hashlib.sha256).hexdigest()
