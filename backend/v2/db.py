"""Database helpers for V2 modules (same env configuration as V1 api.py)."""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

import psycopg2
from fastapi import HTTPException


def connect():
    try:
        return psycopg2.connect(
            host=os.getenv("POSTGRES_HOST"),
            port=os.getenv("POSTGRES_PORT"),
            database=os.getenv("POSTGRES_DB"),
            user=os.getenv("POSTGRES_USER"),
            password=os.getenv("POSTGRES_PASSWORD"),
        )
    except Exception as exc:  # pragma: no cover - surfaced as API error
        raise HTTPException(status_code=500, detail=f"PostgreSQL connection failed: {exc}") from exc


@contextmanager
def transaction() -> Iterator["psycopg2.extensions.cursor"]:
    """Yield a cursor inside one transaction; commit on success, rollback on error."""
    conn = connect()
    try:
        cur = conn.cursor()
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
