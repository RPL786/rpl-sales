"""Today's list for salespeople, and the Boss morning report.

Today's list (GET /api/v2/today) answers "who should I visit today?":
  1. follow-ups that are overdue
  2. follow-ups due today and visits planned for today
  3. regular customers who have gone quiet (bought in 2+ months of the last year,
     nothing for 45+ days, not visited in the last 14 days)
Each item is marked done once the customer has a visit logged today.

The morning report (build_morning_report) is an org-wide summary for the Boss,
returned as data plus ready-to-send text. The external agent fetches it at 8 AM.
"""
from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, timedelta
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends

from .analytics import _BASE, _today, _visit_scope_params, _visit_scope_sql, _where, visit_planner
from .db import transaction
from .permissions import Access, get_access, norm

router = APIRouter(prefix="/api/v2", tags=["v2-today"])

QUIET_AFTER_DAYS = 45
RECENT_VISIT_DAYS = 14

_DATED = f"""
    SELECT b.*, make_date(b.y, b.m, LEAST(GREATEST(b.d, 1), 28)) AS dt
    FROM ({_BASE} __WHERE__) b
    WHERE b.y IS NOT NULL AND b.m IS NOT NULL
"""


def _day(iso: str) -> str:
    try:
        return date.fromisoformat(str(iso)[:10]).strftime("%d %b")
    except ValueError:
        return str(iso)


def _fmt(v: float) -> str:
    v = float(v or 0)
    return f"{v:,.0f}" if abs(v) >= 100 or v == int(v) else f"{v:,.2f}"


def _quiet_customers(cur, access: Access, person: str, today: date, limit: int) -> List[Dict]:
    if access.role == "user":
        where, params = _where(None, access.username, exact_person=True)
    else:
        teams = None if access.org_wide else sorted(access.team_names or [])
        where, params = _where(teams, person)
    since = today - timedelta(days=365)
    cur.execute(
        f"""
        WITH s AS ({_DATED.replace("__WHERE__", where)}),
        c AS (
            SELECT LOWER(TRIM(client_name)) AS k,
                   MAX(dt) AS last_dt,
                   COUNT(DISTINCT (y * 12 + m)) FILTER (WHERE dt >= %s) AS months,
                   SUM(qty) FILTER (WHERE dt >= %s) AS qty12
            FROM s WHERE TRIM(COALESCE(client_name, '')) <> ''
            GROUP BY 1
        ),
        latest AS (
            SELECT DISTINCT ON (LOWER(TRIM(client_name)))
                   LOWER(TRIM(client_name)) AS k, TRIM(client_name) AS name, sales_person, team, product
            FROM s WHERE TRIM(COALESCE(client_name, '')) <> ''
            ORDER BY LOWER(TRIM(client_name)), dt DESC, qty DESC
        )
        SELECT l.name, l.sales_person, l.team, l.product, c.last_dt, c.months, c.qty12
        FROM c JOIN latest l ON l.k = c.k
        WHERE c.months >= 2 AND c.last_dt <= %s AND c.last_dt >= %s
        ORDER BY c.qty12 DESC NULLS LAST
        LIMIT %s
        """,
        params + [since, since, today - timedelta(days=QUIET_AFTER_DAYS), since, limit * 3],
    )
    return [
        {"client_name": r[0], "sales_person": r[1], "team": r[2], "product": r[3], "last_order": r[4],
         "months": int(r[5] or 0), "qty12": float(r[6] or 0)}
        for r in cur.fetchall()
    ]


def _recent_visits(cur, access: Access, person: str, since: date) -> Dict[str, str]:
    scope_sql, scope_params = _visit_scope_sql(access), _visit_scope_params(access)
    sp_sql, sp_params = "", []
    if person and access.role != "user":
        sp_sql, sp_params = " AND LOWER(TRIM(v.sales_person)) = LOWER(TRIM(%s))", [person]
    cur.execute(
        f"""SELECT LOWER(TRIM(v.client_name)), MAX(LEFT(v.meeting_date, 10)) FROM visit_entries v
            WHERE LEFT(v.meeting_date, 10) >= %s {scope_sql} {sp_sql} GROUP BY 1""",
        [since.isoformat()] + scope_params + sp_params,
    )
    return {k: d for k, d in cur.fetchall() if k}


@router.get("/today")
def today_list(sales_person: str = "", access: Access = Depends(get_access)):
    today = _today()
    person = "" if access.role == "user" else (sales_person or "").strip()
    plan = visit_planner(start=today, days=1, sales_person=person, access=access)

    with transaction() as cur:
        visited = _recent_visits(cur, access, person, today - timedelta(days=RECENT_VISIT_DAYS))
        quiet = _quiet_customers(cur, access, person, today, limit=12 if access.role == "user" else 20)

    today_iso = today.isoformat()
    items: List[Dict] = []
    seen = set()

    def add(kind: str, v: Dict, reason: str, detail: str = "", priority: int = 0):
        key = norm(v.get("client_name"))
        if not key or (key, norm(v.get("sales_person"))) in seen:
            return
        seen.add((key, norm(v.get("sales_person"))))
        items.append({
            "kind": kind,
            "client_name": v.get("client_name"),
            "sales_person": v.get("sales_person"),
            "team": v.get("team"),
            "product": (v.get("product") or "").split(",")[0].strip(),
            "reason": reason,
            "detail": detail,
            "priority": priority,
            "done": visited.get(key) == today_iso,
        })

    for v in plan["overdue"]:
        d = v.get("days_overdue", 0)
        add("overdue", v, f"Follow-up {d} day{'s' if d != 1 else ''} late",
            " · ".join(x for x in [v.get("meeting_status"), v.get("client_response") or v.get("notes")] if x), 0)
    for v in plan["due_today"]:
        add("followup", v, "Follow-up due today",
            " · ".join(x for x in [v.get("meeting_status"), v.get("client_response") or v.get("notes")] if x), 1)
    for day in plan["days"]:
        if day["date"] != today_iso:
            continue
        for v in day["visits"]:
            if str(v.get("meeting_type") or "").lower().startswith("future"):
                add("planned", v, f"Planned for {str(v.get('meeting_time') or '')[:5] or 'today'}", v.get("notes") or "", 2)

    quiet_added = 0
    for q in quiet:
        last_visit = visited.get(norm(q["client_name"]))
        if last_visit and last_visit != today_iso:
            continue  # visited in the last two weeks: give it time
        days = (today - q["last_order"]).days
        usual = round(365 / q["months"]) if q["months"] >= 3 else None
        reason = f"No order for {days} days"
        detail = f"Bought in {q['months']} months of the last year ({_fmt(q['qty12'])} qty)"
        if usual:
            detail += f" · usually every ~{usual} days"
        before = len(items)
        add("quiet", q, reason, detail, 3)
        if len(items) > before:
            items[-1]["last_order"] = q["last_order"].isoformat()
            quiet_added += 1
        if quiet_added >= (8 if access.role == "user" else 15):
            break

    items.sort(key=lambda i: (i["done"], i["priority"]))
    open_items = [i for i in items if not i["done"]]
    return {
        "today": today_iso,
        "sales_person": access.username if access.role == "user" else person,
        "people": plan["sales_people"],
        "summary": {
            "total": len(items),
            "open": len(open_items),
            "done": len(items) - len(open_items),
            "overdue": sum(1 for i in open_items if i["kind"] == "overdue"),
            "followups": sum(1 for i in open_items if i["kind"] in {"followup", "planned"}),
            "quiet": sum(1 for i in open_items if i["kind"] == "quiet"),
        },
        "items": items,
    }


# ---------------------------------------------------------------------------
# Boss morning report
# ---------------------------------------------------------------------------

class _OrgAccess:
    """Org-wide read access for the morning report (no user involved)."""
    role = "super_user"
    org_wide = True
    team_names: list = []
    username = "morning-report"
    user_id = None
    home_team = ""

    def allows_team(self, team: str) -> bool:
        return True

    def can(self, cap: str) -> bool:
        return False


def build_morning_report(report_day: Optional[date] = None) -> Dict:
    """Summary of yesterday + month progress for the whole organisation."""
    from .home import _progress, _targets  # local import: home imports analytics too

    today = report_day or _today()
    yesterday = today - timedelta(days=1)
    access = _OrgAccess()
    month_start = today.replace(day=1)
    dim = calendar.monthrange(today.year, today.month)[1]

    with transaction() as cur:
        cur.execute("SELECT MAX(LEFT(entry_date, 10)) FROM sales_entries WHERE entry_date ~ '^\\d{4}-\\d{2}-\\d{2}'")
        latest_sales = cur.fetchone()[0]

        cur.execute(
            """SELECT team, SUM(COALESCE(quantity, 0)), SUM(COALESCE(amount, 0)), COUNT(*)
               FROM sales_entries WHERE LEFT(entry_date, 10) = %s GROUP BY team ORDER BY 2 DESC""",
            (yesterday.isoformat(),),
        )
        y_teams = [{"team": t, "qty": float(q or 0), "amount": float(a or 0), "lines": int(n)} for t, q, a, n in cur.fetchall()]

        cur.execute(
            """SELECT sales_person, SUM(COALESCE(quantity, 0)) FROM sales_entries
               WHERE LEFT(entry_date, 10) = %s GROUP BY 1 ORDER BY 2 DESC LIMIT 3""",
            (yesterday.isoformat(),),
        )
        y_top = [{"sales_person": p, "qty": float(q or 0)} for p, q in cur.fetchall()]

        cur.execute("SELECT name, UPPER(COALESCE(target_type, 'QTY')) FROM teams ORDER BY name")
        teams = [(n, t) for n, t in cur.fetchall() if n]
        # targets are counted up to the report day
        tg = _targets(cur, teams, today)

        cur.execute(
            """SELECT sales_person, team, COUNT(*),
                      SUM(CASE WHEN LOWER(meeting_status) = 'order received' THEN 1 ELSE 0 END)
               FROM visit_entries WHERE LEFT(meeting_date, 10) = %s GROUP BY 1, 2 ORDER BY 3 DESC""",
            (yesterday.isoformat(),),
        )
        y_visits = [{"sales_person": p, "team": t, "visits": int(n), "orders": int(o or 0)} for p, t, n, o in cur.fetchall()]

        # active field people (visited in the last 30 days) with no visit in the last 3 days
        cur.execute(
            """SELECT sales_person, MAX(LEFT(meeting_date, 10)) FROM visit_entries
               WHERE LEFT(meeting_date, 10) >= %s AND LEFT(meeting_date, 10) <= %s
               GROUP BY 1 HAVING MAX(LEFT(meeting_date, 10)) < %s ORDER BY 2""",
            ((today - timedelta(days=30)).isoformat(), today.isoformat(), (today - timedelta(days=3)).isoformat()),
        )
        no_visits = [{"sales_person": p, "last_visit": d} for p, d in cur.fetchall() if p]

        quiet = _quiet_customers(cur, access, "", today, limit=5)

    plan = visit_planner(start=today, days=1, sales_person="", access=access)

    team_rows = []
    for t in tg["teams"]:
        if not t["target"]:
            continue
        p = _progress(t["achieved"], t["target"], today)
        team_rows.append({**t, **{k: p[k] for k in ("expected_by_today", "required_per_day", "projected_pct", "status")}})
    behind = [t for t in team_rows if t["status"] in {"behind", "close"}]
    behind.sort(key=lambda t: t["pct"] or 0)

    y_qty = sum(t["qty"] for t in y_teams)
    y_amt = sum(t["amount"] for t in y_teams)
    stale = bool(latest_sales) and latest_sales < yesterday.isoformat()

    # ---- text (WhatsApp friendly: short lines, *bold*) ----------------------
    L: List[str] = [f"*RPL Sales — Morning report, {today.strftime('%a %d %b %Y')}*", ""]
    L.append(f"*Yesterday ({yesterday.strftime('%d %b')})*")
    if y_teams:
        L.append(f"Sales: {_fmt(y_qty)} qty" + (f" · Rs {_fmt(y_amt)}" if y_amt else ""))
        for t in y_teams[:6]:
            L.append(f"• {t['team']}: {_fmt(t['qty'])}")
        if y_top:
            L.append("Top: " + ", ".join(f"{p['sales_person']} ({_fmt(p['qty'])})" for p in y_top))
    else:
        L.append("No sales lines recorded for yesterday.")
    if stale:
        L.append(f"⚠ Sales data was last updated for {latest_sales} — import the latest Excel for a full picture.")
    v_total = sum(v["visits"] for v in y_visits)
    o_total = sum(v["orders"] for v in y_visits)
    L.append(f"Visits: {v_total}" + (f" ({o_total} orders)" if o_total else "")
             + (f" by {len(y_visits)} people" if y_visits else ""))
    L.append("")

    L.append(f"*{today.strftime('%B')} target — day {today.day} of {dim}*")
    if team_rows:
        for t in sorted(team_rows, key=lambda r: -(r["pct"] or 0)):
            unit = "Rs " if t["unit"] == "AMOUNT" else ""
            flag = {"done": "✅", "on_track": "🟢", "close": "🟡", "behind": "🔴"}.get(t["status"] or "", "")
            L.append(f"{flag} {t['team']}: {t['pct'] or 0:.0f}% ({unit}{_fmt(t['achieved'])} / {unit}{_fmt(t['target'])})")
        if behind:
            L.append("Behind pace: " + ", ".join(
                f"{t['team']} needs {'Rs ' if t['unit'] == 'AMOUNT' else ''}{_fmt(t['required_per_day'])}/day" for t in behind[:4]))
    else:
        L.append("No targets set for this month.")
    L.append("")

    if quiet:
        L.append("*Big customers gone quiet (45+ days)*")
        for q in quiet[:5]:
            L.append(f"• {q['client_name']} — last order {q['last_order'].strftime('%d %b')} ({q['sales_person']})")
        L.append("")
    if no_visits:
        L.append("*No visits for 3+ days*")
        L.append(", ".join(f"{p['sales_person']} (last {_day(p['last_visit'])})" for p in no_visits[:8]))
        L.append("")
    fu = plan["summary"]
    n_due = fu["followups_due_today"]
    L.append(f"*Today*: {n_due} follow-up{'s' if n_due != 1 else ''} due, {fu['followups_overdue']} overdue.")

    return {
        "date": today.isoformat(),
        "yesterday": yesterday.isoformat(),
        "latest_sales_date": latest_sales,
        "sales_data_stale": stale,
        "yesterday_sales": {"qty": round(y_qty, 2), "amount": round(y_amt, 2), "by_team": y_teams, "top_people": y_top},
        "yesterday_visits": {"total": v_total, "orders": o_total, "by_person": y_visits},
        "month_targets": team_rows,
        "teams_behind": [t["team"] for t in behind],
        "quiet_customers": [{**q, "last_order": q["last_order"].isoformat()} for q in quiet[:5]],
        "people_without_visits": no_visits,
        "followups": {"due_today": fu["followups_due_today"], "overdue": fu["followups_overdue"]},
        "text": "\n".join(L).strip(),
    }
