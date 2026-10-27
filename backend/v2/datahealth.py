"""Data Health: find and fix data problems that make reports wrong.

- Name variants: the same product / customer written in different ways
  ("WATER GUARD 491 16 KG" vs "Water Guard 491 16kg"). They split totals, and
  duplicate rows in the product list used to double report figures.
- Exact duplicate sales lines: the same line imported twice (e.g. an Excel file
  uploaded with "Add" two times).

Read endpoints need MANAGE_ORG; fixes need SYSTEM_ADMIN and are audited.
"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Dict, List, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import audit
from .db import transaction
from .permissions import MANAGE_ORG, SYSTEM_ADMIN, Access, require_cap

router = APIRouter(prefix="/api/v2/data-health", tags=["v2-data-health"])


def name_key(value: str) -> str:
    """Letters and digits only, lower case: '16 KG', '16kg' and '16-Kg' all match."""
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _variants(rows) -> List[Dict]:
    groups: Dict[str, Dict[str, Dict]] = defaultdict(dict)
    for name, lines, qty in rows:
        if not name or not str(name).strip():
            continue
        k = name_key(name)
        if not k:
            continue
        item = groups[k].setdefault(str(name), {"name": str(name), "lines": 0, "qty": 0.0})
        item["lines"] += int(lines or 0)
        item["qty"] += float(qty or 0)
    out = []
    for k, names in groups.items():
        if len(names) < 2:
            continue
        spellings = sorted(names.values(), key=lambda x: (-x["lines"], x["name"]))
        for s in spellings:
            s["qty"] = round(s["qty"], 2)
        out.append({"key": k, "suggested": spellings[0]["name"], "spellings": spellings,
                    "total_lines": sum(s["lines"] for s in spellings)})
    out.sort(key=lambda g: -g["total_lines"])
    return out


@router.get("")
def data_health(access: Access = Depends(require_cap(MANAGE_ORG))):
    with transaction() as cur:
        # product spellings from sales and from the product list (list-only rows count 0 lines)
        cur.execute(
            """
            SELECT name, SUM(lines), SUM(qty) FROM (
                SELECT product AS name, COUNT(*) AS lines, SUM(COALESCE(quantity, 0)) AS qty
                FROM sales_entries GROUP BY product
                UNION ALL
                SELECT name, 0, 0 FROM products
            ) x GROUP BY name
            """
        )
        product_groups = _variants(cur.fetchall())

        cur.execute(
            """
            SELECT name, SUM(lines), SUM(qty) FROM (
                SELECT client_name AS name, COUNT(*) AS lines, SUM(COALESCE(quantity, 0)) AS qty
                FROM sales_entries GROUP BY client_name
                UNION ALL
                SELECT client_name, COUNT(*), 0 FROM visit_entries GROUP BY client_name
            ) x GROUP BY name
            """
        )
        client_groups = _variants(cur.fetchall())

        cur.execute(
            """
            SELECT team, sales_person, client_name, product, entry_date, quantity, amount,
                   COUNT(*) AS copies, MIN(id)
            FROM sales_entries
            GROUP BY team, sales_person, client_name, product, entry_date, quantity, amount
            HAVING COUNT(*) > 1
            ORDER BY COUNT(*) DESC, entry_date DESC
            """
        )
        dups = cur.fetchall()

    extra_lines = sum(int(r[7]) - 1 for r in dups)
    extra_qty = sum((int(r[7]) - 1) * float(r[5] or 0) for r in dups)
    return {
        "products": {"groups": product_groups[:100], "count": len(product_groups)},
        "clients": {"groups": client_groups[:100], "count": len(client_groups)},
        "duplicate_lines": {
            "groups": len(dups),
            "extra_lines": extra_lines,
            "extra_qty": round(extra_qty, 2),
            "sample": [
                {"team": r[0], "sales_person": r[1], "client_name": r[2], "product": r[3], "entry_date": r[4],
                 "quantity": float(r[5] or 0), "amount": float(r[6] or 0), "copies": int(r[7])}
                for r in dups[:100]
            ],
        },
    }


class MergeIn(BaseModel):
    kind: Literal["product", "client"]
    canonical: str
    variants: List[str] = Field(default_factory=list)


@router.post("/merge")
def merge_names(payload: MergeIn, access: Access = Depends(require_cap(SYSTEM_ADMIN))):
    canonical = re.sub(r"\s+", " ", payload.canonical or "").strip()
    variants = sorted({v for v in payload.variants if v is not None and v != canonical})
    if not canonical or not variants:
        raise HTTPException(status_code=400, detail="Choose the correct name and at least one other spelling")
    if any(name_key(v) != name_key(canonical) for v in variants):
        raise HTTPException(status_code=400, detail="Only spellings of the same name can be merged")

    with transaction() as cur:
        if payload.kind == "product":
            cur.execute("UPDATE sales_entries SET product = %s WHERE product = ANY(%s)", (canonical, variants))
            sales = cur.rowcount
            cur.execute("UPDATE visit_entries SET product = %s WHERE product = ANY(%s)", (canonical, variants))
            visits = cur.rowcount
            # keep one row in the product list, carrying over a category if only a variant had one
            cur.execute(
                "SELECT MAX(NULLIF(TRIM(category), '')) FROM products WHERE name = ANY(%s)",
                ([canonical] + variants,),
            )
            category = cur.fetchone()[0] or ""
            cur.execute("DELETE FROM products WHERE name = ANY(%s)", (variants,))
            cur.execute(
                """INSERT INTO products (name, category) VALUES (%s, %s)
                   ON CONFLICT (name) DO UPDATE SET category = COALESCE(NULLIF(products.category, ''), EXCLUDED.category)""",
                (canonical, category),
            )
        else:
            cur.execute("UPDATE sales_entries SET client_name = %s WHERE client_name = ANY(%s)", (canonical, variants))
            sales = cur.rowcount
            cur.execute("UPDATE visit_entries SET client_name = %s WHERE client_name = ANY(%s)", (canonical, variants))
            visits = cur.rowcount
            cur.execute("DELETE FROM clients WHERE name = ANY(%s)", (variants,))
            cur.execute("INSERT INTO clients (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (canonical,))
        audit.record(cur, access, f"data.merge_{payload.kind}", payload.kind, canonical,
                     {"variants": variants, "sales_lines": sales, "visits": visits})
    return {"status": "ok", "sales_lines_updated": sales, "visits_updated": visits}


class ConfirmIn(BaseModel):
    confirm: str = ""


@router.post("/remove-duplicate-lines")
def remove_duplicate_lines(payload: ConfirmIn, access: Access = Depends(require_cap(SYSTEM_ADMIN))):
    if payload.confirm != "DELETE":
        raise HTTPException(status_code=400, detail='Confirmation required: type DELETE')
    with transaction() as cur:
        cur.execute(
            """
            DELETE FROM sales_entries s
            USING (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY team, sales_person, client_name, product, entry_date, quantity, amount
                    ORDER BY id) AS rn
                FROM sales_entries
            ) d
            WHERE s.id = d.id AND d.rn > 1
            """
        )
        removed = cur.rowcount
        audit.record(cur, access, "data.remove_duplicate_lines", "sales_entries", None, {"removed": removed})
    return {"status": "ok", "removed": removed}
