"""Keep product and customer names consistent at entry time.

When someone types a name that already exists with a different spelling
("1.5KG" vs "1.5 KG", "abc traders" vs "ABC Traders"), the existing spelling is used,
so new spelling variants (which split and double totals) are not created.
Pack sizes stay distinct: name_key keeps numbers exact (1.5 KG != 15 KG).
"""
from __future__ import annotations

from typing import Dict, Iterable, Optional

from fastapi import APIRouter, Depends, Query

from .datahealth import name_key
from .db import transaction
from .permissions import Access, get_access

router = APIRouter(prefix="/api/v2/names", tags=["v2-names"])

_TABLES = {"product": ("products", "product"), "client": ("clients", "client_name")}


def canonical_map(cur, kind: str, names: Iterable[str]) -> Dict[str, str]:
    """Map each given name to the existing spelling of the same name (or itself if new)."""
    wanted = {n: name_key(n) for n in {str(x).strip() for x in names if x and str(x).strip()}}
    if not wanted:
        return {}
    table, sales_col = _TABLES[kind]
    # names in the master list and names already used on sales lines
    cur.execute(f"SELECT name FROM {table} UNION SELECT DISTINCT {sales_col} FROM sales_entries")
    by_key: Dict[str, list] = {}
    for (existing,) in cur.fetchall():
        if existing and existing.strip():
            by_key.setdefault(name_key(existing), []).append(existing)
    cur.execute("SELECT name_key FROM data_health_ignored WHERE kind = %s", (kind,))
    ignored = {r[0] for r in cur.fetchall()}
    out: Dict[str, str] = {}
    for given, key in wanted.items():
        options = by_key.get(key) or []
        if not key or not options or (given in options and (len(options) == 1 or key in ignored)):
            # new name, already the only spelling, or an admin said these are different items
            out[given] = given
        elif len(options) == 1:
            out[given] = options[0]
        else:
            cur.execute(
                f"SELECT {sales_col}, COUNT(*) FROM sales_entries WHERE {sales_col} = ANY(%s) GROUP BY {sales_col}",
                (options,),
            )
            used = dict(cur.fetchall())
            out[given] = sorted(options, key=lambda o: (-int(used.get(o, 0)), o))[0]
    return out


def canonical(cur, kind: str, name: str) -> str:
    name = str(name or "").strip()
    return canonical_map(cur, kind, [name]).get(name, name) if name else name


def canonical_products_text(cur, text: str) -> str:
    """Visit 'product' can hold several products joined with ', '."""
    parts = [p.strip() for p in str(text or "").split(",") if p.strip()]
    if not parts:
        return str(text or "").strip()
    m = canonical_map(cur, "product", parts)
    return ", ".join(m.get(p, p) for p in parts)


def existing_other_spelling(cur, kind: str, name: str, exclude_id: Optional[int] = None) -> Optional[str]:
    """For the master lists: an existing *different* spelling of the same name, if any."""
    table, _ = _TABLES[kind]
    key = name_key(name)
    if not key:
        return None
    cur.execute(f"SELECT id, name FROM {table}")
    for row_id, existing in cur.fetchall():
        if exclude_id is not None and row_id == exclude_id:
            continue
        if existing != name and name_key(existing) == key:
            return existing
    return None


@router.get("/match")
def match_name(kind: str = Query(..., pattern="^(product|client)$"), name: str = "",
               access: Access = Depends(get_access)):
    """Tell the form which spelling will be saved for what the user typed."""
    name = (name or "").strip()
    if not name:
        return {"name": name, "saved_as": name, "is_new": False, "changed": False}
    with transaction() as cur:
        table, _ = _TABLES[kind]
        saved_as = canonical(cur, kind, name)
        cur.execute(f"SELECT 1 FROM {table} WHERE name = %s", (saved_as,))
        exists = cur.fetchone() is not None
    return {"name": name, "saved_as": saved_as, "is_new": not exists, "changed": saved_as != name}
