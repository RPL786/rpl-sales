"""Role-based home page data: month target progress, run-rate, MTD/YTD comparison,
people who need attention, follow-ups and customers at risk.

Uses only V1 tables (sales_entries, sales_targets, user_team_history, teams, users,
visit_entries) and the same target rules as V1 /forecast:
  - a person's achievement = sales_entries.sales_person matching the username (case-insensitive)
  - a team's unit = teams.target_type (QTY or AMOUNT)
"""
from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends

from .analytics import MONTHS, _BASE, _today, _visit_scope_params, _visit_scope_sql, _where, visit_planner
from .db import transaction
from .permissions import ROLE_DEFS, Access, get_access, norm

router = APIRouter(prefix="/api/v2", tags=["v2-home"])


def _pct(a: float, b: float) -> Optional[float]:
    return round(a / b * 100, 1) if b else None


def _growth(cur: float, prev: float) -> Optional[float]:
    return round((cur - prev) / prev * 100, 1) if prev else None


def _scope_teams(cur, access: Access) -> List[tuple]:
    cur.execute("SELECT name, UPPER(COALESCE(target_type, 'QTY')) FROM teams ORDER BY name")
    rows = [(n, t) for n, t in cur.fetchall() if n]
    return [(n, t) for n, t in rows if access.allows_team(n)]


def _targets(cur, teams: List[tuple], today: date, only_user: Optional[str] = None) -> Dict:
    """Per team and per person: month target vs achieved, in the team's own unit."""
    if not teams:
        return {"teams": [], "people": []}
    year, mon = today.year, MONTHS[today.month - 1]
    start = f"{year:04d}-{today.month:02d}-01"
    end = f"{year:04d}-{today.month:02d}-{calendar.monthrange(year, today.month)[1]:02d}"
    names = [n for n, _ in teams]
    unit = {norm(n): t for n, t in teams}
    display = {norm(n): n for n, _ in teams}
    lower_names = [norm(n) for n in names]

    # members of each team during this month (target_applicable only, like V1 forecast)
    cur.execute(
        """
        SELECT LOWER(TRIM(h.team)), MIN(TRIM(h.username)), LOWER(TRIM(h.username))
        FROM user_team_history h
        LEFT JOIN users u ON LOWER(TRIM(u.username)) = LOWER(TRIM(h.username))
        WHERE LOWER(TRIM(h.team)) = ANY(%s)
          AND h.start_date <= %s AND COALESCE(h.end_date, '9999-12-31') >= %s
          AND COALESCE(u.target_applicable, TRUE) = TRUE
          AND COALESCE(u.is_active, TRUE) = TRUE
        GROUP BY 1, 3
        """,
        (lower_names, end, start),
    )
    members = defaultdict(dict)
    for t, uname, key in cur.fetchall():
        members[t][key] = uname

    cur.execute(
        """
        SELECT LOWER(TRIM(team)), LOWER(TRIM(username)), UPPER(COALESCE(target_type, 'QTY')),
               SUM(COALESCE(NULLIF(target_value, 0), target_kg, 0))
        FROM sales_targets
        WHERE LOWER(TRIM(team)) = ANY(%s) AND target_year = %s AND target_month = %s
        GROUP BY 1, 2, 3
        """,
        (lower_names, year, mon),
    )
    target = defaultdict(float)
    for t, key, ttype, v in cur.fetchall():
        if ttype == unit.get(t, "QTY"):
            target[(t, key)] += float(v or 0)

    cur.execute(
        """
        SELECT LOWER(TRIM(team)), LOWER(TRIM(sales_person)), SUM(COALESCE(quantity, 0)), SUM(COALESCE(amount, 0))
        FROM sales_entries
        WHERE LOWER(TRIM(team)) = ANY(%s) AND year = %s AND initcap(left(trim(month), 3)) = %s
        GROUP BY 1, 2
        """,
        (lower_names, year, mon),
    )
    achieved = defaultdict(lambda: [0.0, 0.0])
    team_total = defaultdict(lambda: [0.0, 0.0])
    for t, key, q, a in cur.fetchall():
        achieved[(t, key)] = [float(q or 0), float(a or 0)]
        team_total[t][0] += float(q or 0)
        team_total[t][1] += float(a or 0)

    team_rows, people = [], []
    for t in lower_names:
        u = unit.get(t, "QTY")
        idx = 1 if u == "AMOUNT" else 0
        t_target = 0.0
        for key, uname in members.get(t, {}).items():
            if only_user and key != norm(only_user):
                continue
            tg = target.get((t, key), 0.0)
            ach = achieved.get((t, key), [0.0, 0.0])[idx]
            t_target += tg
            people.append({"username": uname, "team": display[t], "unit": u, "target": round(tg, 2),
                           "achieved": round(ach, 2), "pct": _pct(ach, tg)})
        if only_user:
            continue
        ach_team = team_total[t][idx]
        team_rows.append({"team": display[t], "unit": u, "target": round(t_target, 2),
                          "achieved": round(ach_team, 2), "pct": _pct(ach_team, t_target)})
    return {"teams": team_rows, "people": people}


def _progress(achieved: float, target: float, today: date) -> Dict:
    dim = calendar.monthrange(today.year, today.month)[1]
    elapsed = today.day
    remaining_days = max(dim - today.day + 1, 1)  # today still counts
    expected = target * elapsed / dim if target else 0
    pace = achieved / elapsed if elapsed else 0
    projected = pace * dim
    return {
        "target": round(target, 2),
        "achieved": round(achieved, 2),
        "pct": _pct(achieved, target),
        "remaining": round(max(target - achieved, 0), 2),
        "required_per_day": round(max(target - achieved, 0) / remaining_days, 2) if target else None,
        "current_per_day": round(pace, 2),
        "projected": round(projected, 2),
        "projected_pct": _pct(projected, target),
        "expected_by_today": round(expected, 2),
        "status": None if not target else ("done" if achieved >= target else
                                           "on_track" if projected >= target else
                                           "close" if projected >= 0.9 * target else "behind"),
    }


def _mtd_ytd(cur, access: Access, teams: List[str], today: date, salesperson: str = "") -> Dict:
    team_list = None if access.org_wide and not salesperson else teams
    where, params = _where(team_list, salesperson, exact_person=bool(salesperson))
    y, m, d = today.year, today.month, today.day
    cur.execute(
        f"""WITH b AS ({_BASE} {where})
            SELECT
              SUM(CASE WHEN y = %s AND m = %s AND d <= %s THEN qty END),
              SUM(CASE WHEN y = %s AND m = %s AND d <= %s THEN qty END),
              SUM(CASE WHEN y = %s AND (m < %s OR (m = %s AND d <= %s)) THEN qty END),
              SUM(CASE WHEN y = %s AND (m < %s OR (m = %s AND d <= %s)) THEN qty END),
              SUM(CASE WHEN y = %s AND m = %s AND d <= %s THEN amt END),
              SUM(CASE WHEN y = %s AND m = %s AND d <= %s THEN amt END)
            FROM b""",
        params + [y, m, d, y - 1, m, d, y, m, m, d, y - 1, m, m, d, y, m, d, y - 1, m, d],
    )
    r = [float(v or 0) for v in cur.fetchone()]
    return {
        "month_label": f"1–{d} {MONTHS[m - 1]}",
        "mtd_qty": round(r[0], 2), "mtd_qty_ly": round(r[1], 2), "mtd_growth": _growth(r[0], r[1]),
        "ytd_qty": round(r[2], 2), "ytd_qty_ly": round(r[3], 2), "ytd_growth": _growth(r[2], r[3]),
        "mtd_amount": round(r[4], 2), "mtd_amount_ly": round(r[5], 2),
    }


def _at_risk(cur, access: Access, teams: List[str], today: date, salesperson: str = "", limit: int = 6) -> Dict:
    """Customers who bought last year but nothing yet this year."""
    team_list = None if access.org_wide and not salesperson else teams
    where, params = _where(team_list, salesperson, exact_person=bool(salesperson))
    cur.execute(
        f"""WITH b AS ({_BASE} {where}),
            c AS (
              SELECT LOWER(TRIM(client_name)) AS k, MIN(TRIM(client_name)) AS name,
                     SUM(CASE WHEN y = %s THEN qty ELSE 0 END) AS ly,
                     SUM(CASE WHEN y = %s THEN qty ELSE 0 END) AS ty
              FROM b WHERE client_name IS NOT NULL AND TRIM(client_name) <> '' GROUP BY 1)
            SELECT name, ly FROM c WHERE ly > 0 AND ty = 0 ORDER BY ly DESC""",
        params + [today.year - 1, today.year],
    )
    rows = cur.fetchall()
    return {"count": len(rows), "top": [{"name": n, "last_year_qty": round(float(q or 0), 2)} for n, q in rows[:limit]]}


@router.get("/home")
def home(access: Access = Depends(get_access)):
    today = _today()
    dim = calendar.monthrange(today.year, today.month)[1]
    kind = "member" if access.role == "user" else ("leader" if access.role == "team_leader" else "manager")

    with transaction() as cur:
        teams = _scope_teams(cur, access)
        team_names = [n for n, _ in teams]
        if kind == "member":
            tg = _targets(cur, [t for t in teams if norm(t[0]) == norm(access.home_team)] or teams[:0], today,
                          only_user=access.username)
        else:
            tg = _targets(cur, teams, today)

        # combined target progress, kept separate per unit (bags vs rupees never mixed)
        units: Dict[str, Dict] = {}
        source = tg["people"] if kind == "member" else tg["teams"]
        for row in source:
            if not row["target"]:
                continue  # teams/people without a target would inflate achievement
            u = units.setdefault(row["unit"], {"target": 0.0, "achieved": 0.0})
            u["target"] += row["target"]
            u["achieved"] += row["achieved"]
        progress = [{"unit": u, **_progress(v["achieved"], v["target"], today)} for u, v in sorted(units.items())]

        sp = access.username if kind == "member" else ""
        sales = _mtd_ytd(cur, access, team_names, today, salesperson=sp)
        risk = _at_risk(cur, access, team_names, today, salesperson=sp)

    planner = visit_planner(start=None, days=7, sales_person="", access=access)

    people = [p for p in tg["people"] if p["target"] > 0]
    ranked = sorted(people, key=lambda p: (p["pct"] or 0), reverse=True)
    expected_pct = round(today.day / dim * 100, 1)

    return {
        "kind": kind,
        "username": access.username,
        "role_label": ROLE_DEFS.get(access.role, {}).get("label", access.role),
        "home_team": access.home_team,
        "today": today.isoformat(),
        "month": {"name": MONTHS[today.month - 1], "year": today.year, "day": today.day, "days": dim,
                  "elapsed_pct": expected_pct, "days_left": dim - today.day + 1},
        "progress": progress,
        "teams": sorted(tg["teams"], key=lambda t: (t["pct"] is None, t["pct"] or 0)),
        "top_people": ranked[:5],
        "attention": [p for p in sorted(people, key=lambda p: p["pct"] or 0) if (p["pct"] or 0) < expected_pct][:5],
        "people_without_target": len([p for p in tg["people"] if p["target"] == 0]),
        "sales": sales,
        "at_risk": risk,
        "followups": {
            "overdue": planner["summary"]["followups_overdue"],
            "today": planner["summary"]["followups_due_today"],
            "upcoming": planner["summary"]["followups_upcoming"],
            "overdue_list": planner["overdue"][:5],
            "today_list": planner["due_today"][:5],
        },
        "visits_today": [d for d in planner["days"] if d["date"] == today.isoformat()][0]["visits"]
        if any(d["date"] == today.isoformat() for d in planner["days"]) else [],
        "visits_this_week": planner["summary"]["visits_in_range"],
    }


@router.get("/notifications")
def notifications(access: Access = Depends(get_access)):
    """Bell items derived from the Home data: follow-ups, people behind pace, own run-rate, customers at risk."""
    h = home(access)
    items = []
    fu = h["followups"]
    if fu["overdue"]:
        names = ", ".join(v["client_name"] for v in fu["overdue_list"][:3])
        items.append({"kind": "overdue", "level": "high", "tab": "planner",
                      "title": f"{fu['overdue']} overdue follow-up{'s' if fu['overdue'] != 1 else ''}",
                      "detail": names})
    if fu["today"]:
        names = ", ".join(v["client_name"] for v in fu["today_list"][:3])
        items.append({"kind": "today", "level": "medium", "tab": "planner",
                      "title": f"{fu['today']} follow-up{'s' if fu['today'] != 1 else ''} due today",
                      "detail": names})
    if h["kind"] != "member" and h["attention"]:
        names = ", ".join(p["username"] for p in h["attention"][:4])
        items.append({"kind": "behind", "level": "medium", "tab": "home",
                      "title": f"{len(h['attention'])} people behind this month's target pace",
                      "detail": names})
    for p in h["progress"]:
        if p["status"] in {"behind", "close"} and p["required_per_day"]:
            unit = "Rs " if p["unit"] == "AMOUNT" else ""
            items.append({"kind": "pace", "level": "medium", "tab": "home",
                          "title": f"Need {unit}{round(p['required_per_day']):,} per day to reach the {h['month']['name']} target",
                          "detail": f"{p['pct'] or 0:.0f}% done with {h['month']['days_left']} days left"})
    if h["at_risk"]["count"]:
        items.append({"kind": "risk", "level": "low", "tab": "home",
                      "title": f"{h['at_risk']['count']} customers bought last year but not yet this year",
                      "detail": ", ".join(c["name"] for c in h["at_risk"]["top"][:3])})
    return {"count": sum(1 for i in items if i["level"] in {"high", "medium"}), "items": items, "today": h["today"]}
