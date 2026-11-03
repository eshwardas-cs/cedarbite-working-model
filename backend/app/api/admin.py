import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.audit.log import record
from app.auth.deps import get_db, require_roles
from app.auth.passwords import hash_password
from app.auth.sessions import delete_user_sessions
from app.models.user import Role, User

router = APIRouter(prefix="/api/admin", tags=["admin"])
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
owner_only = require_roles(Role.OWNER)
owner_only_csrf = require_roles(Role.OWNER, csrf=True)


class CreateUserBody(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(min_length=12, max_length=256)
    # Deliberately no "owner" and no "student": owners are made only by the CLI.
    role: Literal["manager", "staff", "college_admin"]

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError("invalid email")
        return v


def _public(u: User) -> dict:
    # Never include password_hash.
    return {"id": u.id, "email": u.email, "role": u.role.value,
            "is_active": u.is_active, "email_verified": u.email_verified}


@router.get("/users")
def list_users(admin: User = Depends(owner_only), db=Depends(get_db)):
    return [_public(u) for u in db.scalars(select(User).order_by(User.id))]


@router.post("/users", status_code=201)
def create_user(body: CreateUserBody, admin: User = Depends(owner_only_csrf), db=Depends(get_db)):
    user = User(email=body.email, password_hash=hash_password(body.password),
                role=Role(body.role), email_verified=True)   # admin-provisioned
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="That email is already in use.")
    record(db, admin.id, "user.create", f"{user.email} as {user.role.value}")
    db.commit()
    return _public(user)


@router.post("/users/{user_id}/disable")
def disable_user(user_id: int, admin: User = Depends(owner_only_csrf), db=Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="No such user.")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot disable your own account.")
    user.is_active = False
    delete_user_sessions(db, user.id)          # sign them out everywhere, immediately
    record(db, admin.id, "user.disable", user.email)
    db.commit()
    return _public(user)
