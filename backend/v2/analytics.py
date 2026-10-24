"""V2 analytics: dynamic multi-year comparison, Customer 360 and Visit Planner data.

All queries are scoped to the caller's teams (role + scope), read-only, and work on the
existing V1 tables (sales_entries, visit_entries, clients).
"""
from __future__ import annotations

import calendar
import os
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from .db import transaction
from .permissions import VIEW_REPORTS, Access, assert_team_allowed, get_access, require_cap

router = APIRouter(prefix="/api/v2", tags=["v2-analytics"])

def _today() -> date:
    """'Today' in the business timezone (default Asia/Karachi), not the server's clock zone."""
    tz_name = os.getenv("APP_TIMEZONE", "Asia/Karachi")
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(tz_name)).date()
    except Exception:  # tzdata missing in slim images: Pakistan is UTC+5 all year
        return datetime.now(timezone(timedelta(hours=5))).date()


def _like(q: str) -> str:
    escaped = q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_MONTH_ARRAY = "ARRAY['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']"

# month number (1-12) and day (1-31) derived from V1 columns; day falls back to 1 for monthly uploads
_BASE = f"""
    SELECT
        s.year AS y,
        array_position({_MONTH_ARRAY}, initcap(left(trim(s.month), 3))) AS m,
        CASE WHEN s.entry_date ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}' THEN substring(s.entry_date, 9, 2)::int ELSE 1 END AS d,
        s.team, s.sales_person, s.product, s.client_name,
        COALESCE(s.quantity, 0) AS qty,
        COALESCE(s.amount, 0) AS amt
    FROM sales_entries s
"""


def _team_filter(access: Access, teams_param: str) -> Tuple[Optional[List[str]], bool]:
    """Return (team list or None for all, explicit?) after scope checks."""
    requested = [t.strip() for t in (teams_param or "").split(",") if t.strip()]
    if requested:
        for t in requested:
            assert_team_allowed(access, t)
        return requested, True
    if access.org_wide:
        return None, False
    return sorted(access.team_names or []), False


def _where(teams: Optional[List[str]], salesperson: str = "", client: str = "",
           exact_person: bool = False) -> Tuple[str, list]:
    clauses, params = [], []
    if teams is not None:
        clauses.append("LOWER(TRIM(s.team)) = ANY(%s)")
        params.append([t.strip().lower() for t in teams])
    if salesperson and exact_person:
        clauses.append("s.sales_person = %s")  # same rule as V1 /data/entries for team members
        params.append(salesperson)
    elif salesperson:
        clauses.append("LOWER(TRIM(s.sales_person)) = LOWER(TRIM(%s))")
        params.append(salesperson)
    if client:
        clauses.append("LOWER(TRIM(s.client_name)) = LOWER(TRIM(%s))")
        params.append(client)
    return ("WHERE " + " AND ".join(clauses)) if clauses else "", params


def _growth(cur: float, prev: Optional[float]) -> Optional[float]:
    if prev is None or prev == 0:
        return None
    return round((cur - prev) / prev * 100, 2)


# =============================================================== multi-year
@router.get("/analytics/multi-year")
def multi_year(
    teams: str = "",
    salesperson: str = "",
    metric: str = Query("qty", pattern="^(qty|amount)$"),
    mode: str = Query("ytd", pattern="^(ytd|full)$"),
    years: str = "",
    top: int = 15,
    access: Access = Depends(require_cap(VIEW_REPORTS)),
):
    team_list, _ = _team_filter(access, teams)
    where, params = _where(team_list, salesperson.strip())
    col = "qty" if metric == "qty" else "amt"
    top = max(1, min(int(top), 50))
    empty = {"years_available": [], "years": [], "metric": metric, "mode": mode, "cutoff": None,
             "monthly": [], "totals": [], "salespersons": [], "products": [], "latest_year_partial": False,
             "prorated_years": []}

    with transaction() as cur:
        cur.execute(f"WITH b AS ({_BASE} {where}) SELECT DISTINCT y FROM b WHERE y IS NOT NULL ORDER BY y", params)
        available = [int(r[0]) for r in cur.fetchall()]
        if not available:
            return empty

        latest = available[-1]
        cur.execute(
            f"WITH b AS ({_BASE} {where}) SELECT MAX(m) FROM b WHERE y = %s AND m IS NOT NULL",
            params + [latest],
        )
        cut_m = int(cur.fetchone()[0] or 12)
        # Granularity per year in the cutoff month: monthly uploads store every row on day 1
        cur.execute(
            f"""WITH b AS ({_BASE} {where})
                SELECT y, MAX(d) FROM b WHERE m = %s AND y IS NOT NULL GROUP BY y""",
            params + [cut_m],
        )
        max_day_in_cut = {int(y): int(d or 1) for y, d in cur.fetchall()}
        cur.execute(
            f"WITH b AS ({_BASE} {where}) SELECT MAX(d) FROM b WHERE y = %s",
            params + [latest],
        )
        latest_has_daily = int(cur.fetchone()[0] or 1) > 1
        cut_d = max_day_in_cut.get(latest, 1)
        days_in_cut_month = calendar.monthrange(latest, cut_m)[1]
        latest_monthly_in_cut = cut_d == 1 and not latest_has_daily
        month_complete = latest_monthly_in_cut or cut_d >= days_in_cut_month

        # Years whose cutoff-month data is monthly (day 1 only): pro-rate that month for a fair YTD
        if month_complete:
            frac, cut_day_sql, prorated = 1.0, 31, []
        else:
            frac = round(cut_d / days_in_cut_month, 6)
            cut_day_sql = cut_d
            prorated = sorted(y for y, md in max_day_in_cut.items() if md == 1 and y != latest)

        def ytd_val(c: str):
            return (f"(CASE WHEN m < %s THEN {c} "
                    f"WHEN m = %s AND y = ANY(%s) THEN {c} * %s "
                    f"WHEN m = %s AND d <= %s THEN {c} ELSE 0 END)",
                    [cut_m, cut_m, prorated, frac, cut_m, cut_day_sql])

        ytd_in = "(m < %s OR (m = %s AND (y = ANY(%s) OR d <= %s)))"
        ytd_in_params = [cut_m, cut_m, prorated, cut_day_sql]

        if mode == "ytd":
            val_sql, val_params = ytd_val(col)
            in_sql, in_params = ytd_in, ytd_in_params
        else:
            val_sql, val_params = col, []
            in_sql, in_params = "TRUE", []

        requested = sorted({int(y) for y in years.split(",") if y.strip().isdigit()})
        selected = [y for y in requested if y in available] or available[-3:]

        # monthly series (CTE params, then SELECT params, then WHERE params)
        cur.execute(
            f"""WITH b AS ({_BASE} {where})
                SELECT y, m, SUM({val_sql}) FROM b
                WHERE y = ANY(%s) AND m IS NOT NULL AND {in_sql}
                GROUP BY y, m""",
            params + val_params + [selected] + in_params,
        )
        monthly_map: Dict[int, Dict[str, float]] = defaultdict(dict)
        for y, m, v in cur.fetchall():
            monthly_map[int(m)][str(y)] = round(float(v or 0), 2)
        last_month = cut_m if mode == "ytd" else 12
        monthly = [
            {"month": MONTHS[m - 1], **{str(y): monthly_map.get(m, {}).get(str(y), 0) for y in selected}}
            for m in range(1, last_month + 1)
        ]

        # totals per year: full and fair-YTD for every year (growth needs the previous year)
        ytd_sql, ytd_params = ytd_val(col)
        cur.execute(
            f"""WITH b AS ({_BASE} {where})
                SELECT y, SUM({col}), SUM({ytd_sql}) FROM b WHERE y IS NOT NULL GROUP BY y ORDER BY y""",
            params + ytd_params,
        )
        tot = {int(y): (float(f or 0), float(t or 0)) for y, f, t in cur.fetchall()}

        cur.execute(
            f"""WITH b AS ({_BASE} {where})
                SELECT DISTINCT y, LOWER(TRIM(client_name)) FROM b
                WHERE y IS NOT NULL AND client_name IS NOT NULL AND TRIM(client_name) <> '' AND {in_sql}""",
            params + in_params,
        )
        clients: Dict[int, set] = defaultdict(set)
        for y, c in cur.fetchall():
            clients[int(y)].add(c)

        totals = []
        for y in selected:
            full, ytd = tot.get(y, (0.0, 0.0))
            value = ytd if mode == "ytd" else full
            prev = tot.get(y - 1)
            prev_value = None if prev is None else (prev[1] if mode == "ytd" else prev[0])
            cur_c, prev_c = clients.get(y, set()), clients.get(y - 1, set())
            totals.append({
                "year": y,
                "value": round(value, 2),
                "full": round(full, 2),
                "ytd": round(ytd, 2),
                "growth_pct": _growth(value, prev_value),
                "clients_active": len(cur_c),
                "clients_new": len(cur_c - prev_c) if (y - 1) in clients else None,
                "clients_lost": len(prev_c - cur_c) if (y - 1) in clients else None,
            })

        def breakdown(field: str):
            # group on the trimmed, case-folded name so "ZAIN" and "zain " add up instead of colliding
            cur.execute(
                f"""WITH b AS ({_BASE} {where})
                    SELECT MIN(TRIM({field})), y, SUM({val_sql}) FROM b
                    WHERE y = ANY(%s) AND {field} IS NOT NULL AND TRIM({field}) <> '' AND {in_sql}
                    GROUP BY LOWER(TRIM({field})), y""",
                params + val_params + [selected] + in_params,
            )
            data: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
            display: Dict[str, str] = {}
            for name, y, v in cur.fetchall():
                key = str(name).strip().lower()
                display.setdefault(key, str(name).strip())
                data[key][str(y)] += float(v or 0)
            last, prev_y = str(selected[-1]), str(selected[-2]) if len(selected) > 1 else None
            rows = []
            for key, vals in data.items():
                if key in {"nan", "none"}:
                    continue
                rows.append({
                    "name": display[key],
                    "values": {str(y): round(vals.get(str(y), 0), 2) for y in selected},
                    "growth_pct": _growth(vals.get(last, 0), vals.get(prev_y) if prev_y else None),
                })
            rows.sort(key=lambda r: (r["values"].get(last, 0), sum(r["values"].values())), reverse=True)
            return rows[:top]

        salespersons = breakdown("sales_person")
        products = breakdown("product")

    label = f"Jan – {MONTHS[cut_m - 1]}" if month_complete else f"1 Jan – {cut_d} {MONTHS[cut_m - 1]}"
    return {
        "years_available": available,
        "years": selected,
        "metric": metric,
        "mode": mode,
        "cutoff": {"year": latest, "month": MONTHS[cut_m - 1], "day": None if month_complete else cut_d,
                   "label": label},
        "latest_year_partial": not (cut_m == 12 and month_complete),
        "prorated_years": prorated if mode == "ytd" else [],
        "monthly": monthly,
        "totals": totals,
        "salespersons": salespersons,
        "products": products,
    }


# =============================================================== customers
@router.get("/customers/search")
def customer_search(q: str = "", limit: int = 20, access: Access = Depends(get_access)):
    q = (q or "").strip()
    if len(q) < 2:
        return {"customers": []}
    team_list, _ = _team_filter(access, "")
    if access.role == "user":  # team members: only their own customers
        where, params = _where(team_list, salesperson=access.username, exact_person=True)
    else:
        where, params = _where(team_list)
    like = _like(q)
    limit = max(1, min(int(limit), 50))
    with transaction() as cur:
        cur.execute(
            f"""
            SELECT MIN(name), MAX(last_date), SUM(total), MAX(src) FROM (
                SELECT TRIM(s.client_name) AS name, MAX(s.entry_date) AS last_date, SUM(COALESCE(s.quantity,0)) AS total, 1 AS src
                FROM sales_entries s {where} {"AND" if where else "WHERE"} LOWER(s.client_name) LIKE %s ESCAPE '\\'
                GROUP BY TRIM(s.client_name)
                UNION ALL
                SELECT TRIM(v.client_name), MAX(v.meeting_date), 0, 0
                FROM visit_entries v
                WHERE LOWER(v.client_name) LIKE %s ESCAPE '\\' {_visit_scope_sql(access)}
                GROUP BY TRIM(v.client_name)
            ) x GROUP BY LOWER(name) ORDER BY MAX(src) DESC, SUM(total) DESC, MIN(name) LIMIT %s
            """,
            params + [like, like] + _visit_scope_params(access) + [limit],
        )
        rows = cur.fetchall()
    return {"customers": [
        {"name": r[0], "last_activity": r[1], "total_qty": round(float(r[2] or 0), 2), "has_sales": bool(r[3])}
        for r in rows if r[0]
    ]}


def _visit_scope_sql(access: Access, alias: str = "v") -> str:
    # members first: same exact rule as V1 /api/visit-entries, whatever scopes exist
    if access.role == "user":
        return f" AND ({alias}.created_by = %s OR {alias}.sales_person = %s)"
    if access.org_wide:
        return ""
    return f" AND LOWER(TRIM({alias}.team)) = ANY(%s)"


def _visit_scope_params(access: Access) -> list:
    if access.role == "user":
        return [access.username, access.username]
    if access.org_wide:
        return []
    return [[t.strip().lower() for t in (access.team_names or [])]]


@router.get("/customers/360")
def customer_360(name: str, access: Access = Depends(get_access)):
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Customer name required")
    team_list, _ = _team_filter(access, "")
    if access.role == "user":
        where, params = _where(team_list, salesperson=access.username, client=name, exact_person=True)
    else:
        where, params = _where(team_list, client=name)

    with transaction() as cur:
        cur.execute(
            f"""WITH b AS ({_BASE} {where})
                SELECT y, m, SUM(qty), SUM(amt) FROM b WHERE y IS NOT NULL GROUP BY y, m ORDER BY y, m""",
            params,
        )
        ym = [(int(y), int(m or 0), float(q or 0), float(a or 0)) for y, m, q, a in cur.fetchall()]

        cur.execute(
            f"""WITH b AS ({_BASE} {where})
                SELECT product, y, SUM(qty), SUM(amt) FROM b GROUP BY product, y""",
            params,
        )
        prod_rows = cur.fetchall()

        cur.execute(
            f"""WITH b AS ({_BASE} {where})
                SELECT sales_person, team, SUM(qty), MAX(y * 100 + m) FROM b GROUP BY sales_person, team
                ORDER BY 4 DESC, 3 DESC""",
            params,
        )
        people = [{"sales_person": r[0], "team": r[1], "qty": round(float(r[2] or 0), 2)} for r in cur.fetchall()]

        cur.execute(
            f"SELECT MIN(s.entry_date), MAX(s.entry_date), COUNT(*) FROM sales_entries s {where}",
            params,
        )
        first_date, last_date, line_count = cur.fetchone()

        cur.execute(
            f"""SELECT v.id, v.meeting_date, v.meeting_time, v.meeting_type, v.meeting_status, v.sales_person,
                       v.team, v.product, v.client_response, v.notes, v.next_meeting_date, v.order_amount, v.quantity
                FROM visit_entries v
                WHERE LOWER(TRIM(v.client_name)) = LOWER(TRIM(%s)) {_visit_scope_sql(access)}
                ORDER BY v.meeting_date DESC, v.meeting_time DESC, v.id DESC LIMIT 30""",
            [name] + _visit_scope_params(access),
        )
        vcols = ["id", "meeting_date", "meeting_time", "meeting_type", "meeting_status", "sales_person", "team",
                 "product", "client_response", "notes", "next_meeting_date", "order_amount", "quantity"]
        visits = [dict(zip(vcols, r)) for r in cur.fetchall()]
        cur.execute(
            f"""SELECT COUNT(*), MIN(CASE WHEN v.next_meeting_date ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}'
                                         AND v.next_meeting_date >= %s THEN v.next_meeting_date END)
                FROM visit_entries v
                WHERE LOWER(TRIM(v.client_name)) = LOWER(TRIM(%s)) {_visit_scope_sql(access)}""",
            [_today().isoformat(), name] + _visit_scope_params(access),
        )
        visit_total, next_fu = cur.fetchone()

    if not ym and not visits:
        raise HTTPException(status_code=404, detail="Customer not found in your scope")

    years = sorted({y for y, *_ in ym})
    by_year = {y: {"year": y, "qty": 0.0, "amount": 0.0} for y in years}
    for y, m, q, a in ym:
        by_year[y]["qty"] += q
        by_year[y]["amount"] += a
    yearly = []
    for y in years:
        prev = by_year.get(y - 1)
        yearly.append({"year": y, "qty": round(by_year[y]["qty"], 2), "amount": round(by_year[y]["amount"], 2),
                       "growth_pct": _growth(by_year[y]["qty"], prev["qty"] if prev else None)})

    # last 24 months series
    month_map = {(y, m): (q, a) for y, m, q, a in ym}
    today = _today()
    series = []
    yy, mm = today.year, today.month
    for _ in range(24):
        q, a = month_map.get((yy, mm), (0.0, 0.0))
        series.append({"label": f"{MONTHS[mm - 1]} {str(yy)[2:]}", "qty": round(q, 2), "amount": round(a, 2)})
        mm -= 1
        if mm == 0:
            yy, mm = yy - 1, 12
    series.reverse()

    products: Dict[str, Dict] = {}
    for p, y, q, a in prod_rows:
        if not p:
            continue
        item = products.setdefault(p, {"name": p, "qty": 0.0, "amount": 0.0, "years": {}})
        item["qty"] += float(q or 0)
        item["amount"] += float(a or 0)
        item["years"][str(y)] = round(float(q or 0), 2)
    product_list = sorted(products.values(), key=lambda x: x["qty"], reverse=True)
    for p in product_list:
        p["qty"], p["amount"] = round(p["qty"], 2), round(p["amount"], 2)

    cy = today.year
    bought_this = any(y == cy for y in years)
    bought_last = any(y == cy - 1 for y in years)
    if bought_this and not bought_last and len(years) == 1:
        status = "new"
    elif bought_this:
        status = "active"
    elif bought_last:
        status = "at_risk"
    elif years:
        status = "lost"
    else:
        status = "prospect"

    return {
        "name": name,
        "status": status,
        "first_purchase": first_date,
        "last_purchase": last_date,
        "sales_lines": int(line_count or 0),
        "total_qty": round(sum(y["qty"] for y in yearly), 2),
        "total_amount": round(sum(y["amount"] for y in yearly), 2),
        "yearly": yearly,
        "monthly_24": series,
        "products": product_list[:15],
        "salespersons": people[:10],
        "visits": visits,
        "visit_count": int(visit_total or 0),
        "last_visit": visits[0]["meeting_date"] if visits else None,
        "next_followup": next_fu,
    }


# =============================================================== visit planner
CLOSED_STATUSES = {"order received", "rejected", "closed"}


@router.get("/visits/planner")
def visit_planner(
    start: Optional[date] = None,
    days: int = 7,
    sales_person: str = "",
    access: Access = Depends(get_access),
):
    """Week view + follow-up queues built from visit_entries (scoped like /api/visit-entries)."""
    today = _today()
    start = start or (today - timedelta(days=today.weekday()))  # Monday
    days = max(1, min(int(days), 31))
    end = start + timedelta(days=days - 1)
    horizon = today + timedelta(days=14)
    lookback = today - timedelta(days=120)

    scope_sql = _visit_scope_sql(access)
    scope_params = _visit_scope_params(access)
    sp_sql, sp_params = "", []
    if sales_person.strip() and access.role != "user":
        sp_sql = " AND LOWER(TRIM(v.sales_person)) = LOWER(TRIM(%s))"
        sp_params = [sales_person.strip()]

    cols = ["id", "meeting_date", "meeting_time", "meeting_type", "meeting_status", "sales_person", "team",
            "client_name", "product", "client_response", "notes", "next_meeting_date", "next_meeting_time",
            "order_amount", "quantity", "created_by"]
    sel = ", ".join(f"v.{c}" for c in cols)

    with transaction() as cur:
        cur.execute(
            f"""SELECT {sel} FROM visit_entries v
                WHERE v.meeting_date >= %s AND v.meeting_date <= %s {scope_sql} {sp_sql}
                ORDER BY v.meeting_date, v.meeting_time, v.id""",
            [start.isoformat(), end.isoformat()] + scope_params + sp_params,
        )
        week = [dict(zip(cols, r)) for r in cur.fetchall()]

        # every visit that asked for a follow-up recently, plus later visits to detect completion
        cur.execute(
            f"""SELECT {sel} FROM visit_entries v
                WHERE v.next_meeting_date ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}'
                  AND v.next_meeting_date >= %s AND v.next_meeting_date <= %s {scope_sql} {sp_sql}
                ORDER BY v.next_meeting_date, v.id""",
            [lookback.isoformat(), horizon.isoformat()] + scope_params + sp_params,
        )
        fu = [dict(zip(cols, r)) for r in cur.fetchall()]

        cur.execute(
            f"""SELECT LOWER(TRIM(v.client_name)), LOWER(TRIM(v.sales_person)), MAX(v.meeting_date)
                FROM visit_entries v WHERE v.meeting_date >= %s {scope_sql} {sp_sql}
                GROUP BY 1, 2""",
            [lookback.isoformat()] + scope_params + sp_params,
        )
        latest_visit = {(c, s): d for c, s, d in cur.fetchall()}

        cur.execute(
            f"""SELECT DISTINCT v.sales_person FROM visit_entries v
                WHERE v.meeting_date >= %s {scope_sql} ORDER BY 1""",
            [lookback.isoformat()] + scope_params,
        )
        people = [r[0] for r in cur.fetchall() if r[0]]

    # A follow-up is "done" if the same salesperson visited the same client on/after it was requested
    due_today, upcoming, overdue = [], [], []
    seen = set()
    for v in fu:
        key = (str(v["client_name"] or "").strip().lower(), str(v["sales_person"] or "").strip().lower())
        if str(v.get("meeting_status") or "").strip().lower() in CLOSED_STATUSES:
            continue
        last = latest_visit.get(key)
        if last and str(last) > str(v["meeting_date"]):
            continue  # client was visited again after this follow-up was set
        if (key, v["next_meeting_date"]) in seen:
            continue
        seen.add((key, v["next_meeting_date"]))
        nd = str(v["next_meeting_date"])[:10]
        if nd < today.isoformat():
            v["days_overdue"] = (today - date.fromisoformat(nd)).days
            overdue.append(v)
        elif nd == today.isoformat():
            due_today.append(v)
        else:
            upcoming.append(v)
    overdue.sort(key=lambda v: -v["days_overdue"])

    by_day = []
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        items = [v for v in week if str(v["meeting_date"])[:10] == d]
        by_day.append({
            "date": d,
            "visits": items,
            "count": len(items),
            "closed": sum(1 for v in items if str(v.get("meeting_status") or "").lower() in CLOSED_STATUSES),
        })

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "today": today.isoformat(),
        "days": by_day,
        "summary": {
            "visits_in_range": len(week),
            "visits_today": sum(1 for v in week if str(v["meeting_date"])[:10] == today.isoformat()),
            "orders_in_range": sum(1 for v in week if str(v.get("meeting_status") or "").lower() == "order received"),
            "followups_due_today": len(due_today),
            "followups_upcoming": len(upcoming),
            "followups_overdue": len(overdue),
        },
        "due_today": due_today,
        "upcoming": upcoming,
        "overdue": overdue[:100],
        "sales_people": people if access.role != "user" else [access.username],
    }
