"""Visit search, activity calendar and export.

GET /api/v2/visits/search    smart search + filters + summary + paging
GET /api/v2/visits/activity  per-day visits and entries for one salesperson (dispute checks)
GET /api/v2/visits/export    the filtered list as an Excel file

Scope is the same as V1 /api/visit-entries: Super Admin/Boss all, team leader own team,
scoped roles their teams, team members only their own visits.

Smart search: every word must match somewhere (customer, salesperson, team, product,
status, type, response, notes, date). Month names ("october", "oct") match the visit
month, and customer/product words also match ignoring spaces and punctuation
("abc traders." finds "ABC Traders", "1.5kg" finds "1.5 KG").
"""
from __future__ import annotations

import calendar
import io
import re
from datetime import date, timedelta
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from .analytics import _like, _today, _visit_scope_params, _visit_scope_sql
from .db import transaction
from .permissions import Access, get_access

router = APIRouter(prefix="/api/v2/visits", tags=["v2-visits"])

MONTH_WORDS = {}
for _i, _m in enumerate(calendar.month_name):
    if _m:
        MONTH_WORDS[_m.lower()] = _i
        MONTH_WORDS[_m[:3].lower()] = _i
MONTH_WORDS["sept"] = 9

COLS = ["id", "meeting_date", "meeting_time", "team", "sales_person", "client_name", "client_category", "product",
        "meeting_type", "meeting_status", "client_response", "notes", "next_meeting_date", "next_meeting_time",
        "order_amount", "quantity", "created_by", "created_at"]

# entry time in Karachi (created_at is stored as UTC ISO text, e.g. 2026-10-05T07:12:00Z)
_CREATED_LOCAL = (
    "CASE WHEN v.created_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}' "
    "THEN (v.created_at::timestamptz AT TIME ZONE 'Asia/Karachi') END"
)
_HAYSTACK = (
    "LOWER(CONCAT_WS(' ', v.meeting_date, v.team, v.sales_person, v.created_by, v.client_name, v.client_category, "
    "v.product, v.meeting_type, v.meeting_status, v.client_response, v.notes))"
)
_COMPACT = "REGEXP_REPLACE(LOWER(CONCAT_WS(' ', v.client_name, v.product)), '[^a-z0-9.]', '', 'g')"


def _compact(s: str) -> str:
    s = re.sub(r"[^a-z0-9.]", "", s.lower())
    return re.sub(r"(?<!\d)\.|\.(?!\d)", "", s)  # keep only decimal points (1.5), drop full stops


def _filters(access: Access, q: str, sales_person: str, team: str, status: str, meeting_type: str,
             date_from: str, date_to: str) -> Tuple[str, list]:
    sql = " WHERE 1=1" + _visit_scope_sql(access)
    params: list = list(_visit_scope_params(access))

    for word in [w for w in re.split(r"\s+", (q or "").strip().lower()) if w][:8]:
        if word in MONTH_WORDS:
            sql += " AND SUBSTRING(v.meeting_date, 6, 2) = %s"
            params.append(f"{MONTH_WORDS[word]:02d}")
            continue
        if re.fullmatch(r"20\d{2}", word):
            sql += " AND LEFT(v.meeting_date, 4) = %s"
            params.append(word)
            continue
        compact = _compact(word)
        if compact and compact != word:
            sql += f" AND ({_HAYSTACK} LIKE %s ESCAPE '\\' OR {_COMPACT} LIKE %s ESCAPE '\\')"
            params += [_like(word), _like(compact)]
        else:
            sql += f" AND ({_HAYSTACK} LIKE %s ESCAPE '\\' OR {_COMPACT} LIKE %s ESCAPE '\\')"
            params += [_like(word), _like(compact or word)]

    if sales_person.strip() and access.role != "user":
        sql += " AND LOWER(TRIM(v.sales_person)) = LOWER(TRIM(%s))"
        params.append(sales_person.strip())
    if team.strip():
        sql += " AND LOWER(TRIM(v.team)) = LOWER(TRIM(%s))"
        params.append(team.strip())
    if status.strip():
        sql += " AND LOWER(TRIM(v.meeting_status)) = LOWER(TRIM(%s))"
        params.append(status.strip())
    if meeting_type.strip():
        sql += " AND LOWER(TRIM(v.meeting_type)) = LOWER(TRIM(%s))"
        params.append(meeting_type.strip())
    if date_from:
        sql += " AND LEFT(v.meeting_date, 10) >= %s"
        params.append(date_from[:10])
    if date_to:
        sql += " AND LEFT(v.meeting_date, 10) <= %s"
        params.append(date_to[:10])
    return sql, params


def _rows(cur, where: str, params: list, limit: Optional[int] = None, offset: int = 0) -> List[dict]:
    sel = ", ".join(f"v.{c}" for c in COLS)
    cur.execute(
        f"""SELECT {sel}, {_CREATED_LOCAL} AS created_local FROM visit_entries v {where}
            ORDER BY v.meeting_date DESC, v.meeting_time DESC, v.id DESC"""
        + (" LIMIT %s OFFSET %s" if limit else ""),
        params + ([limit, offset] if limit else []),
    )
    out = []
    for r in cur.fetchall():
        row = dict(zip(COLS + ["created_local"], r))
        loc = row.pop("created_local")
        row["entered_at"] = loc.strftime("%Y-%m-%d %H:%M") if loc else (row.get("created_at") or "")
        # entered on a later day than the meeting date (back-dated entry)
        try:
            row["entered_late_days"] = (loc.date() - date.fromisoformat(str(row["meeting_date"])[:10])).days if loc else None
        except ValueError:
            row["entered_late_days"] = None
        out.append(row)
    return out


def _edits(cur, ids: List[int]) -> dict:
    if not ids:
        return {}
    cur.execute(
        """SELECT entity_id, COUNT(*), MAX(occurred_at), MAX(actor_username) FROM audit_events
           WHERE action = 'visit.update' AND entity_type = 'visit' AND entity_id = ANY(%s) GROUP BY entity_id""",
        ([str(i) for i in ids],),
    )
    return {int(e): {"count": int(n), "last": t.isoformat() if t else None, "by": by} for e, n, t, by in cur.fetchall()}


@router.get("/search")
def search_visits(
    q: str = "",
    sales_person: str = "",
    team: str = "",
    status: str = "",
    meeting_type: str = "",
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=10, le=200),
    access: Access = Depends(get_access),
):
    where, params = _filters(access, q, sales_person, team, status, meeting_type, date_from, date_to)
    scope_where = " WHERE 1=1" + _visit_scope_sql(access)
    scope_params = list(_visit_scope_params(access))
    with transaction() as cur:
        cur.execute(
            f"""SELECT COUNT(*), COUNT(DISTINCT LOWER(TRIM(v.client_name))), COUNT(DISTINCT LOWER(TRIM(v.sales_person))),
                       SUM(CASE WHEN LOWER(v.meeting_status) = 'order received' THEN 1 ELSE 0 END),
                       SUM(CASE WHEN LOWER(v.meeting_status) = 'order received' THEN COALESCE(v.order_amount, 0) ELSE 0 END),
                       SUM(CASE WHEN COALESCE(v.next_meeting_date, '') <> '' AND LOWER(v.meeting_status) NOT IN
                           ('order received', 'rejected', 'closed') THEN 1 ELSE 0 END),
                       MIN(LEFT(v.meeting_date, 10)), MAX(LEFT(v.meeting_date, 10))
                FROM visit_entries v {where}""",
            params,
        )
        t = cur.fetchone()
        total = int(t[0] or 0)
        items = _rows(cur, where, params, page_size, (page - 1) * page_size)
        edits = _edits(cur, [i["id"] for i in items])
        for i in items:
            i["edited"] = edits.get(i["id"])

        # options for the filter dropdowns (within the user's scope)
        cur.execute(
            f"""SELECT 'p', TRIM(v.sales_person) FROM visit_entries v {scope_where} GROUP BY 2
                UNION ALL SELECT 't', TRIM(v.team) FROM visit_entries v {scope_where} GROUP BY 2
                UNION ALL SELECT 's', TRIM(v.meeting_status) FROM visit_entries v {scope_where} GROUP BY 2
                UNION ALL SELECT 'm', TRIM(v.meeting_type) FROM visit_entries v {scope_where} GROUP BY 2""",
            scope_params * 4,
        )
        opts = {"p": set(), "t": set(), "s": set(), "m": set()}
        for k, v in cur.fetchall():
            if v:
                opts[k].add(v)

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, -(-total // page_size)),
        "summary": {
            "visits": total,
            "customers": int(t[1] or 0),
            "people": int(t[2] or 0),
            "orders": int(t[3] or 0),
            "order_amount": round(float(t[4] or 0), 2),
            "open_followups": int(t[5] or 0),
            "first_date": t[6],
            "last_date": t[7],
        },
        "items": items,
        "options": {
            "sales_people": sorted(opts["p"], key=str.lower) if access.role != "user" else [access.username],
            "teams": sorted(opts["t"], key=str.lower),
            "statuses": sorted(opts["s"], key=str.lower),
            "meeting_types": sorted(opts["m"], key=str.lower),
        },
    }


@router.get("/activity")
def visit_activity(
    sales_person: str = "",
    date_from: str = "",
    date_to: str = "",
    access: Access = Depends(get_access),
):
    """Day by day for one salesperson: visits by meeting date and entries by the day they were typed in."""
    person = access.username if access.role == "user" else (sales_person or "").strip()
    if not person:
        raise HTTPException(status_code=400, detail="Choose a salesperson")
    today = _today()
    try:
        start = date.fromisoformat(date_from[:10]) if date_from else today.replace(day=1)
        end = date.fromisoformat(date_to[:10]) if date_to else today
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD")
    if end < start:
        start, end = end, start
    if (end - start).days > 400:
        raise HTTPException(status_code=400, detail="Choose a period of up to 13 months")

    scope = _visit_scope_sql(access)
    sp = list(_visit_scope_params(access))
    person_sql = " AND (LOWER(TRIM(v.sales_person)) = LOWER(TRIM(%s)) OR LOWER(TRIM(v.created_by)) = LOWER(TRIM(%s)))"
    with transaction() as cur:
        cur.execute(
            f"""SELECT LEFT(v.meeting_date, 10), COUNT(*),
                       SUM(CASE WHEN LOWER(v.meeting_status) = 'order received' THEN 1 ELSE 0 END)
                FROM visit_entries v WHERE LEFT(v.meeting_date, 10) BETWEEN %s AND %s {scope} {person_sql}
                GROUP BY 1""",
            [start.isoformat(), end.isoformat()] + sp + [person, person],
        )
        by_meeting = {d: (int(n), int(o or 0)) for d, n, o in cur.fetchall()}
        cur.execute(
            f"""SELECT ({_CREATED_LOCAL})::date AS d, COUNT(*),
                       SUM(CASE WHEN ({_CREATED_LOCAL})::date > LEFT(v.meeting_date, 10)::date THEN 1 ELSE 0 END)
                FROM visit_entries v
                WHERE v.meeting_date ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}' {scope} {person_sql}
                  AND ({_CREATED_LOCAL})::date BETWEEN %s AND %s
                GROUP BY 1""",
            sp + [person, person, start, end],
        )
        by_entry = {d.isoformat(): (int(n), int(l or 0)) for d, n, l in cur.fetchall() if d}

        cur.execute(
            """SELECT action, occurred_at, actor_username, details FROM audit_events
               WHERE action IN ('visit.update', 'visit.delete') AND occurred_at >= %s
                 AND (LOWER(details->'before'->>'sales_person') = LOWER(%s)
                      OR LOWER(details->'before'->>'created_by') = LOWER(%s))
               ORDER BY occurred_at DESC LIMIT 50""",
            (start.isoformat(), person, person),
        )
        changes = [
            {"action": a.split(".")[1], "at": t.isoformat() if t else None, "by": by,
             "client_name": (d or {}).get("before", {}).get("client_name"),
             "meeting_date": (d or {}).get("before", {}).get("meeting_date")}
            for a, t, by, d in cur.fetchall()
        ]

    days = []
    d = start
    while d <= end:
        iso = d.isoformat()
        v, o = by_meeting.get(iso, (0, 0))
        e, late = by_entry.get(iso, (0, 0))
        days.append({"date": iso, "weekday": d.strftime("%a"), "visits": v, "orders": o, "entries": e,
                     "late_entries": late, "sunday": d.weekday() == 6, "future": d > today})
        d += timedelta(days=1)
    working = [x for x in days if not x["sunday"] and not x["future"]]
    return {
        "sales_person": person,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "days": days,
        "summary": {
            "visits": sum(x["visits"] for x in days),
            "orders": sum(x["orders"] for x in days),
            "working_days": len(working),
            "days_with_visits": sum(1 for x in working if x["visits"]),
            "days_without_visits": sum(1 for x in working if not x["visits"]),
            "late_entries": sum(x["late_entries"] for x in days),
        },
        "changes": changes,
    }


@router.get("/export")
def export_visits(
    q: str = "",
    sales_person: str = "",
    team: str = "",
    status: str = "",
    meeting_type: str = "",
    date_from: str = "",
    date_to: str = "",
    format: str = "xlsx",
    access: Access = Depends(get_access),
):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    where, params = _filters(access, q, sales_person, team, status, meeting_type, date_from, date_to)
    with transaction() as cur:
        rows = _rows(cur, where, params, limit=20000)
    if format == "json":
        return {"items": rows, "count": len(rows)}

    wb = Workbook()
    ws = wb.active
    ws.title = "Visits"
    head = ["Date", "Time", "Team", "Salesperson", "Customer", "Category", "Product", "Type", "Status",
            "Customer response", "Notes", "Next follow-up", "Order amount", "Quantity", "Entered by", "Entered at"]
    ws.append(head)
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="F97316")
    for r in rows:
        ws.append([r["meeting_date"], r["meeting_time"], r["team"], r["sales_person"], r["client_name"],
                   r["client_category"], r["product"], r["meeting_type"], r["meeting_status"], r["client_response"],
                   r["notes"], r["next_meeting_date"], r["order_amount"], r["quantity"], r["created_by"],
                   r["entered_at"]])
    for col, width in zip("ABCDEFGHIJKLMNOP", [11, 7, 16, 16, 28, 14, 26, 14, 16, 30, 36, 13, 12, 9, 14, 17]):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    label = (sales_person or "all").replace(" ", "_")
    fname = f"visits_{label}_{date_from or 'start'}_to_{date_to or 'today'}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
