"""Idempotent, additive V2 schema migration.

Safe to run on every startup and on a copy of the production database:
- only CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
- no DROP, no UPDATE/DELETE of V1 data
"""
from __future__ import annotations

from .db import transaction

V2_SCHEMA_VERSION = 1

DDL = [
    """
    CREATE TABLE IF NOT EXISTS v2_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    # --- Organization hierarchy -------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS org_cities (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT UNIQUE NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS org_branches (
        id SERIAL PRIMARY KEY,
        city_id INTEGER NOT NULL REFERENCES org_cities(id),
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (city_id, name)
    )
    """,
    # V1 teams table gets an optional current branch link (NULL = not yet mapped)
    "ALTER TABLE teams ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES org_branches(id)",
    "ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE",
    # Effective-dated team -> branch history, so moving a team never rewrites the past
    """
    CREATE TABLE IF NOT EXISTS team_branch_history (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        branch_id INTEGER NOT NULL REFERENCES org_branches(id),
        start_date DATE NOT NULL,
        end_date DATE,
        changed_by TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_team_branch_history_team
    ON team_branch_history (team_id, start_date, end_date)
    """,
    # --- Scoped permissions -----------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS user_scopes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('org', 'city', 'branch', 'team')),
        scope_id INTEGER,
        granted_by TEXT,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK ((scope_type = 'org' AND scope_id IS NULL) OR (scope_type <> 'org' AND scope_id IS NOT NULL))
    )
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS uq_user_scopes
    ON user_scopes (user_id, scope_type, COALESCE(scope_id, 0))
    """,
    # --- Preferences --------------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS user_preferences (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        theme TEXT NOT NULL DEFAULT 'night' CHECK (theme IN ('night', 'day')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS accent TEXT NOT NULL DEFAULT 'orange'",
    # --- Audit ---------------------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS audit_events (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor_user_id INTEGER,
        actor_username TEXT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        details JSONB
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events (occurred_at DESC)",
]


def ensure_v2_schema() -> None:
    with transaction() as cur:
        for stmt in DDL:
            cur.execute(stmt)
        cur.execute(
            "INSERT INTO v2_schema_migrations (version) VALUES (%s) ON CONFLICT DO NOTHING",
            (V2_SCHEMA_VERSION,),
        )
