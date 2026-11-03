"""add append-only student wallet ledger

Revision ID: d21c4a7f0b36
Revises: b673001e6483
Create Date: 2026-11-03
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d21c4a7f0b36"
down_revision: Union[str, None] = "b673001e6483"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "wallet_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("actor_user_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("amount_paisa", sa.Integer(), nullable=False),
        sa.Column("method", sa.String(length=32), nullable=False),
        sa.Column("note", sa.String(length=160), nullable=False),
        sa.Column("idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('credit', 'debit')", name="ck_wallet_entries_kind"),
        sa.CheckConstraint("amount_paisa > 0", name="ck_wallet_entries_amount_positive"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key", name="uq_wallet_entries_idempotency_key"),
    )
    op.create_index("ix_wallet_entries_user_id", "wallet_entries", ["user_id"], unique=False)
    op.create_index("ix_wallet_entries_user_created", "wallet_entries", ["user_id", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_wallet_entries_user_created", table_name="wallet_entries")
    op.drop_index("ix_wallet_entries_user_id", table_name="wallet_entries")
    op.drop_table("wallet_entries")
