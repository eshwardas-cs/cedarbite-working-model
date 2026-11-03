from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import AwareDatetime, BaseModel, Field
from sqlalchemy import select

from app.api.deps import current_user, get_db, require_csrf, require_permission
from app.auth.permissions import Permission, has_permission
from app.models.orders import Order
from app.models.user import User
from app.orders import service
from app.orders.state_machine import OrderStatus

router = APIRouter(prefix="/api", tags=["orders"])


def _handle(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except service.OrderError as e:
        raise HTTPException(status_code=e.status, detail=str(e))


def _ensure_accepting(request: Request, db) -> None:
    if not request.app.state.settings.payments_configured:
        raise HTTPException(status_code=503, detail="Checkout is not enabled. No payment has been taken.")
    if service.get_flag(db, "ordering_paused"):
        raise HTTPException(status_code=503, detail="Online ordering is paused by the canteen.")


class LineIn(BaseModel):
    item_id: int
    quantity: int


class QuoteIn(BaseModel):
    lines: list[LineIn] = Field(max_length=50)


class OrderIn(QuoteIn):
    pickup_window_id: int | None = None
    expected_total_paisa: int | None = None


class StatusIn(BaseModel):
    to: str


class PauseIn(BaseModel):
    paused: bool


class WindowIn(BaseModel):
    start_at: AwareDatetime
    end_at: AwareDatetime
    capacity: int = Field(ge=1, le=200)


def _lines(body: QuoteIn) -> list[service.Line]:
    return [service.Line(l.item_id, l.quantity) for l in body.lines]


@router.get("/ordering/status")
def ordering_status(request: Request, db=Depends(get_db)):
    if not request.app.state.settings.payments_configured:
        return {"accepting_orders": False, "reason": "Checkout is not enabled. No payment has been taken."}
    if service.get_flag(db, "ordering_paused"):
        return {"accepting_orders": False, "reason": "Online ordering is paused by the canteen."}
    return {"accepting_orders": True, "reason": None}


@router.post("/ordering/pause", dependencies=[Depends(require_csrf)])
def pause(body: PauseIn, user: User = Depends(require_permission(Permission.ORDERING_PAUSE)),
          db=Depends(get_db)):
    service.set_ordering_paused(db, user, body.paused)
    return {"paused": body.paused}


@router.get("/pickup-windows")
def windows(db=Depends(get_db)):
    return {"windows": service.list_windows(db)}


@router.post("/pickup-windows", status_code=201, dependencies=[Depends(require_csrf)])
def create_window(body: WindowIn, user: User = Depends(require_permission(Permission.WINDOWS_MANAGE)),
                  db=Depends(get_db)):
    w = _handle(service.create_window, db, user, body.start_at, body.end_at, body.capacity)
    return service.window_dict(w) | {"capacity": w.capacity}


@router.post("/orders/quote", dependencies=[Depends(require_csrf)])
def quote(body: QuoteIn, _u: User = Depends(require_permission(Permission.ORDERS_CREATE)),
          db=Depends(get_db)):
    """Prices a cart without creating anything. Always computed from current database prices."""
    return service.price_cart(db, _lines(body)).as_dict()


@router.post("/orders", dependencies=[Depends(require_csrf)])
def place_order(body: OrderIn, request: Request,
                idempotency_key: str = Header(default=..., min_length=8, max_length=64),
                user: User = Depends(require_permission(Permission.ORDERS_CREATE)), db=Depends(get_db)):
    _ensure_accepting(request, db)
    order, created = _handle(service.create_order, db, user, _lines(body), idempotency_key=idempotency_key,
                             pickup_window_id=body.pickup_window_id,
                             expected_total_paisa=body.expected_total_paisa)
    from fastapi.responses import JSONResponse
    return JSONResponse(service.order_dict(order), status_code=201 if created else 200)


@router.get("/orders")
def my_orders(user: User = Depends(require_permission(Permission.ORDERS_VIEW_OWN)), db=Depends(get_db)):
    rows = db.scalars(select(Order).where(Order.user_id == user.id)
                      .order_by(Order.created_at.desc(), Order.id.desc()).limit(50)).all()
    return {"orders": [service.order_dict(o) for o in rows]}


def _visible_order(db, user: User, order_id: int) -> Order:
    order = db.get(Order, order_id)
    allowed = order is not None and (order.user_id == user.id
                                     or has_permission(user.role, Permission.ORDERS_VIEW_ALL))
    if not allowed:
        raise HTTPException(status_code=404, detail="Order not found.")   # 404, not 403: don't confirm it exists
    return order


@router.get("/orders/{order_id}")
def get_order(order_id: int, user: User = Depends(current_user), db=Depends(get_db)):
    return service.order_dict(_visible_order(db, user, order_id))


@router.post("/orders/{order_id}/cancel", dependencies=[Depends(require_csrf)])
def cancel_own(order_id: int, user: User = Depends(require_permission(Permission.ORDERS_VIEW_OWN)),
               db=Depends(get_db)):
    order = db.get(Order, order_id)
    if order is None or order.user_id != user.id:
        raise HTTPException(status_code=404, detail="Order not found.")
    return service.order_dict(_handle(service.change_status, db, order_id, OrderStatus.CANCELLED,
                                      service.actor_name(user.role), user.id))


@router.get("/queue")
def queue(_u: User = Depends(require_permission(Permission.QUEUE_VIEW)), db=Depends(get_db)):
    return {"orders": service.queue_view(db)}


@router.post("/orders/{order_id}/status", dependencies=[Depends(require_csrf)])
def set_status(order_id: int, body: StatusIn, user: User = Depends(current_user), db=Depends(get_db)):
    try:
        target = OrderStatus(body.to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Unknown status.")
    needed = Permission.ORDERS_CANCEL if target == OrderStatus.CANCELLED else Permission.ORDERS_FULFIL
    if not has_permission(user.role, needed):
        raise HTTPException(status_code=403, detail="You are not allowed to do that.")
    order = _handle(service.change_status, db, order_id, target, service.actor_name(user.role), user.id)
    return service.order_dict(order)
