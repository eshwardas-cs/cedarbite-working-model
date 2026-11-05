"""store optional menu item photos

Revision ID: a1249d6b3e70
Revises: d21c4a7f0b36
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1249d6b3e70"
down_revision: Union[str, None] = "d21c4a7f0b36"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("menu_items", sa.Column("image_data", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("menu_items", "image_data")
