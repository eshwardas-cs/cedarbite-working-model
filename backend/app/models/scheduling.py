from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, utcnow


class PickupWindow(Base):
    """A time slot for Scheduled Orders. Times are stored in UTC."""
    __tablename__ = "pickup_windows"
    __table_args__ = (
        CheckConstraint("capacity > 0", name="ck_windows_capacity_pos"),
        CheckConstraint("end_at > start_at", name="ck_windows_end_after_start"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    capacity: Mapped[int] = mapped_column(Integer)
    is_open: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AppSetting(Base):
    """Small key/value settings changed at runtime (e.g. ordering_paused)."""
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(200))
