"""Safer Excel import: parse once, warn about repeats, check totals after saving.

- parse_sales_file() reads both supported layouts (monthly year-sheets and date-wise
  rows) and also returns the raw per-product totals found in the file plus every row
  that was skipped and why, so the result can be checked against what was saved.
- find_repeats() tells the user when the same file (or the same lines) was already
  imported for the team, before anything is written.
- Every import is recorded in import_batches and its sales lines carry import_id,
  so one import can be listed, checked and undone on its own.
"""
from __future__ import annotations

import hashlib
import io
import re
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from psycopg2.extras import execute_values
from pydantic import BaseModel

from . import audit
from .db import transaction
from .permissions import UPLOAD_SALES, Access, assert_team_allowed, require_cap

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MONTH_NUM = {m: i + 1 for i, m in enumerate(MONTHS)}
BLANK = {"", "nan", "none", "nat"}

router = APIRouter(prefix="/api/v2/imports", tags=["v2-imports"])


class ImportFormatError(ValueError):
    pass


def _year_of_sheet(name: str) -> Optional[int]:
    m = re.fullmatch(r"\s*(\d{4})\s*", str(name))
    return int(m.group(1)) if m else None


def _num(value) -> float:
    v = pd.to_numeric(value, errors="coerce")
    return 0.0 if pd.isna(v) else float(v)


def _text(value) -> str:
    s = str(value if value is not None else "").strip()
    return "" if s.lower() in BLANK else s


class Parsed:
    def __init__(self, layout: str):
        self.layout = layout
        self.rows: List[tuple] = []  # (sales_person, client, product, year, month, qty, amount, entry_date)
        self.file_qty: Dict[str, float] = defaultdict(float)
        self.file_amount: Dict[str, float] = defaultdict(float)
        self.file_lines: Dict[str, int] = defaultdict(int)
        self.skipped: List[dict] = []

    def skip(self, sheet: str, row_no: int, reason: str, product: str, qty: float):
        self.skipped.append({"sheet": sheet, "row": row_no, "reason": reason, "product": product or "(blank)",
                             "quantity": round(qty, 3)})


def parse_sales_file(content: bytes, filename: str) -> Parsed:
    name = (filename or "").lower()
    if not (name.endswith(".xlsx") or name.endswith(".xls")):
        raise ImportFormatError("Only Excel files (.xlsx / .xls) can be imported")
    workbook = pd.ExcelFile(io.BytesIO(content), engine="openpyxl")

    year_sheets = {y: s for s in workbook.sheet_names if (y := _year_of_sheet(s)) is not None}
    if year_sheets:
        return _parse_monthly(workbook, year_sheets)
    return _parse_datewise(workbook)


def _parse_monthly(workbook, year_sheets: Dict[int, str]) -> Parsed:
    p = Parsed("monthly_excel")
    for year, sheet in year_sheets.items():
        df = pd.read_excel(workbook, sheet_name=sheet, engine="openpyxl").rename(columns=lambda x: str(x).strip())
        if not {"Sales Person", "Client Name", "Product"}.issubset(df.columns):
            raise ImportFormatError(f"Sheet '{sheet}' missing required columns")
        for i, row in df.iterrows():
            person, client, product = _text(row["Sales Person"]), _text(row["Client Name"]), _text(row["Product"])
            for month in MONTHS:
                if month not in df.columns:
                    continue
                qty = _num(row[month])
                if qty == 0:
                    continue
                amount = 0.0
                for col in (f"{month} Amount", f"{month}_Amount", f"Amount {month}"):
                    if col in df.columns:
                        amount = _num(row[col])
                        break
                p.file_qty[product or "(blank)"] += qty
                p.file_amount[product or "(blank)"] += amount
                p.file_lines[product or "(blank)"] += 1
                if not (person and client and product):
                    p.skip(sheet, int(i) + 2, "Missing salesperson, customer or product", product, qty)
                    continue
                p.rows.append((person, client, product, int(year), month, qty, amount,
                               f"{int(year)}-{MONTH_NUM[month]:02d}-01"))
    return p


def _parse_datewise(workbook) -> Parsed:
    p = Parsed("date_excel")
    need = {"Sales Person", "Client Name", "Product", "Date", "Quantity"}
    found = False
    for sheet in workbook.sheet_names:
        df = pd.read_excel(workbook, sheet_name=sheet, engine="openpyxl").rename(columns=lambda x: str(x).strip())
        if not need.issubset(df.columns):
            continue
        found = True
        for i, row in df.iterrows():
            if all(_text(row[c]) == "" for c in need):
                continue
            person, client, product = _text(row["Sales Person"]), _text(row["Client Name"]), _text(row["Product"])
            qty = _num(row["Quantity"])
            amount = _num(row["Amount"]) if "Amount" in df.columns else 0.0
            key = product or "(blank)"
            if qty != 0:
                p.file_qty[key] += qty
                p.file_amount[key] += amount
                p.file_lines[key] += 1
            row_no = int(i) + 2
            if not (person and client and product):
                if qty:
                    p.skip(sheet, row_no, "Missing salesperson, customer or product", product, qty)
                continue
            if qty == 0:
                continue
            parsed = pd.to_datetime(row["Date"], errors="coerce")
            if pd.isna(parsed):
                p.skip(sheet, row_no, "Date not readable", product, qty)
                continue
            p.rows.append((person, client, product, int(parsed.year), MONTHS[parsed.month - 1], qty, amount,
                           parsed.strftime("%Y-%m-%d")))
    if not found:
        raise ImportFormatError(
            "Excel format not recognized. Use either monthly year-sheet format or date-wise columns: "
            "Sales Person, Client Name, Product, Date, Quantity"
        )
    return p


def file_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def find_repeats(cur, team: str, digest: str, rows: List[tuple]) -> Optional[dict]:
    """Return a warning dict when this file or these lines were already imported for the team."""
    cur.execute(
        """SELECT id, filename, created_at, username, rows_inserted FROM import_batches
           WHERE team = %s AND file_hash = %s AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1""",
        (team, digest),
    )
    same_file = cur.fetchone()

    overlap_lines, overlap_qty = 0, 0.0
    if rows:
        cur.execute(
            "CREATE TEMP TABLE IF NOT EXISTS tmp_import_check "
            "(sales_person TEXT, client_name TEXT, product TEXT, entry_date TEXT, quantity DOUBLE PRECISION) ON COMMIT DROP"
        )
        cur.execute("TRUNCATE tmp_import_check")
        execute_values(cur, "INSERT INTO tmp_import_check VALUES %s",
                       [(r[0], r[1], r[2], r[7], r[5]) for r in rows], page_size=1000)
        cur.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(t.quantity), 0) FROM tmp_import_check t
            WHERE EXISTS (
                SELECT 1 FROM sales_entries s
                WHERE s.team = %s AND s.sales_person = t.sales_person AND s.client_name = t.client_name
                  AND s.product = t.product AND LEFT(s.entry_date, 10) = t.entry_date
                  AND ABS(s.quantity::float8 - t.quantity) < 0.001
            )
            """,
            (team,),
        )
        overlap_lines, overlap_qty = cur.fetchone()
        overlap_lines, overlap_qty = int(overlap_lines or 0), float(overlap_qty or 0)

    if not same_file and overlap_lines == 0:
        return None
    dates = sorted(r[7] for r in rows)
    return {
        "same_file": None if not same_file else {
            "import_id": same_file[0], "filename": same_file[1],
            "imported_at": same_file[2].isoformat() if same_file[2] else None,
            "by": same_file[3], "rows": same_file[4],
        },
        "overlap_lines": overlap_lines,
        "overlap_qty": round(overlap_qty, 3),
        "file_lines": len(rows),
        "date_from": dates[0] if dates else None,
        "date_to": dates[-1] if dates else None,
    }


def use_existing_names(cur, rows: List[tuple]) -> List[tuple]:
    """Reuse existing customer / product spellings so an import never creates new name variants."""
    from .names import canonical_map

    clients = canonical_map(cur, "client", [r[1] for r in rows])
    products = canonical_map(cur, "product", [r[2] for r in rows])
    return [(r[0], clients.get(r[1], r[1]), products.get(r[2], r[2])) + tuple(r[3:]) for r in rows]


def save_rows(cur, team: str, import_id: int, rows: List[tuple]) -> int:
    if not rows:
        return 0
    execute_values(
        cur,
        """INSERT INTO sales_entries
           (team, sales_person, client_name, client_category, product, year, month, quantity, amount, entry_date, import_id)
           VALUES %s""",
        [(team, r[0], r[1], "", r[2], r[3], r[4], r[5], r[6], r[7], import_id) for r in rows],
        page_size=1000,
    )
    for table, idx in (("sales_people", 0), ("clients", 1), ("products", 2)):
        names = sorted({r[idx] for r in rows})
        execute_values(cur, f"INSERT INTO {table} (name) VALUES %s ON CONFLICT (name) DO NOTHING",
                       [(n,) for n in names])
    return len(rows)


def reconcile(cur, import_id: int, parsed: Parsed) -> dict:
    """Compare per-product totals in the Excel file with what was actually saved."""
    cur.execute(
        "SELECT product, COUNT(*), SUM(quantity::float8), SUM(COALESCE(amount, 0)::float8) FROM sales_entries "
        "WHERE import_id = %s GROUP BY product",
        (import_id,),
    )
    from .datahealth import name_key

    # compare by name key: an import may save a product under its existing spelling
    saved: Dict[str, tuple] = {}
    saved_name: Dict[str, str] = {}
    for r in cur.fetchall():
        k = name_key(r[0])
        prev = saved.get(k, (0, 0.0, 0.0))
        saved[k] = (prev[0] + int(r[1]), prev[1] + float(r[2] or 0), prev[2] + float(r[3] or 0))
        saved_name[k] = r[0]
    file_qty: Dict[str, float] = defaultdict(float)
    file_amount: Dict[str, float] = defaultdict(float)
    file_lines: Dict[str, int] = defaultdict(int)
    file_name: Dict[str, str] = {}
    for prod, q in parsed.file_qty.items():
        k = name_key(prod) if prod != "(blank)" else "(blank)"
        file_qty[k] += q
        file_amount[k] += parsed.file_amount.get(prod, 0.0)
        file_lines[k] += parsed.file_lines.get(prod, 0)
        file_name.setdefault(k, prod)
    lines = []
    for prod in sorted(set(file_qty) | set(saved)):
        fq = round(file_qty.get(prod, 0.0), 3)
        sq = round(saved.get(prod, (0, 0.0, 0.0))[1], 3)
        lines.append({
            "product": saved_name.get(prod) or file_name.get(prod, prod),
            "file_name": file_name.get(prod),
            "file_lines": file_lines.get(prod, 0),
            "saved_lines": saved.get(prod, (0, 0, 0))[0],
            "file_qty": fq,
            "saved_qty": sq,
            "difference": round(sq - fq, 3),
            "file_amount": round(file_amount.get(prod, 0.0), 2),
            "saved_amount": round(saved.get(prod, (0, 0.0, 0.0))[2], 2),
        })
    def off(l):  # quantities are stored as REAL, so allow float rounding noise
        return abs(l["difference"]) > max(0.01, abs(l["file_qty"]) * 1e-6)

    mismatched = [l for l in lines if off(l)]
    file_total = round(sum(parsed.file_qty.values()), 3)
    saved_total = round(sum(v[1] for v in saved.values()), 3)
    return {
        "ok": not mismatched,
        "file_qty": file_total,
        "saved_qty": saved_total,
        "difference": round(saved_total - file_total, 3),
        "products": sorted(lines, key=lambda l: (not off(l), l["product"])),
        "mismatched_products": len(mismatched),
        "skipped_rows": len(parsed.skipped),
        "skipped": parsed.skipped[:200],
    }


# ---------------------------------------------------------------------------
# History + undo
# ---------------------------------------------------------------------------

@router.get("")
def list_imports(access: Access = Depends(require_cap(UPLOAD_SALES))):
    with transaction() as cur:
        cur.execute(
            """SELECT id, team, filename, mode, rows_inserted, qty_total, date_from, date_to, created_at, username,
                      undone_at, check_ok
               FROM import_batches ORDER BY created_at DESC LIMIT 200"""
        )
        rows = cur.fetchall()
    out = []
    for r in rows:
        if not access.allows_team(r[1]):
            continue
        out.append({"id": r[0], "team": r[1], "filename": r[2], "mode": r[3], "rows": r[4],
                    "qty": float(r[5] or 0), "date_from": r[6], "date_to": r[7], "imported_at": r[8],
                    "by": r[9], "undone_at": r[10], "check_ok": r[11]})
    return {"imports": out[:50]}


class UndoIn(BaseModel):
    confirm: str = ""


@router.post("/{import_id}/undo")
def undo_import(import_id: int, payload: UndoIn, access: Access = Depends(require_cap(UPLOAD_SALES))):
    if payload.confirm != "UNDO":
        raise HTTPException(status_code=400, detail="Confirmation required: type UNDO")
    with transaction() as cur:
        cur.execute("SELECT team, undone_at, mode FROM import_batches WHERE id = %s FOR UPDATE", (import_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Import not found")
        assert_team_allowed(access, row[0])
        if row[1]:
            raise HTTPException(status_code=400, detail="This import was already undone")
        cur.execute("DELETE FROM sales_entries WHERE import_id = %s", (import_id,))
        removed = cur.rowcount
        cur.execute("UPDATE import_batches SET undone_at = now() WHERE id = %s", (import_id,))
        audit.record(cur, access, "sales.import_undo", "import", import_id,
                     {"team": row[0], "removed": removed, "mode": row[2]})
    note = ("The lines from this import were removed. Data deleted by a Replace import is not restored — "
            "use your backup for that.") if row[2] == "replace" else "The lines from this import were removed."
    return {"status": "ok", "removed": removed, "note": note}
