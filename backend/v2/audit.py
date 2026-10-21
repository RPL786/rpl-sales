"""Audit trail helper."""
from __future__ import annotations

import json
from typing import Any, Optional


def record(cur, actor: Any, action: str, entity_type: str = "", entity_id: Any = None,
           details: Optional[dict] = None) -> None:
    """Insert an audit event using the caller's cursor (same transaction)."""
    cur.execute(
        """
        INSERT INTO audit_events (actor_user_id, actor_username, action, entity_type, entity_id, details)
        VALUES (%s, %s, %s, %s, %s, %s::jsonb)
        """,
        (
            getattr(actor, "user_id", None),
            getattr(actor, "username", None),
            action,
            entity_type,
            None if entity_id is None else str(entity_id),
            json.dumps(details or {}, default=str),
        ),
    )


def record_standalone(actor: Any, action: str, entity_type: str = "", entity_id: Any = None,
                      details: Optional[dict] = None) -> None:
    """Best-effort audit insert in its own transaction (never breaks the caller)."""
    from .db import transaction

    try:
        with transaction() as cur:
            record(cur, actor, action, entity_type, entity_id, details)
    except Exception as exc:  # pragma: no cover
        print("AUDIT WRITE FAILED:", exc, flush=True)
