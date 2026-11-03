from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, utcnow


class WalletEntry(Base):
    """Immutable wallet ledger row. Credits and debits are stored in integer paisa."""
    __tablename__ = "wallet_entries"
    __table_args__ = (
        Index("ix_wallet_entries_user_created", "user_id", "created_at"),
        UniqueConstraint("idempotency_key", name="uq_wallet_entries_idempotency_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # credit | debit
    amount_paisa: Mapped[int] = mapped_column(Integer, nullable=False)
    method: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
