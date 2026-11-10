"""Carts, pricing, order creation, pickup windows, status changes.
Every price and rule is evaluated here on the server; the browser is never trusted."""
import hashlib
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.roles import Role
from app.auth.email_policy import student_id_from_email
from app.auth.service import audit
from app.core.money import format_pkr
from app.db.base import utcnow
from app.models.menu import MenuItem
from app.models.orders import Order, OrderItem, OrderStatusHistory
from app.models.scheduling import AppSetting, PickupWindow
from app.models.user import User
from app.orders.state_machine import InvalidTransition, OrderStatus as S, check_transition
from app.scheduling.modes import ItemRules, Mode, NoValidMode, resolve_order_mode

MAX_LINES = 20
MAX_QTY_PER_LINE = 10
MAX_TOTAL_QTY = 30
RESERVATION_MINUTES = 15     # an unpaid order holds a pickup slot this long
MIN_LEAD_MINUTES = 5         # minimum notice for any scheduled order
MAX_WINDOW_HOURS = 4
QUEUE_STATUSES = (S.SUBMITTED, S.ACCEPTED, S.PREPARING, S.READY)
SLOT_STATUSES = (S.SUBMITTED, S.ACCEPTED, S.PREPARING, S.READY, S.COLLECTED)
HOLDING_STATUSES = (S.AWAITING_PAYMENT, S.PAYMENT_PENDING)
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O/1/I/L


class OrderError(Exception):
    """Safe to show to the person."""
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass
class Line:
    item_id: int
    quantity: int
    addon_selected: bool = False
    option_id: str | None = None


@dataclass
class QuoteLine:
    item_id: int
    name: str
    unit_price_paisa: int
    quantity: int
    line_total_paisa: int
    option_id: str | None = None


@dataclass
class Quote:
    mode: Mode | None = None
    lines: list[QuoteLine] = field(default_factory=list)
    subtotal_paisa: int = 0
    fees_paisa: int = 0
    total_paisa: int = 0
    max_prep_minutes: int = 0
    problems: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"mode": self.mode.value if self.mode else None,
                "lines": [l.__dict__ for l in self.lines],
                "subtotal_paisa": self.subtotal_paisa, "fees_paisa": self.fees_paisa,
                "total_paisa": self.total_paisa, "total_display": format_pkr(self.total_paisa),
                "problems": self.problems}


def aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)   # SQLite returns naive UTC


# ---------------- settings flags ----------------
def get_flag(db: Session, key: str) -> bool:
    row = db.get(AppSetting, key)
    return row is not None and row.value == "1"


def set_flag(db: Session, key: str, value: bool) -> None:
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value="1" if value else "0"))
    else:
        row.value = "1" if value else "0"


def set_ordering_paused(db: Session, actor: User, paused: bool) -> None:
    set_flag(db, "ordering_paused", paused)
    audit(db, actor.id, "ordering.paused" if paused else "ordering.resumed")
    db.commit()


# ---------------- pickup windows ----------------
def create_window(db: Session, actor: User, start_at: datetime, end_at: datetime, capacity: int,
                  now: datetime | None = None) -> PickupWindow:
    now = now or utcnow()
    start, end = start_at.astimezone(timezone.utc), end_at.astimezone(timezone.utc)
    if end <= start:
        raise OrderError("The end time must be after the start time.")
    if start <= now:
        raise OrderError("The pickup window must start in the future.")
    if end - start > timedelta(hours=MAX_WINDOW_HOURS):
        raise OrderError(f"A pickup window can be at most {MAX_WINDOW_HOURS} hours long.")
    if not 1 <= capacity <= 200:
        raise OrderError("Capacity must be between 1 and 200 orders.")
    w = PickupWindow(start_at=start, end_at=end, capacity=capacity)
    db.add(w)
    db.flush()
    audit(db, actor.id, "window.created", "pickup_window", w.id, f"capacity={capacity}")
    db.commit()
    return w


def window_load(db: Session, window_id: int, now: datetime) -> int:
    """Orders using this slot: paid ones, plus unpaid ones younger than the reservation time."""
    cutoff = now - timedelta(minutes=RESERVATION_MINUTES)
    return db.scalar(select(func.count(Order.id)).where(
        Order.pickup_window_id == window_id,
        or_(Order.status.in_(SLOT_STATUSES),
            and_(Order.status.in_(HOLDING_STATUSES), Order.created_at > cutoff)))) or 0


def list_windows(db: Session, now: datetime | None = None) -> list[dict]:
    now = now or utcnow()
    rows = db.scalars(select(PickupWindow).where(PickupWindow.is_open.is_(True),
                      PickupWindow.start_at > now).order_by(PickupWindow.start_at).limit(50)).all()
    out = []
    for w in rows:
        load = window_load(db, w.id, now)
        out.append({"id": w.id, "start_at": aware(w.start_at).isoformat(), "end_at": aware(w.end_at).isoformat(),
                    "capacity": w.capacity, "remaining": max(w.capacity - load, 0)})
    return out


# ---------------- pricing ----------------
def price_cart(db: Session, lines: list[Line]) -> Quote:
    q = Quote()
    problems: list[str] = []
    if not lines:
        problems.append("Your cart is empty.")
    if len(lines) > MAX_LINES:
        problems.append(f"A single order can have at most {MAX_LINES} different items.")
    keys = [(l.item_id, l.addon_selected, l.option_id) for l in lines]
    if len(set(keys)) != len(keys):
        problems.append("Each menu item choice can appear only once; change its quantity instead.")
    ids = [l.item_id for l in lines]
    items = {i.id: i for i in db.scalars(select(MenuItem).where(MenuItem.id.in_(ids)))} if ids else {}
    used: list[MenuItem] = []
    total_qty = 0
    for l in lines:
        if not 1 <= l.quantity <= MAX_QTY_PER_LINE:
            problems.append(f"Quantity must be between 1 and {MAX_QTY_PER_LINE} for each item.")
            continue
        item = items.get(l.item_id)
        if item is None or not item.is_active:
            problems.append("An item in your cart is no longer on the menu.")
            continue
        if not item.is_available:
            problems.append(f"{item.name} is currently unavailable.")
            continue
        total_qty += l.quantity
        used.append(item)
        if l.addon_selected and not item.addon_name:
            problems.append(f"{item.name} no longer has that add-on available.")
            continue
        option = None
        if item.options:
            option = next((choice for choice in item.options if choice.id == l.option_id), None)
            if option is None:
                problems.append(f"Choose an option for {item.name}.")
                continue
            if not option.is_available:
                problems.append(f"{option.name} is out of stock.")
                continue
        elif l.option_id is not None:
            problems.append(f"That option is no longer available for {item.name}.")
            continue
        unit_price = item.price_paisa + (item.addon_price_paisa if l.addon_selected else 0)
        line_name = item.name
        if option is not None:
            line_name = f"{line_name} · {option.name}"
        if l.addon_selected:
            line_name = f"{line_name} + {item.addon_name}"
        line_total = unit_price * l.quantity
        q.lines.append(QuoteLine(item.id, line_name, unit_price, l.quantity, line_total, option.id if option else None))
        q.subtotal_paisa += line_total
    if total_qty > MAX_TOTAL_QTY:
        problems.append(f"A single order can have at most {MAX_TOTAL_QTY} items in total.")
    if used and not problems:
        try:
            q.mode = resolve_order_mode([ItemRules(i.quick_allowed, i.scheduled_allowed) for i in used])
        except NoValidMode:
            problems.append("These items can't be ordered together. Please place separate orders "
                            "for quick items and made-to-order items.")
    q.max_prep_minutes = max((i.prep_minutes or 0 for i in used), default=0)
    q.total_paisa = q.subtotal_paisa + q.fees_paisa
    q.problems = list(dict.fromkeys(problems))
    return q


# ---------------- order creation ----------------
def _code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))


def _key_hash(user_id: int, key: str) -> str:
    return hashlib.sha256(f"{user_id}:{key}".encode()).hexdigest()


def _lock_and_check_window(db: Session, window_id: int, quote: Quote, now: datetime) -> PickupWindow:
    w = db.scalar(select(PickupWindow).where(PickupWindow.id == window_id).with_for_update())
    if w is None or not w.is_open:
        raise OrderError("That pickup time is not available.")
    lead = timedelta(minutes=max(quote.max_prep_minutes, MIN_LEAD_MINUTES))
    if aware(w.start_at) - lead < now:
        raise OrderError("That pickup time is too soon for these items. Please choose a later time.")
    if window_load(db, w.id, now) >= w.capacity:
        raise OrderError("That pickup time is full. Please choose another.", 409)
    return w


def _create_once(db, user, lines, pickup_window_id, expected_total_paisa, key_hash, now) -> Order:
    quote = price_cart(db, lines)
    if quote.problems:
        raise OrderError(quote.problems[0], 409)
    if expected_total_paisa is not None and expected_total_paisa != quote.total_paisa:
        raise OrderError(f"Prices have changed. The new total is {format_pkr(quote.total_paisa)}. "
                         "Please review your cart.", 409)
    window = None
    if quote.mode == Mode.QUICK:
        if pickup_window_id is not None:
            raise OrderError("Quick orders don't need a pickup time.")
    else:
        if pickup_window_id is None:
            raise OrderError("Please choose a pickup time for these items.")
        window = _lock_and_check_window(db, pickup_window_id, quote, now)
    order = Order(user_id=user.id, mode=quote.mode, total_paisa=quote.total_paisa, currency="PKR",
                  pickup_window_id=window.id if window else None, pickup_code=_code(),
                  idempotency_key=key_hash, status=S.AWAITING_PAYMENT)
    for l in quote.lines:
        order.items.append(OrderItem(menu_item_id=l.item_id, name_snapshot=l.name,
                                     unit_price_paisa=l.unit_price_paisa, quantity=l.quantity))
    db.add(order)
    db.flush()
    db.add(OrderStatusHistory(order_id=order.id, from_status=None, to_status=S.AWAITING_PAYMENT.value,
                              actor_role="student"))
    db.commit()
    return order


def create_order(db: Session, user: User, lines: list[Line], *, idempotency_key: str,
                 pickup_window_id: int | None = None, expected_total_paisa: int | None = None,
                 now: datetime | None = None) -> tuple[Order, bool]:
    """Returns (order, created). Repeating the same idempotency key returns the
    original order instead of creating a second one."""
    now = now or utcnow()
    if not user.is_active:
        raise OrderError("This account is disabled.", 403)
    if not user.email_verified:
        raise OrderError("Please verify your email before ordering.", 403)
    key_hash = _key_hash(user.id, idempotency_key)
    for _ in range(3):
        existing = db.scalar(select(Order).where(Order.idempotency_key == key_hash))
        if existing is not None:
            return existing, False
        try:
            return _create_once(db, user, lines, pickup_window_id, expected_total_paisa, key_hash, now), True
        except IntegrityError:
            db.rollback()          # duplicate key or code collision; look again and retry
        except OrderError:
            db.rollback()
            raise
    raise OrderError("We couldn't place the order. Please try again.", 503)


# ---------------- status changes ----------------
_ACTOR = {Role.STUDENT: "student", Role.STAFF_CUSTOMER: "student", Role.STAFF: "staff",
          Role.MANAGER: "manager", Role.OWNER: "owner"}


def actor_name(role: Role) -> str:
    return _ACTOR.get(role, role.value)


def change_status(db: Session, order_id: int, target: S, actor: str, actor_user_id: int | None = None) -> Order:
    """Move an order along the state machine. The UPDATE only succeeds if the order is
    still in the state we checked, so two people clicking at once cannot both win."""
    order = db.get(Order, order_id)
    if order is None:
        raise OrderError("Order not found.", 404)
    current = order.status
    try:
        check_transition(current, target, actor)
    except InvalidTransition:
        raise OrderError("That change isn't allowed for this order right now.", 409)
    result = db.execute(update(Order).where(Order.id == order_id, Order.status == current)
                        .values(status=target, updated_at=utcnow()))
    if result.rowcount != 1:
        db.rollback()
        raise OrderError("This order was just changed by someone else. Please refresh.", 409)
    db.add(OrderStatusHistory(order_id=order_id, from_status=current.value, to_status=target.value,
                              actor_role=actor))
    if target == S.CANCELLED:
        audit(db, actor_user_id, "order.cancelled", "order", order_id, f"by {actor}")
    db.commit()
    db.refresh(order)
    return order


# ---------------- views ----------------
def window_dict(w: PickupWindow | None) -> dict | None:
    if w is None:
        return None
    return {"id": w.id, "start_at": aware(w.start_at).isoformat(), "end_at": aware(w.end_at).isoformat()}


def order_dict(o: Order) -> dict:
    return {"id": o.id, "status": o.status.value, "mode": o.mode.value, "total_paisa": o.total_paisa,
            "total_display": format_pkr(o.total_paisa), "currency": o.currency,
            "pickup_code": o.pickup_code, "created_at": aware(o.created_at).isoformat(),
            "pickup_window": window_dict(o.pickup_window),
            "items": [{"name": i.name_snapshot, "quantity": i.quantity,
                       "unit_price_paisa": i.unit_price_paisa} for i in o.items]}


def queue_view(db: Session, now: datetime | None = None) -> list[dict]:
    """Counter view with a Cedar student ID only when the order has a valid one."""
    now = now or utcnow()
    rows = db.scalars(select(Order).where(Order.status.in_(QUEUE_STATUSES))
                      .order_by(Order.created_at, Order.id)).all()
    users = db.scalars(select(User).where(User.id.in_({order.user_id for order in rows}))).all() if rows else []
    student_ids = {user.id: student_id_from_email(user.email) for user in users}
    result = []
    for order in rows:
        queue_order = {"id": order.id, "pickup_code": order.pickup_code, "status": order.status.value,
                       "mode": order.mode.value, "created_at": aware(order.created_at).isoformat(),
                       "waiting_minutes": int((now - aware(order.created_at)).total_seconds() // 60),
                       "pickup_window": window_dict(order.pickup_window),
                       "items": [{"name": item.name_snapshot, "quantity": item.quantity} for item in order.items]}
        student_id = student_ids.get(order.user_id)
        if student_id:
            queue_order["student_id"] = student_id
        result.append(queue_order)
    return result
