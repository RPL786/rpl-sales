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

        from .attendance import leave_days
        leave = leave_days(cur, person, start, end)
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
                     "late_entries": late, "sunday": d.weekday() == 6, "future": d > today,
                     "leave": leave.get(iso)})
        d += timedelta(days=1)
    working = [x for x in days if not x["sunday"] and not x["future"] and not x["leave"]]
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
            "leave_days": sum(1 for x in days if x["leave"] and not x["sunday"]),
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


# ---------------------------------------------------------------------------
# Daily report status: who reported, who was on leave, who is missing
# ---------------------------------------------------------------------------

def _report_status(access: Access, team: str, date_from: str, date_to: str):
    today = _today()
    try:
        start = date.fromisoformat(date_from[:10]) if date_from else today.replace(day=1)
        end = date.fromisoformat(date_to[:10]) if date_to else today
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD")
    if end < start:
        start, end = end, start
    end = min(end, today)
    if (end - start).days > 92:
        raise HTTPException(status_code=400, detail="Choose a period of up to 3 months")

    with transaction() as cur:
        # field people (salespersons and team leaders) in scope, with their team membership dates
        cur.execute(
            """SELECT u.username, COALESCE(u.team, ''), u.role,
                      MIN(h.start_date), MAX(COALESCE(h.end_date, '9999-12-31'))
               FROM users u
               LEFT JOIN user_team_history h ON h.user_id = u.id
               WHERE u.role IN ('user', 'team_leader') AND COALESCE(u.is_active, TRUE)
               GROUP BY u.username, u.team, u.role
               ORDER BY LOWER(COALESCE(u.team, '')), LOWER(u.username)"""
        )
        people = []
        for uname, uteam, role, hs, he in cur.fetchall():
            if access.role == "user" and uname.strip().lower() != access.username.strip().lower():
                continue
            if access.role != "user" and not access.allows_team(uteam):
                continue
            if team and uteam.strip().lower() != team.strip().lower():
                continue
            people.append({"username": uname, "team": uteam, "role": role,
                           "from": (hs or "1900-01-01")[:10], "to": (he or "9999-12-31")[:10]})
        keys = [p["username"].strip().lower() for p in people]
        visits = {}
        leaves = {}
        if keys:
            cur.execute(
                """SELECT LOWER(TRIM(sales_person)), LEFT(meeting_date, 10), COUNT(*)
                   FROM visit_entries
                   WHERE LOWER(TRIM(sales_person)) = ANY(%s) AND LEFT(meeting_date, 10) BETWEEN %s AND %s
                     AND LOWER(COALESCE(meeting_type, '')) NOT LIKE 'future%%'
                   GROUP BY 1, 2""",
                (keys, start.isoformat(), end.isoformat()),
            )
            visits = {(k, d): int(n) for k, d, n in cur.fetchall()}
            cur.execute(
                """SELECT LOWER(TRIM(username)), date_from, date_to, reason_type, note, status FROM leaves
                   WHERE LOWER(TRIM(username)) = ANY(%s) AND status <> 'cancelled'
                     AND date_from <= %s AND date_to >= %s""",
                (keys, end.isoformat(), start.isoformat()),
            )
            for k, f, t, reason, note, st in cur.fetchall():
                d = max(f, start)
                while d <= min(t, end):
                    leaves[(k, d.isoformat())] = {"reason": reason, "note": note, "status": st}
                    d += timedelta(days=1)

    days = []
    d = start
    while d <= end:
        days.append(d)
        d += timedelta(days=1)

    rows, missing = [], []
    for p in people:
        k = p["username"].strip().lower()
        cells, tot = [], {"reported": 0, "leave": 0, "missing": 0}
        for day in days:
            iso = day.isoformat()
            n = visits.get((k, iso), 0)
            lv = leaves.get((k, iso))
            if iso < p["from"] or iso > p["to"]:
                status = "na"
            elif n:
                status = "reported"
            elif lv:
                status = "leave"
            elif day.weekday() == 6:
                status = "off"
            elif day == today:
                status = "today"  # the day is not over yet: not counted as missing
            else:
                status = "missing"
            cell = {"date": iso, "status": status, "visits": n}
            if lv:
                cell["leave"] = lv
            if status in tot:
                tot[status] += 1
            if status == "missing":
                missing.append({"date": iso, "weekday": day.strftime("%a"), "username": p["username"], "team": p["team"]})
            cells.append(cell)
        rows.append({**p, "days": cells, "totals": tot})

    leave_list = [
        {"date": c["date"], "username": r["username"], "team": r["team"], **c["leave"]}
        for r in rows for c in r["days"] if c["status"] == "leave"
    ]
    return start, end, days, rows, missing, leave_list


@router.get("/report-status")
def report_status(team: str = "", date_from: str = "", date_to: str = "", access: Access = Depends(get_access)):
    start, end, days, rows, missing, leave_list = _report_status(access, team, date_from, date_to)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "dates": [{"date": d.isoformat(), "weekday": d.strftime("%a"), "sunday": d.weekday() == 6} for d in days],
        "people": rows,
        "missing": sorted(missing, key=lambda m: (m["date"], m["username"].lower()), reverse=True),
        "on_leave": sorted(leave_list, key=lambda m: (m["date"], m["username"].lower()), reverse=True),
        "summary": {
            "people": len(rows),
            "reported_days": sum(r["totals"]["reported"] for r in rows),
            "leave_days": sum(r["totals"]["leave"] for r in rows),
            "missing_days": len(missing),
        },
    }


@router.get("/report-status/export")
def report_status_export(team: str = "", date_from: str = "", date_to: str = "", access: Access = Depends(get_access)):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    start, end, days, rows, missing, leave_list = _report_status(access, team, date_from, date_to)
    wb = Workbook()
    ws = wb.active
    ws.title = "Daily status"
    ws.append(["Salesperson", "Team"] + [d.strftime("%d %b %a") for d in days] + ["Reported", "Leave", "Missing"])
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="F97316")
    fills = {"missing": "FECACA", "leave": "BFDBFE", "reported": "BBF7D0", "off": "E5E7EB", "na": "F3F4F6",
             "today": "FFFFFF"}
    for r in rows:
        vals = []
        for c in r["days"]:
            if c["status"] == "reported":
                vals.append(c["visits"])
            elif c["status"] == "leave":
                st = c["leave"]["status"]
                vals.append(f"Leave ({c['leave']['reason']}{'' if st == 'approved' else ', ' + ('not approved' if st == 'rejected' else st)})")
            elif c["status"] == "missing":
                vals.append("Missing")
            elif c["status"] == "off":
                vals.append("Sunday")
            elif c["status"] == "today":
                vals.append("Today")
            else:
                vals.append("")
        ws.append([r["username"], r["team"]] + vals + [r["totals"]["reported"], r["totals"]["leave"], r["totals"]["missing"]])
        row_idx = ws.max_row
        for i, c in enumerate(r["days"]):
            ws.cell(row=row_idx, column=3 + i).fill = PatternFill("solid", fgColor=fills[c["status"]])
    ws.freeze_panes = "C2"
    ws.column_dimensions["A"].width = 22
    ws.column_dimensions["B"].width = 24

    ws2 = wb.create_sheet("Missing reports")
    ws2.append(["Date", "Day", "Salesperson", "Team"])
    for m in sorted(missing, key=lambda m: (m["date"], m["username"].lower())):
        ws2.append([m["date"], m["weekday"], m["username"], m["team"]])
    ws3 = wb.create_sheet("Leave")
    ws3.append(["Date", "Salesperson", "Team", "Reason", "Details", "Approval"])
    for l in sorted(leave_list, key=lambda m: (m["date"], m["username"].lower())):
        ws3.append([l["date"], l["username"], l["team"], l["reason"], l["note"],
                    "Not approved" if l["status"] == "rejected" else l["status"].title()])
    for w in (ws2, ws3):
        for c in w[1]:
            c.font = Font(bold=True)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="report_status_{start}_to_{end}.xlsx"'},
    )
