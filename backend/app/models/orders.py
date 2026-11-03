from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, utcnow
from app.models.scheduling import PickupWindow
from app.orders.state_machine import OrderStatus
from app.scheduling.modes import Mode


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (CheckConstraint("total_paisa >= 0", name="ck_orders_total_nonneg"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[OrderStatus] = mapped_column(
        Enum(OrderStatus, native_enum=False, length=32), default=OrderStatus.AWAITING_PAYMENT, index=True)
    mode: Mapped[Mode] = mapped_column(Enum(Mode, native_enum=False, length=16))
    total_paisa: Mapped[int] = mapped_column(Integer)  # computed server-side from DB prices
    currency: Mapped[str] = mapped_column(String(3), default="PKR")
    pickup_window_id: Mapped[int | None] = mapped_column(ForeignKey("pickup_windows.id"), nullable=True, index=True)
    pickup_code: Mapped[str] = mapped_column(String(8), unique=True)  # what the student shows at the counter
    idempotency_key: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    items: Mapped[list["OrderItem"]] = relationship(back_populates="order")
    pickup_window: Mapped[PickupWindow | None] = relationship()


class OrderItem(Base):
    __tablename__ = "order_items"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_order_items_qty_pos"),
        CheckConstraint("unit_price_paisa >= 0", name="ck_order_items_price_nonneg"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_items.id"))
    name_snapshot: Mapped[str] = mapped_column(String(120))     # what the student actually bought
    unit_price_paisa: Mapped[int] = mapped_column(Integer)      # price at order time
    quantity: Mapped[int] = mapped_column(Integer)
    order: Mapped[Order] = relationship(back_populates="items")


class OrderStatusHistory(Base):
    """Append-only log of every status change (also feeds fulfilment-time analytics)."""
    __tablename__ = "order_status_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    from_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    to_status: Mapped[str] = mapped_column(String(32))
    actor_role: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
