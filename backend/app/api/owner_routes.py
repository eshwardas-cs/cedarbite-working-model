from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.deps import get_db, require_csrf, require_permission
from app.auth.passwords import verify_password
from app.auth.permissions import Permission
from app.auth.roles import Role
from app.auth.service import AuthError, transfer_ownership
from app.models.user import User

router = APIRouter(prefix="/api/owner", tags=["owner"])

CONFIRM_PHRASE = "TRANSFER OWNERSHIP"


class TransferIn(BaseModel):
    new_owner_email: str
    old_owner_new_role: str
    password: str          # the current owner re-enters their password
    confirm: str           # must equal CONFIRM_PHRASE


@router.post("/transfer-ownership", dependencies=[Depends(require_csrf)])
def transfer(body: TransferIn, user: User = Depends(require_permission(Permission.OWNERSHIP_TRANSFER)),
             db=Depends(get_db)):
    if body.confirm != CONFIRM_PHRASE:
        raise HTTPException(status_code=400, detail=f'Type "{CONFIRM_PHRASE}" to confirm.')
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=403, detail="Password incorrect.")
    try:
        role = Role(body.old_owner_new_role)
    except ValueError:
        raise HTTPException(status_code=400, detail="Unknown role for the previous owner.")
    try:
        transfer_ownership(db, user, body.new_owner_email, role)
    except AuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ownership transferred"}
