"""Visit date lock, unlock requests and leave.

Visit lock
  Field users may enter visits for today and the previous 2 working days (Sunday is not
  counted). Older dates need an unlock: the user requests it with a reason, and a
  City Coordinator (for teams in their scope) or a Super Admin approves it. An approved
  unlock opens that one date for that user for 24 hours.
  Not locked: Super Admin and City Coordinator entries, and "Future Scheduled" visits
  (planning an upcoming meeting). Visits saved on a phone without signal are judged by the
  time they were saved on the device (saved_at), not the time they reached the server.

Leave
  A user marks one day or a date range as leave with a reason. The leave always shows
  (calendar, reports) whatever its approval; Team Leader, City Coordinator or Super Admin
  can approve or reject it. Visits cannot be entered on a day the user marked as leave.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from . import audit
from .analytics import _today
from .db import transaction
from .permissions import Access, get_access, norm

router = APIRouter(prefix="/api/v2", tags=["v2-attendance"])

WINDOW_WORKING_DAYS = 2   # previous working days allowed besides today
UNLOCK_HOURS = 24
LOCK_EXEMPT_ROLES = {"admin", "city_coordinator"}
UNLOCK_APPROVER_ROLES = {"admin", "city_coordinator"}
LEAVE_APPROVER_ROLES = {"admin", "city_coordinator", "team_leader"}
LEAVE_REASONS = ["Sick", "Personal", "Family", "Training / office work", "Public holiday", "Other"]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def window_days(cur) -> int:
    """Previous working days open besides today: the admin setting, else the default."""
    try:
        cur.execute("SELECT value FROM app_settings WHERE key = 'visit_window_days'")
        row = cur.fetchone()
        if row and str(row[0]).isdigit():
            return max(0, min(int(row[0]), 60))
    except Exception:
        pass
    return WINDOW_WORKING_DAYS


def _is_exempt(cur, username: str) -> bool:
    cur.execute("SELECT 1 FROM visit_lock_exempt WHERE username_key = LOWER(TRIM(%s))", (username or "",))
    return cur.fetchone() is not None


def allowed_dates(today: date, n: Optional[int] = None) -> List[date]:
    """Today and every day back to the n-th previous working day (default WINDOW_WORKING_DAYS).

    Sundays are not counted towards the window, but a Sunday inside it stays open
    (someone who worked on Sunday can still log it)."""
    n = WINDOW_WORKING_DAYS if n is None else n
    out, d, working = [today], today, 0
    while working < n:
        d -= timedelta(days=1)
        out.append(d)
        if d.weekday() != 6:
            working += 1
    return out


def _parse_day(value: str, field: str = "date") -> date:
    try:
        return date.fromisoformat(str(value or "")[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must be YYYY-MM-DD")


def _device_day(saved_at: Optional[str], today: date) -> date:
    """Local day the visit was saved on the device; only trusted for the last 14 days."""
    if not saved_at:
        return today
    try:
        ts = datetime.fromisoformat(str(saved_at).replace("Z", "+00:00"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        local = ts.astimezone(timezone(timedelta(hours=5))).date()  # Pakistan, no DST
    except ValueError:
        return today
    if local > today or (today - local).days > 14:
        return today
    return local


def _user_row(cur, username: str):
    cur.execute(
        "SELECT id, username, COALESCE(team, ''), role FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s))",
        (username,),
    )
    return cur.fetchone()


def _active_unlock(cur, username: str, day: date) -> bool:
    cur.execute(
        """SELECT 1 FROM visit_unlocks
           WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s)) AND unlock_date = %s
             AND status = 'approved' AND expires_at > now() LIMIT 1""",
        (username, day.isoformat()),
    )
    return cur.fetchone() is not None


def _leave_on(cur, username: str, day: date) -> Optional[dict]:
    cur.execute(
        """SELECT id, reason_type, status FROM leaves
           WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s)) AND status <> 'cancelled'
             AND date_from <= %s AND date_to >= %s LIMIT 1""",
        (username, day.isoformat(), day.isoformat()),
    )
    r = cur.fetchone()
    return {"id": r[0], "reason_type": r[1], "status": r[2]} if r else None


def check_visit_date(cur, user: dict, sales_person: str, meeting_date: str, meeting_type: str,
                     saved_at: Optional[str] = None) -> None:
    """Raise 403 when this visit date is locked for the user. Called by the V1 visit endpoints."""
    role = str(user.get("role") or "")
    today = _today()
    day = _parse_day(meeting_date, "Meeting date")
    is_plan = str(meeting_type or "").strip().lower().startswith("future")
    if day > today:
        if is_plan or role in LOCK_EXEMPT_ROLES:
            return
        raise HTTPException(status_code=400,
                            detail="A visit date cannot be in the future. Use \"Future Scheduled\" to plan a meeting.")

    person = (sales_person or user.get("username") or "").strip()
    leave = _leave_on(cur, person, day)
    if leave:
        raise HTTPException(status_code=403,
                            detail=f"{day.isoformat()} is marked as leave for {person}. "
                                   "Cancel the leave first if they worked that day.")
    if role in LOCK_EXEMPT_ROLES:
        return
    if _is_exempt(cur, person) or _is_exempt(cur, str(user.get("username") or "")):
        return  # an Admin / City Coordinator turned the lock off for this person

    n = window_days(cur)
    basis = _device_day(saved_at, today)
    if day in allowed_dates(basis, n):
        return
    if _active_unlock(cur, person, day) or _active_unlock(cur, str(user.get("username") or ""), day):
        return
    raise HTTPException(
        status_code=403,
        detail=f"Visits for {day.isoformat()} are locked. You can enter visits for today and the previous "
               f"{n} working days. Request an unlock in Leave & Unlock.",
    )


def _can_decide_for(access: Access, team: str, roles: set) -> bool:
    if access.role not in roles:
        return False
    if access.role == "admin":
        return True
    if access.role == "team_leader":
        return norm(team) == norm(access.home_team)
    return access.allows_team(team)


def _can_view_team(access: Access, team: str) -> bool:
    if access.role == "user":
        return False
    return access.allows_team(team)


# ---------------------------------------------------------------------------
# lock status + unlock requests
# ---------------------------------------------------------------------------

@router.get("/visit-lock")
def lock_status(access: Access = Depends(get_access)):
    today = _today()
    with transaction() as cur:
        cur.execute(
            """SELECT id, unlock_date, reason, status, requested_at, decided_by, decided_at, expires_at, decision_note
               FROM visit_unlocks WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s))
               ORDER BY requested_at DESC LIMIT 30""",
            (access.username,),
        )
        mine = [_unlock_dict(r) for r in cur.fetchall()]
        n = window_days(cur)
        exempt = access.role in LOCK_EXEMPT_ROLES or _is_exempt(cur, access.username)
    return {
        "today": today.isoformat(),
        "exempt": exempt,
        "window_days": n,
        "allowed_dates": [d.isoformat() for d in allowed_dates(today, n)],
        "earliest_allowed": min(allowed_dates(today, n)).isoformat(),
        "unlock_hours": UNLOCK_HOURS,
        "open_unlocks": [u["unlock_date"] for u in mine if u["status"] == "approved" and u["active"]],
        "my_requests": mine,
    }


def _unlock_dict(r, extra: Optional[dict] = None) -> dict:
    now = datetime.now(timezone.utc)
    d = {
        "id": r[0], "unlock_date": str(r[1]), "reason": r[2], "status": r[3],
        "requested_at": r[4].isoformat() if r[4] else None, "decided_by": r[5],
        "decided_at": r[6].isoformat() if r[6] else None,
        "expires_at": r[7].isoformat() if r[7] else None, "decision_note": r[8],
        "active": bool(r[3] == "approved" and r[7] and r[7] > now),
    }
    if extra:
        d.update(extra)
    return d


class UnlockIn(BaseModel):
    date: str
    reason: str


@router.post("/visit-unlock/requests")
def request_unlock(payload: UnlockIn, access: Access = Depends(get_access)):
    day = _parse_day(payload.date)
    today = _today()
    reason = (payload.reason or "").strip()
    if len(reason) < 5:
        raise HTTPException(status_code=400, detail="Please write a short reason (at least 5 characters)")
    if day > today:
        raise HTTPException(status_code=400, detail="Future dates do not need an unlock")
    if (today - day).days > 120:
        raise HTTPException(status_code=400, detail="Unlocks can be requested for the last 120 days only")
    with transaction() as cur:
        if day in allowed_dates(today, window_days(cur)):
            raise HTTPException(status_code=400, detail="This date is already open for entry")
        row = _user_row(cur, access.username)
        team = row[2] if row else access.home_team
        cur.execute(
            """SELECT id, status FROM visit_unlocks WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s)) AND unlock_date = %s
                 AND (status = 'pending' OR (status = 'approved' AND expires_at > now()))""",
            (access.username, day.isoformat()),
        )
        existing = cur.fetchone()
        if existing:
            raise HTTPException(status_code=400, detail=f"There is already a {existing[1]} request for this date")
        cur.execute(
            """INSERT INTO visit_unlocks (user_id, username, team, unlock_date, reason, status)
               VALUES (%s, %s, %s, %s, %s, 'pending') RETURNING id""",
            (access.user_id, access.username, team, day.isoformat(), reason[:500]),
        )
        rid = cur.fetchone()[0]
        audit.record(cur, access, "visit.unlock_request", "visit_unlock", rid,
                     {"date": day.isoformat(), "reason": reason[:500], "team": team})
    return {"status": "ok", "id": rid}


@router.get("/visit-unlock/requests")
def list_unlock_requests(status: str = Query("pending", pattern="^(pending|approved|rejected|all)$"),
                         access: Access = Depends(get_access)):
    if access.role not in UNLOCK_APPROVER_ROLES and access.role not in {"super_user", "team_leader"}:
        raise HTTPException(status_code=403, detail="You do not have permission to view unlock requests")
    with transaction() as cur:
        cur.execute(
            """SELECT id, unlock_date, reason, status, requested_at, decided_by, decided_at, expires_at, decision_note,
                      username, team
               FROM visit_unlocks WHERE (%s = 'all' OR status = %s)
               ORDER BY (status = 'pending') DESC, requested_at DESC LIMIT 300""",
            (status, status),
        )
        rows = cur.fetchall()
    out = []
    for r in rows:
        if not _can_view_team(access, r[10]):
            continue
        out.append(_unlock_dict(r, {"username": r[9], "team": r[10],
                                    "can_decide": _can_decide_for(access, r[10], UNLOCK_APPROVER_ROLES)}))
    return {"requests": out}


class DecideIn(BaseModel):
    approve: bool
    note: str = ""


@router.post("/visit-unlock/requests/{rid}/decide")
def decide_unlock(rid: int, payload: DecideIn, access: Access = Depends(get_access)):
    with transaction() as cur:
        cur.execute("SELECT username, team, unlock_date, status FROM visit_unlocks WHERE id = %s FOR UPDATE", (rid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Request not found")
        username, team, day, status = row
        if not _can_decide_for(access, team, UNLOCK_APPROVER_ROLES):
            raise HTTPException(status_code=403, detail="Only a City Coordinator (for this team) or a Super Admin can unlock dates")
        if norm(username) == norm(access.username) and access.role != "admin":
            raise HTTPException(status_code=403, detail="You cannot approve your own request")
        if status != "pending":
            raise HTTPException(status_code=400, detail=f"This request is already {status}")
        new = "approved" if payload.approve else "rejected"
        cur.execute(
            """UPDATE visit_unlocks SET status = %s, decided_by = %s, decided_at = now(), decision_note = %s,
                      expires_at = CASE WHEN %s THEN now() + make_interval(hours => %s) ELSE NULL END
               WHERE id = %s""",
            (new, access.username, (payload.note or "").strip()[:300], payload.approve, UNLOCK_HOURS, rid),
        )
        audit.record(cur, access, f"visit.unlock_{new}", "visit_unlock", rid,
                     {"username": username, "date": str(day), "note": payload.note[:300]})
    return {"status": "ok", "result": new}


# ---------------------------------------------------------------------------
# leave
# ---------------------------------------------------------------------------

class LeaveIn(BaseModel):
    date_from: str
    date_to: str = ""
    reason_type: str
    note: str = ""
    sales_person: str = ""  # admin only: record leave for someone else


def _leave_dict(r, access: Access) -> dict:
    return {
        "id": r[0], "username": r[1], "team": r[2], "date_from": str(r[3]), "date_to": str(r[4]),
        "days": (r[4] - r[3]).days + 1 if r[3] and r[4] else 1,
        "reason_type": r[5], "note": r[6], "status": r[7], "decided_by": r[8],
        "decided_at": r[9].isoformat() if r[9] else None, "decision_note": r[10],
        "created_at": r[11].isoformat() if r[11] else None,
        "can_decide": r[7] == "pending" and _can_decide_for(access, r[2], LEAVE_APPROVER_ROLES)
                      and norm(r[1]) != norm(access.username),
        "can_cancel": norm(r[1]) == norm(access.username) and r[7] in {"pending", "rejected"} or access.role == "admin",
    }


_LEAVE_COLS = ("id, username, team, date_from, date_to, reason_type, note, status, decided_by, decided_at, "
               "decision_note, created_at")


@router.get("/leaves")
def list_leaves(mine: bool = False, status: str = Query("all", pattern="^(pending|approved|rejected|all)$"),
                date_from: str = "", date_to: str = "", access: Access = Depends(get_access)):
    sql = f"SELECT {_LEAVE_COLS} FROM leaves WHERE status <> 'cancelled'"
    params: list = []
    if mine or access.role == "user":
        sql += " AND LOWER(TRIM(username)) = LOWER(TRIM(%s))"
        params.append(access.username)
    if status != "all":
        sql += " AND status = %s"
        params.append(status)
    if date_from:
        sql += " AND date_to >= %s"
        params.append(_parse_day(date_from).isoformat())
    if date_to:
        sql += " AND date_from <= %s"
        params.append(_parse_day(date_to).isoformat())
    sql += " ORDER BY (status = 'pending') DESC, date_from DESC LIMIT 300"
    with transaction() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    out = [_leave_dict(r, access) for r in rows
           if mine or access.role == "user" or norm(r[1]) == norm(access.username) or _can_view_team(access, r[2])]
    return {"leaves": out, "reasons": LEAVE_REASONS}


@router.post("/leaves")
def add_leave(payload: LeaveIn, access: Access = Depends(get_access)):
    start = _parse_day(payload.date_from, "From date")
    end = _parse_day(payload.date_to or payload.date_from, "To date")
    if end < start:
        start, end = end, start
    if (end - start).days > 60:
        raise HTTPException(status_code=400, detail="A leave can be at most 60 days")
    today = _today()
    if (today - start).days > 60:
        raise HTTPException(status_code=400, detail="Leave can be added for the last 60 days only")
    reason_type = (payload.reason_type or "").strip()
    if reason_type not in LEAVE_REASONS:
        raise HTTPException(status_code=400, detail="Choose a reason")
    note = (payload.note or "").strip()
    if reason_type == "Other" and len(note) < 3:
        raise HTTPException(status_code=400, detail="Please describe the reason")

    person = access.username
    if payload.sales_person.strip() and norm(payload.sales_person) != norm(access.username):
        if access.role != "admin":
            raise HTTPException(status_code=403, detail="Only a Super Admin can add leave for someone else")
        person = payload.sales_person.strip()

    with transaction() as cur:
        row = _user_row(cur, person)
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        person, team = row[1], row[2]
        cur.execute(
            """SELECT date_from, date_to FROM leaves WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s))
                 AND status <> 'cancelled' AND date_from <= %s AND date_to >= %s LIMIT 1""",
            (person, end.isoformat(), start.isoformat()),
        )
        clash = cur.fetchone()
        if clash:
            raise HTTPException(status_code=400, detail=f"Leave already recorded for {clash[0]} to {clash[1]}")
        cur.execute(
            """SELECT LEFT(meeting_date, 10) FROM visit_entries
               WHERE (LOWER(TRIM(sales_person)) = LOWER(TRIM(%s)) OR LOWER(TRIM(created_by)) = LOWER(TRIM(%s)))
                 AND LEFT(meeting_date, 10) BETWEEN %s AND %s
                 AND LOWER(COALESCE(meeting_type, '')) NOT LIKE 'future%%'
               ORDER BY 1 LIMIT 1""",
            (person, person, start.isoformat(), end.isoformat()),
        )
        worked = cur.fetchone()
        if worked:
            raise HTTPException(status_code=400, detail=f"There are visits recorded on {worked[0]}; leave cannot cover that day")
        cur.execute(
            """INSERT INTO leaves (user_id, username, team, date_from, date_to, reason_type, note, status, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending', %s) RETURNING id""",
            (row[0], person, team, start.isoformat(), end.isoformat(), reason_type, note[:500], access.username),
        )
        lid = cur.fetchone()[0]
        audit.record(cur, access, "leave.add", "leave", lid,
                     {"username": person, "from": start.isoformat(), "to": end.isoformat(), "reason": reason_type})
    return {"status": "ok", "id": lid}


@router.post("/leaves/{lid}/decide")
def decide_leave(lid: int, payload: DecideIn, access: Access = Depends(get_access)):
    with transaction() as cur:
        cur.execute("SELECT username, team, status FROM leaves WHERE id = %s FOR UPDATE", (lid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Leave not found")
        username, team, status = row
        if not _can_decide_for(access, team, LEAVE_APPROVER_ROLES):
            raise HTTPException(status_code=403, detail="Only the Team Leader, City Coordinator or Super Admin can decide this leave")
        if norm(username) == norm(access.username) and access.role != "admin":
            raise HTTPException(status_code=403, detail="You cannot approve your own leave")
        if status not in {"pending", "approved", "rejected"}:
            raise HTTPException(status_code=400, detail=f"This leave is {status}")
        new = "approved" if payload.approve else "rejected"
        cur.execute(
            "UPDATE leaves SET status = %s, decided_by = %s, decided_at = now(), decision_note = %s WHERE id = %s",
            (new, access.username, (payload.note or "").strip()[:300], lid),
        )
        audit.record(cur, access, f"leave.{new}", "leave", lid, {"username": username, "note": payload.note[:300]})
    return {"status": "ok", "result": new}


@router.delete("/leaves/{lid}")
def cancel_leave(lid: int, access: Access = Depends(get_access)):
    with transaction() as cur:
        cur.execute("SELECT username, status FROM leaves WHERE id = %s FOR UPDATE", (lid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Leave not found")
        if access.role != "admin":
            if norm(row[0]) != norm(access.username):
                raise HTTPException(status_code=403, detail="You can cancel only your own leave")
            if row[1] == "approved":
                raise HTTPException(status_code=400, detail="An approved leave can be cancelled by a Super Admin only")
        cur.execute("UPDATE leaves SET status = 'cancelled' WHERE id = %s", (lid,))
        audit.record(cur, access, "leave.cancel", "leave", lid, {"username": row[0]})
    return {"status": "ok"}


def leave_days(cur, username: str, start: date, end: date) -> Dict[str, dict]:
    """Per-day leave info for the activity calendar."""
    cur.execute(
        """SELECT date_from, date_to, reason_type, status FROM leaves
           WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s)) AND status <> 'cancelled'
             AND date_from <= %s AND date_to >= %s""",
        (username, end.isoformat(), start.isoformat()),
    )
    out: Dict[str, dict] = {}
    for f, t, reason, status in cur.fetchall():
        d = max(f, start)
        while d <= min(t, end):
            out[d.isoformat()] = {"reason": reason, "status": status}
            d += timedelta(days=1)
    return out


def people_on_leave(cur, day: date) -> Dict[str, dict]:
    cur.execute(
        """SELECT LOWER(TRIM(username)), username, reason_type, status FROM leaves
           WHERE status <> 'cancelled' AND date_from <= %s AND date_to >= %s""",
        (day.isoformat(), day.isoformat()),
    )
    return {k: {"username": u, "reason": r, "status": s} for k, u, r, s in cur.fetchall()}


def pending_counts(cur, access: Access) -> Dict[str, int]:
    """For the notification bell."""
    out = {"unlocks": 0, "leaves": 0}
    if access.role in UNLOCK_APPROVER_ROLES:
        cur.execute("SELECT team FROM visit_unlocks WHERE status = 'pending'")
        out["unlocks"] = sum(1 for (t,) in cur.fetchall() if _can_decide_for(access, t, UNLOCK_APPROVER_ROLES))
    if access.role in LEAVE_APPROVER_ROLES:
        cur.execute("SELECT team, username FROM leaves WHERE status = 'pending'")
        out["leaves"] = sum(1 for t, u in cur.fetchall()
                            if _can_decide_for(access, t, LEAVE_APPROVER_ROLES) and norm(u) != norm(access.username))
    return out



# ---------------------------------------------------------------------------
# Lock controls for Super Admin / City Coordinator
#   - open dates directly (one person, a team, or everyone in scope) for N hours
#   - turn the lock off / on for one person, a team, or everyone in scope
#   - change the window (working days), Super Admin only
# ---------------------------------------------------------------------------

CONTROL_ROLES = {"admin", "city_coordinator"}


def _require_control(access: Access) -> None:
    if access.role not in CONTROL_ROLES:
        raise HTTPException(status_code=403, detail="Only a Super Admin or City Coordinator can change visit locks")


def _field_people(cur, access: Access) -> List[dict]:
    cur.execute(
        """SELECT username, COALESCE(team, ''), role FROM users
           WHERE role IN ('user', 'team_leader') AND COALESCE(is_active, TRUE)
           ORDER BY LOWER(COALESCE(team, '')), LOWER(username)"""
    )
    return [{"username": u, "team": t, "role": r} for u, t, r in cur.fetchall() if access.allows_team(t)]


def _targets(cur, access: Access, target: str, username: str, team: str) -> List[dict]:
    people = _field_people(cur, access)
    if target == "user":
        sel = [p for p in people if norm(p["username"]) == norm(username)]
        if not sel:
            raise HTTPException(status_code=404, detail="Person not found in your scope")
    elif target == "team":
        if not team or not access.allows_team(team):
            raise HTTPException(status_code=403, detail="This team is outside your assigned scope")
        sel = [p for p in people if norm(p["team"]) == norm(team)]
    elif target == "all":
        sel = people
    else:
        raise HTTPException(status_code=400, detail="Target must be user, team or all")
    if not sel:
        raise HTTPException(status_code=400, detail="Nobody matches this choice")
    return sel


@router.get("/visit-lock/controls")
def lock_controls(access: Access = Depends(get_access)):
    _require_control(access)
    with transaction() as cur:
        people = _field_people(cur, access)
        cur.execute("SELECT username_key, note, set_by, set_at FROM visit_lock_exempt")
        ex = {k: {"note": n, "by": b, "at": a.isoformat() if a else None} for k, n, b, a in cur.fetchall()}
        cur.execute(
            """SELECT id, username, team, unlock_date, reason, decided_by, expires_at, requested_at
               FROM visit_unlocks WHERE status = 'approved' AND expires_at > now()
               ORDER BY unlock_date DESC, LOWER(username) LIMIT 500"""
        )
        grants = [
            {"id": i, "username": u, "team": t, "date": str(d), "reason": r, "by": by,
             "expires_at": e.isoformat() if e else None}
            for i, u, t, d, r, by, e, _ in cur.fetchall() if access.allows_team(t)
        ]
        n = window_days(cur)
    for p in people:
        p["lock_off"] = ex.get(norm(p["username"]))
    teams = sorted({p["team"] for p in people if p["team"]}, key=str.lower)
    today = _today()
    return {
        "window_days": n,
        "default_window_days": WINDOW_WORKING_DAYS,
        "can_change_window": access.role == "admin",
        "allowed_dates": [d.isoformat() for d in allowed_dates(today, n)],
        "people": people,
        "teams": teams,
        "open_dates": grants,
    }


class WindowIn(BaseModel):
    window_days: int


@router.put("/visit-lock/settings")
def set_window(payload: WindowIn, access: Access = Depends(get_access)):
    if access.role != "admin":
        raise HTTPException(status_code=403, detail="Only a Super Admin can change the visit window")
    n = int(payload.window_days)
    if n < 0 or n > 60:
        raise HTTPException(status_code=400, detail="Choose between 0 and 60 working days")
    with transaction() as cur:
        old = window_days(cur)
        cur.execute(
            """INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('visit_window_days', %s, %s, now())
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()""",
            (str(n), access.username),
        )
        audit.record(cur, access, "visit.window_change", "settings", "visit_window_days", {"from": old, "to": n})
    return {"status": "ok", "window_days": n}


class ExemptIn(BaseModel):
    target: Literal["user", "team", "all"]
    username: str = ""
    team: str = ""
    lock_off: bool
    note: str = ""


@router.post("/visit-lock/exempt")
def set_exempt(payload: ExemptIn, access: Access = Depends(get_access)):
    _require_control(access)
    with transaction() as cur:
        people = _targets(cur, access, payload.target, payload.username, payload.team)
        for p in people:
            if payload.lock_off:
                cur.execute(
                    """INSERT INTO visit_lock_exempt (username_key, username, team, note, set_by)
                       VALUES (LOWER(TRIM(%s)), %s, %s, %s, %s)
                       ON CONFLICT (username_key) DO UPDATE SET note = EXCLUDED.note, set_by = EXCLUDED.set_by,
                                                                set_at = now(), team = EXCLUDED.team""",
                    (p["username"], p["username"], p["team"], (payload.note or "").strip()[:300], access.username),
                )
            else:
                cur.execute("DELETE FROM visit_lock_exempt WHERE username_key = LOWER(TRIM(%s))", (p["username"],))
        audit.record(cur, access, "visit.lock_off" if payload.lock_off else "visit.lock_on", "visit_lock", payload.target,
                     {"people": [p["username"] for p in people], "team": payload.team, "note": payload.note[:300]})
    return {"status": "ok", "people": len(people)}


class OpenIn(BaseModel):
    target: Literal["user", "team", "all"]
    username: str = ""
    team: str = ""
    date_from: str
    date_to: str = ""
    hours: int = UNLOCK_HOURS
    reason: str = ""


@router.post("/visit-lock/open")
def open_dates(payload: OpenIn, access: Access = Depends(get_access)):
    _require_control(access)
    start = _parse_day(payload.date_from, "From date")
    end = _parse_day(payload.date_to or payload.date_from, "To date")
    if end < start:
        start, end = end, start
    today = _today()
    if end > today:
        raise HTTPException(status_code=400, detail="Future dates do not need opening")
    if (end - start).days > 31:
        raise HTTPException(status_code=400, detail="Open at most 31 days at a time")
    if (today - start).days > 180:
        raise HTTPException(status_code=400, detail="Dates older than 180 days cannot be opened")
    hours = int(payload.hours)
    if hours < 1 or hours > 168:
        raise HTTPException(status_code=400, detail="Choose between 1 and 168 hours")
    reason = (payload.reason or "").strip() or "Opened by " + access.username
    with transaction() as cur:
        people = _targets(cur, access, payload.target, payload.username, payload.team)
        days = []
        d = start
        while d <= end:
            days.append(d)
            d += timedelta(days=1)
        rows = 0
        for p in people:
            for d in days:
                cur.execute(
                    """INSERT INTO visit_unlocks (user_id, username, team, unlock_date, reason, status,
                                                  decided_by, decided_at, expires_at, decision_note)
                       SELECT u.id, %s, %s, %s, %s, 'approved', %s, now(), now() + make_interval(hours => %s), 'Opened directly'
                       FROM (SELECT (SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s))) AS id) u""",
                    (p["username"], p["team"], d.isoformat(), reason[:500], access.username, hours, p["username"]),
                )
                rows += 1
        audit.record(cur, access, "visit.dates_opened", "visit_lock", payload.target,
                     {"people": [p["username"] for p in people][:200], "from": start.isoformat(), "to": end.isoformat(),
                      "hours": hours, "reason": reason[:300]})
    return {"status": "ok", "people": len(people), "days": len(days), "grants": rows}


@router.post("/visit-lock/open/{gid}/close")
def close_opened(gid: int, access: Access = Depends(get_access)):
    _require_control(access)
    with transaction() as cur:
        cur.execute("SELECT team, username, unlock_date FROM visit_unlocks WHERE id = %s AND status = 'approved'", (gid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        if not access.allows_team(row[0]):
            raise HTTPException(status_code=403, detail="This team is outside your assigned scope")
        cur.execute("UPDATE visit_unlocks SET expires_at = now() WHERE id = %s", (gid,))
        audit.record(cur, access, "visit.dates_closed", "visit_unlock", gid, {"username": row[1], "date": str(row[2])})
    return {"status": "ok"}
