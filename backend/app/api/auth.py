import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.audit.log import record
from app.auth.deps import COOKIE, current_user, get_db, require_csrf
from app.auth.passwords import DUMMY_HASH, verify_password
from app.auth.sessions import SESSION_HOURS, create_session, delete_session
from app.models.user import User

router = APIRouter(prefix="/api/auth", tags=["auth"])
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
GENERIC_FAIL = "Incorrect email or password."


class LoginBody(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError("invalid email")
        return v


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response, db=Depends(get_db)):
    settings = request.app.state.settings
    limits = request.app.state.limits
    ip = request.client.host if request.client else "unknown"

    if limits.blocked(body.email, ip):
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

    user = db.scalar(select(User).where(User.email == body.email))
    password_ok = verify_password(body.password, user.password_hash if user else DUMMY_HASH)

    if not (user and password_ok and user.is_active):
        limits.failure(body.email, ip)
        record(db, user.id if user else None, "auth.login_failed", body.email)
        db.commit()
        raise HTTPException(status_code=401, detail=GENERIC_FAIL)   # same message for every cause

    if not user.email_verified:        # password was correct, so saying this leaks nothing new
        raise HTTPException(status_code=403, detail="Please verify your email address first.")

    limits.success(body.email)
    token, csrf = create_session(db, user.id)
    record(db, user.id, "auth.login", None)
    db.commit()
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax",
                        secure=settings.env == "production",
                        max_age=SESSION_HOURS * 3600, path="/")
    return {"email": user.email, "role": user.role.value, "csrf_token": csrf}


@router.get("/me")
def me(request: Request, user: User = Depends(current_user)):
    return {"email": user.email, "role": user.role.value, "csrf_token": request.state.csrf}


@router.post("/logout")
def logout(request: Request, response: Response, user: User = Depends(require_csrf), db=Depends(get_db)):
    delete_session(db, request.cookies.get(COOKIE, ""))
    record(db, user.id, "auth.logout", None)
    db.commit()
    response.delete_cookie(COOKIE, path="/")
    return {"status": "signed out"}
