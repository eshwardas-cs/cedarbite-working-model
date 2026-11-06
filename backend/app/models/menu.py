from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, utcnow


class MenuCategory(Base):
    __tablename__ = "menu_categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    items: Mapped[list["MenuItem"]] = relationship(back_populates="category")


class MenuItem(Base):
    __tablename__ = "menu_items"
    __table_args__ = (CheckConstraint("price_paisa >= 0", name="ck_menu_items_price_nonneg"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("menu_categories.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    image_data: Mapped[str | None] = mapped_column(Text, nullable=True)
    price_paisa: Mapped[int] = mapped_column(Integer)  # integer paisa, never float
    addon_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    addon_price_paisa: Mapped[int] = mapped_column(Integer, default=0)
    currency: Mapped[str] = mapped_column(String(3), default="PKR")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)      # archived items are inactive
    is_available: Mapped[bool] = mapped_column(Boolean, default=True)   # staff toggle (stock-out)
    quick_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    scheduled_allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    prep_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)  # configured estimate
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    category: Mapped[MenuCategory] = relationship(back_populates="items")
