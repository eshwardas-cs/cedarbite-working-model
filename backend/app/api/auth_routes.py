import secrets
from hmac import compare_digest
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from fastapi.responses import RedirectResponse

from app.api.deps import SESSION_COOKIE, current_user, get_db, require_csrf
from app.auth.email_policy import normalize_email, student_id_from_email
from app.auth.permissions import ROLE_PERMISSIONS
from app.auth.roles import Role
from app.auth.service import AuthError, authenticate, create_user, register_student
from app.auth.verification import consume_email_token, issue_email_token
from app.auth.sessions import SESSION_TTL, create_session, csrf_token_for, revoke_session
from app.models.user import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


class RegisterIn(BaseModel):
    email: str
    password: str


class VerifyIn(BaseModel):
    token: str


GOOGLE_STATE_COOKIE = "cb_google_state"
GOOGLE_NONCE_COOKIE = "cb_google_nonce"
GOOGLE_NEXT_COOKIE = "cb_google_next"
GOOGLE_COOKIE_PATH = "/api/auth/google"


@router.post("/register", status_code=202)
def register(body: RegisterIn, request: Request, db=Depends(get_db)):
    """Always answers the same way for valid requests, so it can't be used to
    discover which emails are registered."""
    state = request.app.state
    key = f"register|{request.client.host if request.client else 'unknown'}"
    if state.registration_throttle.blocked(key):
        raise HTTPException(status_code=429, detail="Too many attempts. Please try again later.")
    state.registration_throttle.record_failure(key)   # counts every attempt
    try:
        user = register_student(db, body.email, body.password, state.settings.allowed_email_domain)
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if user is not None:
        token = issue_email_token(db, user)
        link = f"{state.settings.public_base_url}/verify-email?token={token}"
        state.email_sender.send(user.email, "Verify your CedarBite account",
                                f"Open this link to verify your email (valid 24 hours):\n{link}")
    return {"message": "If this email can be registered, a verification link has been sent. "
                       "If nothing arrives, contact the canteen.",
            "email_delivery_configured": state.settings.email_backend != "none"}


@router.post("/verify-email")
def verify_email(body: VerifyIn, db=Depends(get_db)):
    if consume_email_token(db, body.token) is None:
        raise HTTPException(status_code=400, detail="This link is invalid or has expired.")
    return {"status": "email verified"}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db=Depends(get_db)):
    throttle = request.app.state.throttle
    key = f"{normalize_email(body.email)}|{request.client.host if request.client else 'unknown'}"
    if throttle.blocked(key):
        raise HTTPException(status_code=429, detail="Too many attempts. Please try again later.")
    user = authenticate(db, body.email, body.password)
    if user is None:
        throttle.record_failure(key)
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    throttle.reset(key)
    token = create_session(db, user)
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", path="/",
                        secure=request.app.state.settings.env == "production",
                        max_age=int(SESSION_TTL.total_seconds()))
    return {"email": user.email, "role": user.role.value,
            "csrf_token": csrf_token_for(request.app.state.csrf_secret, token)}


@router.get("/me")
def me(request: Request, user: User = Depends(current_user),
       cb_session: str | None = Cookie(default=None)):
    return {"email": user.email, "role": user.role.value, "email_verified": user.email_verified,
            "student_id": student_id_from_email(user.email) if user.role.value == "student" else None,
            "permissions": sorted(p.value for p in ROLE_PERMISSIONS[user.role]),
            "csrf_token": csrf_token_for(request.app.state.csrf_secret, cb_session)}


@router.post("/logout", dependencies=[Depends(require_csrf)])
def logout(response: Response, db=Depends(get_db), cb_session: str | None = Cookie(default=None),
           _user: User = Depends(current_user)):
    if cb_session:
        revoke_session(db, cb_session)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"status": "signed out"}


@router.get("/google/status")
def google_status(request: Request):
    return {"configured": request.app.state.settings.google_signin_configured}


@router.get("/google/start")
def google_start(request: Request, next: str = "/owner"):
    """Start a minimal-scope Google OpenID Connect sign-in for Cedar accounts."""
    settings = request.app.state.settings
    if not settings.google_signin_configured:
        raise HTTPException(status_code=503, detail="Cedar Google sign-in has not been configured yet.")
    if next not in {"/owner", "/"}:
        next = "/owner"
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    redirect_uri = f"{settings.public_base_url}/api/auth/google/callback"
    query = urlencode({
        "client_id": settings.google_client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "nonce": nonce,
        "hd": settings.allowed_email_domain,
        "prompt": "select_account",
    })
    response = RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{query}", status_code=302)
    secure = settings.env == "production"
    response.set_cookie(GOOGLE_STATE_COOKIE, state, httponly=True, secure=secure,
                        samesite="lax", path=GOOGLE_COOKIE_PATH, max_age=600)
    response.set_cookie(GOOGLE_NONCE_COOKIE, nonce, httponly=True, secure=secure,
                        samesite="lax", path=GOOGLE_COOKIE_PATH, max_age=600)
    response.set_cookie(GOOGLE_NEXT_COOKIE, next, httponly=True, secure=secure,
                        samesite="lax", path=GOOGLE_COOKIE_PATH, max_age=600)
    return response


@router.get("/google/callback")
def google_callback(request: Request, response: Response, code: str | None = None,
                    state: str | None = None, error: str | None = None,
                    state_cookie: str | None = Cookie(default=None, alias=GOOGLE_STATE_COOKIE),
                    nonce_cookie: str | None = Cookie(default=None, alias=GOOGLE_NONCE_COOKIE),
                    next_cookie: str | None = Cookie(default="/owner", alias=GOOGLE_NEXT_COOKIE),
                    db=Depends(get_db)):
    """Validate Google's signed identity assertion before creating an app session."""
    settings = request.app.state.settings
    if error or not code or not state or not state_cookie or not nonce_cookie or not compare_digest(state, state_cookie):
        return RedirectResponse("/owner?signin_error=Cedar%20Google%20sign-in%20was%20cancelled%20or%20could%20not%20be%20verified.", status_code=303)
    redirect_uri = f"{settings.public_base_url}/api/auth/google/callback"
    try:
        token_response = httpx.post("https://oauth2.googleapis.com/token", data={
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }, timeout=12.0)
        token_response.raise_for_status()
        token = token_response.json().get("id_token")
        if not token:
            raise ValueError("Missing Google identity token")
        from google.auth.transport.requests import Request as GoogleRequest
        from google.oauth2 import id_token
        identity = id_token.verify_oauth2_token(token, GoogleRequest(), settings.google_client_id)
        if not compare_digest(str(identity.get("nonce", "")), nonce_cookie):
            raise ValueError("Google sign-in nonce mismatch")
        email = normalize_email(str(identity.get("email", "")))
        domain = settings.allowed_email_domain
        # Google recommends checking the signed `hd` claim for Workspace membership;
        # an email suffix by itself is not sufficient proof of a Cedar-managed account.
        if identity.get("hd", "").lower() != domain or identity.get("email_verified") is not True:
            raise ValueError("Not a verified Cedar Workspace account")
    except Exception:
        return RedirectResponse("/owner?signin_error=Use%20a%20verified%20Cedar%20Google%20account%20to%20sign%20in.", status_code=303)

    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        if student_id_from_email(email) is None:
            return RedirectResponse("/owner?signin_error=This%20Cedar%20account%20needs%20a%20staff%20profile%20before%20first%20sign-in.", status_code=303)
        try:
            # Google has verified the Cedar Workspace account. New student accounts
            # receive no reusable password and remain students unless an owner assigns a role.
            user = create_user(db, email, secrets.token_urlsafe(48), Role.STUDENT, email_verified=True)
        except (AuthError, ValueError):
            return RedirectResponse("/owner?signin_error=This%20Cedar%20account%20could%20not%20be%20created.", status_code=303)
    if not user.is_active:
        return RedirectResponse("/owner?signin_error=This%20Cedar%20account%20is%20disabled.", status_code=303)
    if not user.email_verified:
        user.email_verified = True
        db.commit()

    token = create_session(db, user)
    destination = next_cookie if next_cookie in {"/", "/owner"} else "/owner"
    result = RedirectResponse(destination, status_code=303)
    result.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", path="/",
                      secure=settings.env == "production", max_age=int(SESSION_TTL.total_seconds()))
    result.delete_cookie(GOOGLE_STATE_COOKIE, path=GOOGLE_COOKIE_PATH)
    result.delete_cookie(GOOGLE_NONCE_COOKIE, path=GOOGLE_COOKIE_PATH)
    result.delete_cookie(GOOGLE_NEXT_COOKIE, path=GOOGLE_COOKIE_PATH)
    return result
