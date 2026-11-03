from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select

from app.api.deps import current_user, get_db, require_csrf, require_permission
from app.auth.email_policy import student_id_from_email
from app.auth.permissions import Permission
from app.auth.roles import Role
from app.auth.service import audit
from app.models.user import User
from app.models.wallet import WalletEntry

router = APIRouter(prefix="/api/wallet", tags=["wallet"])


class CashTopUpIn(BaseModel):
    student_id: str = Field(pattern=r"^\d{7}$")
    amount_paisa: int = Field(ge=5_000, le=500_000)
    note: str = Field(default="", max_length=160)


def _balance(db, user_id: int) -> int:
    signed = case((WalletEntry.kind == "credit", WalletEntry.amount_paisa),
                  else_=-WalletEntry.amount_paisa)
    return int(db.scalar(select(func.coalesce(func.sum(signed), 0))
                         .where(WalletEntry.user_id == user_id)) or 0)


def _entry(row: WalletEntry) -> dict:
    return {"id": row.id, "kind": row.kind, "amount_paisa": row.amount_paisa,
            "method": row.method, "label": row.note or "Wallet activity",
            "created_at": row.created_at.isoformat()}


def _student_for_id(db, student_id: str) -> User | None:
    if not student_id.isdigit() or len(student_id) != 7:
        return None
    return db.scalar(select(User).where(
        User.role == Role.STUDENT,
        User.email.like(f"{student_id}@%")))


@router.get("")
def my_wallet(user: User = Depends(current_user), db=Depends(get_db)):
    if user.role not in {Role.STUDENT, Role.STAFF_CUSTOMER}:
        raise HTTPException(status_code=403, detail="A student wallet is not available for this account.")
    rows = db.scalars(select(WalletEntry).where(WalletEntry.user_id == user.id)
                      .order_by(WalletEntry.created_at.desc(), WalletEntry.id.desc()).limit(100)).all()
    return {"balance_paisa": _balance(db, user.id), "entries": [_entry(row) for row in rows]}


@router.get("/students/{student_id}")
def student_wallet(student_id: str,
                   _actor: User = Depends(require_permission(Permission.WALLET_CASH_TOPUP)),
                   db=Depends(get_db)):
    if not student_id.isdigit() or len(student_id) != 7:
        raise HTTPException(status_code=422, detail="Enter a 7-digit Cedar student ID.")
    # The ID locates an account, but staff authorization is still required.
    student = _student_for_id(db, student_id)
    if student is None or not student.is_active or student_id_from_email(student.email) != student_id:
        raise HTTPException(status_code=404, detail="No active student account matches that ID.")
    return {"student_id": student_id, "email": student.email,
            "balance_paisa": _balance(db, student.id)}


@router.post("/cash-topups", status_code=201, dependencies=[Depends(require_csrf)])
def cash_topup(body: CashTopUpIn,
               idempotency_key: str = Header(default=..., min_length=8, max_length=64),
               actor: User = Depends(require_permission(Permission.WALLET_CASH_TOPUP)),
               db=Depends(get_db)):
    student = _student_for_id(db, body.student_id)
    if student is None or not student.is_active or student_id_from_email(student.email) != body.student_id:
        raise HTTPException(status_code=404, detail="No active student account matches that ID.")

    existing = db.scalar(select(WalletEntry).where(WalletEntry.idempotency_key == idempotency_key))
    if existing is not None:
        if existing.user_id != student.id or existing.amount_paisa != body.amount_paisa:
            raise HTTPException(status_code=409, detail="This top-up reference was already used.")
        return {"student_id": body.student_id, "balance_paisa": _balance(db, student.id),
                "entry": _entry(existing), "duplicate": True}

    row = WalletEntry(user_id=student.id, actor_user_id=actor.id, kind="credit",
                      amount_paisa=body.amount_paisa, method="cash_at_counter",
                      note=body.note.strip() or "Cash received at canteen counter",
                      idempotency_key=idempotency_key)
    db.add(row)
    db.flush()
    audit(db, actor.id, "wallet.cash_topup", "wallet_entry", row.id,
          f"student_id={body.student_id}; amount_paisa={body.amount_paisa}")
    db.commit()
    db.refresh(row)
    return {"student_id": body.student_id, "balance_paisa": _balance(db, student.id),
            "entry": _entry(row), "duplicate": False}
