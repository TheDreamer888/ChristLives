"""Create persistent auth, agency and billing tables."""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20261010_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), nullable=True, unique=True),
        sa.Column("email_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("name", sa.String(200), nullable=True),
        sa.Column("linked_methods", sa.JSON(), nullable=False),
        sa.Column("webauthn_credentials", sa.JSON(), nullable=False),
        sa.Column("backup_code_hashes", sa.JSON(), nullable=False),
        sa.Column("consent", sa.JSON(), nullable=True),
    )
    op.create_index("ix_users_email", "users", ["email"])

    op.create_table(
        "agencies",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("stripe_customer_id", sa.String(255), nullable=True, unique=True),
        sa.Column("stripe_subscription_id", sa.String(255), nullable=True, unique=True),
        sa.Column("subscription_status", sa.String(32), nullable=False),
        sa.Column("plan_id", sa.String(24), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "agency_members",
        sa.Column("agency_id", sa.String(36), sa.ForeignKey("agencies.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "client_workspaces",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("agency_id", sa.String(36), sa.ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_client_workspaces_agency_id", "client_workspaces", ["agency_id"])

    op.create_table(
        "client_access",
        sa.Column("client_id", sa.String(36), sa.ForeignKey("client_workspaces.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(16), nullable=False),
    )
    op.create_table(
        "agency_invitations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("agency_id", sa.String(36), sa.ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("agency_role", sa.String(16), nullable=False),
        sa.Column("client_ids", sa.JSON(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_agency_invitations_agency_id", "agency_invitations", ["agency_id"])
    op.create_index("ix_agency_invitations_email", "agency_invitations", ["email"])

    op.create_table(
        "stripe_webhook_events",
        sa.Column("id", sa.String(255), primary_key=True),
        sa.Column("event_type", sa.String(120), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "agency_usage",
        sa.Column("agency_id", sa.String(36), sa.ForeignKey("agencies.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("period", sa.String(7), primary_key=True),
        sa.Column("ai_operations", sa.Integer(), nullable=False),
    )
    op.create_table(
        "auth_challenges",
        sa.Column("id", sa.String(128), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("challenge", sa.String(2048), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_auth_challenges_expires_at", "auth_challenges", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_auth_challenges_expires_at", table_name="auth_challenges")
    op.drop_table("auth_challenges")
    op.drop_table("agency_usage")
    op.drop_table("stripe_webhook_events")
    op.drop_index("ix_agency_invitations_email", table_name="agency_invitations")
    op.drop_index("ix_agency_invitations_agency_id", table_name="agency_invitations")
    op.drop_table("agency_invitations")
    op.drop_table("client_access")
    op.drop_index("ix_client_workspaces_agency_id", table_name="client_workspaces")
    op.drop_table("client_workspaces")
    op.drop_table("agency_members")
    op.drop_table("agencies")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
