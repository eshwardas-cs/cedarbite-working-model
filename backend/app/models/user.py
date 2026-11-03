from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.auth.roles import Role  # noqa: F401  (re-exported)
from app.db.base import Base, utcnow


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # The database itself guarantees at most ONE active owner.
        Index("uq_single_active_owner", "role", unique=True,
              sqlite_where=text("role = 'owner' AND is_active = 1"),
              postgresql_where=text("role = 'owner' AND is_active")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))  # Argon2id hash, never the password
    role: Mapped[Role] = mapped_column(
        Enum(Role, native_enum=False, length=32, values_callable=lambda e: [m.value for m in e]),
        default=Role.STUDENT)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)  # disable, never delete
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
