"""Add revocable sessions, security events and shared auth rate limits."""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20261010_0003"
down_revision = "20261010_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_auth_sessions_user_created", "auth_sessions", ["user_id", "created_at"]
    )

    op.create_table(
        "security_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_security_events_user_created", "security_events", ["user_id", "created_at"]
    )

    op.create_table(
        "security_rate_limits",
        sa.Column("bucket_key", sa.String(64), primary_key=True),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("request_count", sa.Integer(), nullable=False),
    )
    op.create_index(
        "ix_security_rate_limits_window",
        "security_rate_limits",
        ["window_started_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_security_rate_limits_window", table_name="security_rate_limits")
    op.drop_table("security_rate_limits")
    op.drop_index("ix_security_events_user_created", table_name="security_events")
    op.drop_table("security_events")
    op.drop_index("ix_auth_sessions_user_created", table_name="auth_sessions")
    op.drop_table("auth_sessions")
