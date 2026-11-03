import secrets

from fastapi import Depends, HTTPException, Request

from app.auth.sessions import get_session
from app.models.user import User

COOKIE = "cedarbite_session"


def get_db(request: Request):
    db = request.app.state.session_factory()
    try:
        yield db
    finally:
        db.close()


def current_user(request: Request, db=Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not signed in.")
    session = get_session(db, token)
    if session is None:
        raise HTTPException(status_code=401, detail="Session expired. Please sign in again.")
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Not signed in.")
    request.state.csrf = session.csrf_token
    return user


def require_csrf(request: Request, user: User = Depends(current_user)) -> User:
    """State-changing requests must echo the CSRF token in the X-CSRF-Token header."""
    sent = request.headers.get("X-CSRF-Token", "").encode()
    if not secrets.compare_digest(sent, request.state.csrf.encode()):
        raise HTTPException(status_code=403, detail="Missing or invalid CSRF token.")
    return user


def require_roles(*roles, csrf: bool = False):
    """Server-side role check. Hiding buttons in the UI is never the real control."""
    base = require_csrf if csrf else current_user

    def checker(user: User = Depends(base)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="You do not have permission to do that.")
        return user
    return checker
