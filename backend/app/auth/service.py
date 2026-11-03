from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.email_policy import email_domain_allowed, normalize_email, student_id_from_email
from app.auth.passwords import check_password_policy, hash_password, verify_password
from app.auth.roles import Role
from app.models.audit import AuditLog
from app.models.user import User


class AuthError(Exception):
    """A rule was broken. The message is safe to show to the person."""


def audit(db: Session, actor_id: int | None, action: str, target_type: str | None = None,
          target_id: int | None = None, detail: str = "") -> None:
    db.add(AuditLog(actor_user_id=actor_id, action=action, target_type=target_type,
                    target_id=target_id, detail=detail[:500]))


def _add_user(db: Session, email: str, password: str, role: Role, verified: bool) -> User:
    user = User(email=normalize_email(email), password_hash=hash_password(password),
                role=role, email_verified=verified)
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise AuthError("That email is already registered.")
    return user


def create_user(db: Session, email: str, password: str, role: Role = Role.STUDENT,
                email_verified: bool = False) -> User:
    if role == Role.OWNER:
        raise AuthError("Owner accounts are created only by the setup command or an ownership transfer.")
    user = _add_user(db, email, password, role, email_verified)
    db.commit()
    return user


def create_owner(db: Session, email: str, password: str) -> User:
    exists = db.scalar(select(User.id).where(User.role == Role.OWNER, User.is_active.is_(True)))
    if exists is not None:
        raise AuthError("An owner already exists.")
    user = _add_user(db, email, password, Role.OWNER, True)
    audit(db, user.id, "owner.created", "user", user.id)
    db.commit()
    return user


_dummy_hash: str | None = None


def authenticate(db: Session, email: str, password: str) -> User | None:
    """Return the user, or None for ANY failure (unknown email, wrong password,
    disabled). Callers must not say which, so accounts can't be enumerated."""
    global _dummy_hash
    user = db.scalar(select(User).where(User.email == normalize_email(email)))
    if user is None:
        if _dummy_hash is None:
            _dummy_hash = hash_password("not-a-real-password")
        verify_password(password, _dummy_hash)   # spend similar time
        return None
    if not verify_password(password, user.password_hash) or not user.is_active:
        return None
    return user


def transfer_ownership(db: Session, current_owner: User, new_owner_email: str,
                       old_owner_new_role: Role) -> User:
    """Hand the OWNER role to another verified, active account, in one transaction.
    The previous owner keeps access under `old_owner_new_role` (e.g. COLLEGE_ADMIN)."""
    if current_owner.role != Role.OWNER or not current_owner.is_active:
        raise AuthError("Only the active owner can transfer ownership.")
    if old_owner_new_role == Role.OWNER:
        raise AuthError("Choose a different role for the previous owner.")
    target = db.scalar(select(User).where(User.email == normalize_email(new_owner_email)))
    if target is None or not target.is_active:
        raise AuthError("The new owner's account was not found or is disabled.")
    if target.id == current_owner.id:
        raise AuthError("The new owner must be a different account.")
    if not target.email_verified:
        raise AuthError("The new owner's email must be verified first.")
    try:
        current_owner.role = old_owner_new_role
        db.flush()                       # demote first so only one owner exists at any moment
        target.role = Role.OWNER
        db.flush()
        audit(db, current_owner.id, "ownership.transferred", "user", target.id,
              f"previous owner now: {old_owner_new_role.value}")
        db.commit()
    except Exception:
        db.rollback()
        raise
    return target


def register_student(db: Session, email: str, password: str, allowed_domain: str) -> User | None:
    """Self-registration. Returns the new (unverified) user, or None if the email
    is already registered (the caller must not reveal which)."""
    if not email_domain_allowed(email, allowed_domain):
        raise AuthError("Please register with your college email address.")
    if student_id_from_email(email) is None:
        raise AuthError("Use your 7-digit student ID followed by @cedar.edu.pk.")
    check_password_policy(password)   # raises ValueError with a friendly message
    if db.scalar(select(User.id).where(User.email == normalize_email(email))) is not None:
        return None
    try:
        return create_user(db, email, password, Role.STUDENT, email_verified=False)
    except AuthError:
        return None                    # lost a race with a duplicate; same outcome
