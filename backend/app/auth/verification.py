import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.models.email_token import EmailToken
from app.models.user import User

VERIFY_EMAIL = "verify_email"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_email_token(db: Session, user: User, purpose: str = VERIFY_EMAIL,
                      ttl: timedelta = timedelta(hours=24)) -> str:
    token = secrets.token_urlsafe(32)
    db.add(EmailToken(user_id=user.id, purpose=purpose, token_hash=_hash(token),
                      expires_at=utcnow() + ttl))
    db.commit()
    return token


def consume_email_token(db: Session, token: str, purpose: str = VERIFY_EMAIL) -> User | None:
    """Single use. Returns the user on success, None for unknown/used/expired tokens."""
    row = db.scalar(select(EmailToken).where(
        EmailToken.token_hash == _hash(token), EmailToken.purpose == purpose,
        EmailToken.used.is_(False)))
    if row is None:
        return None
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= utcnow():
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    row.used = True
    if purpose == VERIFY_EMAIL:
        user.email_verified = True
    db.commit()
    return user
