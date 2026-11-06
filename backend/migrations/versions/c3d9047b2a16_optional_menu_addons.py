"""add configurable optional extras to menu items

Revision ID: c3d9047b2a16
Revises: a1249d6b3e70
Create Date: 2026-11-07
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3d9047b2a16"
down_revision: Union[str, None] = "a1249d6b3e70"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("menu_items", sa.Column("addon_name", sa.String(length=80), nullable=True))
    op.add_column("menu_items", sa.Column("addon_price_paisa", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("menu_items", "addon_price_paisa")
    op.drop_column("menu_items", "addon_name")
