"""add selectable, individually stocked menu item choices

Revision ID: 8b2f4c1d9a70
Revises: c3d9047b2a16
Create Date: 2026-11-09
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "8b2f4c1d9a70"
down_revision: Union[str, None] = "c3d9047b2a16"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "menu_item_options",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("menu_item_id", sa.Integer(), sa.ForeignKey("menu_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("is_available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_menu_item_options_menu_item_id", "menu_item_options", ["menu_item_id"])


def downgrade() -> None:
    op.drop_index("ix_menu_item_options_menu_item_id", table_name="menu_item_options")
    op.drop_table("menu_item_options")
