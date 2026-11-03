import hmac

from fastapi import Cookie, Depends, Header, HTTPException, Request

from app.auth.permissions import Permission, has_permission
from app.auth.sessions import csrf_token_for, get_user_for_token
from app.models.user import User

SESSION_COOKIE = "cb_session"


def get_db(request: Request):
    db = request.app.state.session_factory()
    try:
        yield db
    finally:
        db.close()


def current_user(db=Depends(get_db), cb_session: str | None = Cookie(default=None)) -> User:
    user = get_user_for_token(db, cb_session) if cb_session else None
    if user is None:
        raise HTTPException(status_code=401, detail="Not signed in.")
    return user


def require_csrf(request: Request, x_csrf_token: str | None = Header(default=None),
                 cb_session: str | None = Cookie(default=None)) -> None:
    secret = request.app.state.csrf_secret
    ok = bool(cb_session and x_csrf_token) and hmac.compare_digest(
        csrf_token_for(secret, cb_session), x_csrf_token)
    if not ok:
        raise HTTPException(status_code=403, detail="CSRF check failed.")


def require_permission(permission: Permission):
    def dep(user: User = Depends(current_user)) -> User:
        if not has_permission(user.role, permission):
            raise HTTPException(status_code=403, detail="You are not allowed to do that.")
        return user
    return dep
