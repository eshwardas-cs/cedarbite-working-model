from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from app.api.deps import get_db, require_csrf, require_permission
from app.auth.permissions import Permission
from app.menu import service
from app.models.user import User

router = APIRouter(prefix="/api/menu", tags=["menu"])


def _handle(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except service.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except service.MenuError as e:
        raise HTTPException(status_code=400, detail=str(e))


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    sort_order: int = Field(default=0, ge=-1000, le=1000)


class ItemIn(BaseModel):
    category_id: int
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    price_paisa: int = Field(ge=0, le=10_000_000)
    quick_allowed: bool = False
    scheduled_allowed: bool = True
    prep_minutes: int | None = Field(default=None, ge=0, le=240)

    @model_validator(mode="after")
    def _modes(self):
        if not (self.quick_allowed or self.scheduled_allowed):
            raise ValueError("Allow at least one of quick or scheduled ordering.")
        return self


class ItemPatch(BaseModel):
    category_id: int | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    price_paisa: int | None = Field(default=None, ge=0, le=10_000_000)
    quick_allowed: bool | None = None
    scheduled_allowed: bool | None = None
    prep_minutes: int | None = Field(default=None, ge=0, le=240)


class AvailabilityIn(BaseModel):
    is_available: bool


@router.get("")
def public_menu(db=Depends(get_db)):
    """Public. Only active items; `available` reflects the server's current state."""
    return {"categories": service.list_menu(db)}


@router.get("/manage")
def manage_menu(_u: User = Depends(require_permission(Permission.MENU_MANAGE)), db=Depends(get_db)):
    return {"categories": service.list_menu(db, include_inactive=True)}


@router.post("/categories", status_code=201, dependencies=[Depends(require_csrf)])
def create_category(body: CategoryIn, user: User = Depends(require_permission(Permission.MENU_MANAGE)),
                    db=Depends(get_db)):
    cat = _handle(service.create_category, db, user, body.name, body.sort_order)
    return {"id": cat.id, "name": cat.name}


@router.post("/items", status_code=201, dependencies=[Depends(require_csrf)])
def create_item(body: ItemIn, user: User = Depends(require_permission(Permission.MENU_MANAGE)),
                db=Depends(get_db)):
    return service.item_dict(_handle(service.create_item, db, user, **body.model_dump()))


@router.patch("/items/{item_id}", dependencies=[Depends(require_csrf)])
def update_item(item_id: int, body: ItemPatch,
                user: User = Depends(require_permission(Permission.MENU_MANAGE)), db=Depends(get_db)):
    return service.item_dict(_handle(service.update_item, db, user, item_id,
                                     body.model_dump(exclude_unset=True)))


@router.patch("/items/{item_id}/availability", dependencies=[Depends(require_csrf)])
def set_availability(item_id: int, body: AvailabilityIn,
                     user: User = Depends(require_permission(Permission.AVAILABILITY_TOGGLE)),
                     db=Depends(get_db)):
    return service.item_dict(_handle(service.set_availability, db, user, item_id, body.is_available))


@router.post("/items/{item_id}/archive", dependencies=[Depends(require_csrf)])
def archive_item(item_id: int, user: User = Depends(require_permission(Permission.MENU_MANAGE)),
                 db=Depends(get_db)):
    return service.item_dict(_handle(service.archive_item, db, user, item_id))
