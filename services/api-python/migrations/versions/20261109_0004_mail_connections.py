"""Add per-user encrypted mail connections (Gmail/Outlook read-only OAuth)."""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20261109_0004"
down_revision = "20261010_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mail_connections",
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("provider", sa.String(16), primary_key=True),
        sa.Column("token_ciphertext", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("mail_connections")
