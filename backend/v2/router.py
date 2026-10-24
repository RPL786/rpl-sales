"""/api/v2 endpoints: current user, preferences, organization hierarchy, roles/scopes, audit."""
from __future__ import annotations

import re
from datetime import date
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import audit
from .db import transaction
from .permissions import (
    ALL_ROLES,
    MANAGE_ORG,
    MANAGE_USERS,
    ROLE_DEFS,
    TEAMLESS_ROLES,
    VIEW_AUDIT,
    Access,
    get_access,
    require_cap,
)

router = APIRouter(prefix="/api/v2", tags=["v2"])

CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,19}$")


def _clean_code(code: str) -> str:
    code = (code or "").strip().upper()
    if not CODE_RE.match(code):
        raise HTTPException(status_code=400, detail="Code must be 1-20 chars: A-Z, 0-9, _ or -")
    return code


def _clean_name(name: str) -> str:
    name = re.sub(r"\s+", " ", (name or "").strip())
    if not name or len(name) > 80:
        raise HTTPException(status_code=400, detail="Name is required (max 80 chars)")
    return name


# ---------------------------------------------------------------- me / prefs
@router.get("/me")
def me(access: Access = Depends(get_access)):
    theme, accent = "night", "orange"
    if access.user_id is not None:
        with transaction() as cur:
            cur.execute("SELECT theme, accent FROM user_preferences WHERE user_id = %s", (access.user_id,))
            row = cur.fetchone()
            if row:
                theme, accent = row[0], row[1]
    return {
        "user_id": access.user_id,
        "username": access.username,
        "role": access.role,
        "role_label": ROLE_DEFS.get(access.role, {}).get("label", access.role),
        "home_team": access.home_team,
        "capabilities": sorted(access.caps),
        "org_wide": access.org_wide,
        "teams_in_scope": None if access.org_wide else sorted(access.team_names or []),
        "preferences": {"theme": theme, "accent": accent},
    }


class PreferencesIn(BaseModel):
    theme: Optional[Literal["night", "day"]] = None
    accent: Optional[Literal["orange", "blue", "emerald", "purple", "rose"]] = None


@router.put("/me/preferences")
def update_preferences(payload: PreferencesIn, access: Access = Depends(get_access)):
    if access.user_id is None:
        raise HTTPException(status_code=400, detail="User id missing in token; please login again")
    if payload.theme is None and payload.accent is None:
        raise HTTPException(status_code=400, detail="Nothing to update")
    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO user_preferences (user_id, theme, accent, updated_at)
            VALUES (%s, COALESCE(%s, 'night'), COALESCE(%s, 'orange'), now())
            ON CONFLICT (user_id) DO UPDATE SET
                theme = COALESCE(%s, user_preferences.theme),
                accent = COALESCE(%s, user_preferences.accent),
                updated_at = now()
            RETURNING theme, accent
            """,
            (access.user_id, payload.theme, payload.accent, payload.theme, payload.accent),
        )
        theme, accent = cur.fetchone()
    return {"status": "ok", "preferences": {"theme": theme, "accent": accent}}


# --------------------------------------------------------------- org tree
@router.get("/org/tree")
def org_tree(access: Access = Depends(get_access)):
    """City > Branch > Team, filtered to the caller's scope. Unmapped teams listed separately."""
    with transaction() as cur:
        cur.execute("SELECT id, code, name, is_active FROM org_cities ORDER BY name")
        cities = [{"id": r[0], "code": r[1], "name": r[2], "is_active": r[3], "branches": []} for r in cur.fetchall()]
        cur.execute("SELECT id, city_id, code, name, is_active FROM org_branches ORDER BY name")
        branches = [
            {"id": r[0], "city_id": r[1], "code": r[2], "name": r[3], "is_active": r[4], "teams": []}
            for r in cur.fetchall()
        ]
        cur.execute(
            "SELECT id, name, branch_id, COALESCE(target_type, 'QTY'), COALESCE(is_active, TRUE) FROM teams ORDER BY name"
        )
        teams = [
            {"id": r[0], "name": r[1], "branch_id": r[2], "target_type": r[3], "is_active": r[4]}
            for r in cur.fetchall()
        ]

    teams = [t for t in teams if access.allows_team(t["name"])]
    by_branch = {b["id"]: b for b in branches}
    unassigned = []
    for t in teams:
        if t["branch_id"] in by_branch:
            by_branch[t["branch_id"]]["teams"].append(t)
        else:
            unassigned.append(t)

    by_city = {c["id"]: c for c in cities}
    for b in branches:
        if access.org_wide or b["teams"]:
            by_city[b["city_id"]]["branches"].append(b)

    visible_cities = [c for c in cities if access.org_wide or c["branches"]]
    return {
        "cities": visible_cities,
        "unassigned_teams": unassigned,
        "org_wide": access.org_wide,
    }


class CityIn(BaseModel):
    code: str
    name: str
    is_active: bool = True


@router.post("/org/cities")
def create_city(payload: CityIn, access: Access = Depends(require_cap(MANAGE_ORG))):
    code, name = _clean_code(payload.code), _clean_name(payload.name)
    with transaction() as cur:
        cur.execute("SELECT 1 FROM org_cities WHERE code = %s OR LOWER(name) = LOWER(%s)", (code, name))
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="City code or name already exists")
        cur.execute("INSERT INTO org_cities (code, name) VALUES (%s, %s) RETURNING id", (code, name))
        city_id = cur.fetchone()[0]
        audit.record(cur, access, "city.create", "city", city_id, {"code": code, "name": name})
    return {"id": city_id, "code": code, "name": name}


@router.put("/org/cities/{city_id}")
def update_city(city_id: int, payload: CityIn, access: Access = Depends(require_cap(MANAGE_ORG))):
    code, name = _clean_code(payload.code), _clean_name(payload.name)
    with transaction() as cur:
        cur.execute("SELECT code, name, is_active FROM org_cities WHERE id = %s", (city_id,))
        old = cur.fetchone()
        if not old:
            raise HTTPException(status_code=404, detail="City not found")
        cur.execute(
            "SELECT 1 FROM org_cities WHERE id <> %s AND (code = %s OR LOWER(name) = LOWER(%s))",
            (city_id, code, name),
        )
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="City code or name already exists")
        cur.execute(
            "UPDATE org_cities SET code = %s, name = %s, is_active = %s WHERE id = %s",
            (code, name, payload.is_active, city_id),
        )
        audit.record(cur, access, "city.update", "city", city_id,
                     {"old": {"code": old[0], "name": old[1], "is_active": old[2]},
                      "new": {"code": code, "name": name, "is_active": payload.is_active}})
    return {"status": "ok"}


class BranchIn(BaseModel):
    city_id: int
    code: str
    name: str
    is_active: bool = True


@router.post("/org/branches")
def create_branch(payload: BranchIn, access: Access = Depends(require_cap(MANAGE_ORG))):
    code, name = _clean_code(payload.code), _clean_name(payload.name)
    with transaction() as cur:
        cur.execute("SELECT 1 FROM org_cities WHERE id = %s", (payload.city_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="City not found")
        cur.execute(
            "SELECT 1 FROM org_branches WHERE code = %s OR (city_id = %s AND LOWER(name) = LOWER(%s))",
            (code, payload.city_id, name),
        )
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="Branch code or name already exists")
        cur.execute(
            "INSERT INTO org_branches (city_id, code, name) VALUES (%s, %s, %s) RETURNING id",
            (payload.city_id, code, name),
        )
        branch_id = cur.fetchone()[0]
        audit.record(cur, access, "branch.create", "branch", branch_id,
                     {"city_id": payload.city_id, "code": code, "name": name})
    return {"id": branch_id, "code": code, "name": name}


@router.put("/org/branches/{branch_id}")
def update_branch(branch_id: int, payload: BranchIn, access: Access = Depends(require_cap(MANAGE_ORG))):
    code, name = _clean_code(payload.code), _clean_name(payload.name)
    with transaction() as cur:
        cur.execute("SELECT city_id, code, name, is_active FROM org_branches WHERE id = %s", (branch_id,))
        old = cur.fetchone()
        if not old:
            raise HTTPException(status_code=404, detail="Branch not found")
        cur.execute("SELECT 1 FROM org_cities WHERE id = %s", (payload.city_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="City not found")
        cur.execute(
            "SELECT 1 FROM org_branches WHERE id <> %s AND (code = %s OR (city_id = %s AND LOWER(name) = LOWER(%s)))",
            (branch_id, code, payload.city_id, name),
        )
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="Branch code or name already exists")
        cur.execute(
            "UPDATE org_branches SET city_id = %s, code = %s, name = %s, is_active = %s WHERE id = %s",
            (payload.city_id, code, name, payload.is_active, branch_id),
        )
        audit.record(cur, access, "branch.update", "branch", branch_id,
                     {"old": {"city_id": old[0], "code": old[1], "name": old[2], "is_active": old[3]},
                      "new": {"city_id": payload.city_id, "code": code, "name": name,
                              "is_active": payload.is_active}})
    return {"status": "ok"}


class TeamBranchIn(BaseModel):
    branch_id: Optional[int] = None
    effective_date: Optional[date] = None


@router.put("/org/teams/{team_id}/branch")
def assign_team_branch(team_id: int, payload: TeamBranchIn, access: Access = Depends(require_cap(MANAGE_ORG))):
    """Move a team to a branch from an effective date. History rows are closed, never rewritten."""
    eff = payload.effective_date or date.today()
    with transaction() as cur:
        cur.execute("SELECT name, branch_id FROM teams WHERE id = %s FOR UPDATE", (team_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Team not found")
        team_name, old_branch = row
        if payload.branch_id is not None:
            cur.execute("SELECT 1 FROM org_branches WHERE id = %s", (payload.branch_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Branch not found")
        if old_branch == payload.branch_id:
            return {"status": "unchanged"}

        cur.execute(
            "SELECT MAX(start_date) FROM team_branch_history WHERE team_id = %s",
            (team_id,),
        )
        last_start = cur.fetchone()[0]
        if last_start and eff < last_start:
            raise HTTPException(status_code=400,
                                detail=f"Effective date cannot be before the current assignment start ({last_start})")

        cur.execute(
            "UPDATE team_branch_history SET end_date = %s WHERE team_id = %s AND end_date IS NULL",
            (eff, team_id),
        )
        if payload.branch_id is not None:
            cur.execute(
                """
                INSERT INTO team_branch_history (team_id, branch_id, start_date, changed_by)
                VALUES (%s, %s, %s, %s)
                """,
                (team_id, payload.branch_id, eff, access.username),
            )
        cur.execute("UPDATE teams SET branch_id = %s WHERE id = %s", (payload.branch_id, team_id))
        audit.record(cur, access, "team.branch_change", "team", team_id,
                     {"team": team_name, "from_branch": old_branch, "to_branch": payload.branch_id,
                      "effective_date": eff.isoformat()})
    return {"status": "ok"}


@router.get("/org/teams/{team_id}/branch-history")
def team_branch_history(team_id: int, access: Access = Depends(get_access)):
    with transaction() as cur:
        cur.execute("SELECT name FROM teams WHERE id = %s", (team_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Team not found")
        if not access.allows_team(row[0]):
            raise HTTPException(status_code=403, detail="This team is outside your assigned scope")
        cur.execute(
            """
            SELECT h.id, h.branch_id, b.name, c.name, h.start_date, h.end_date, h.changed_by
            FROM team_branch_history h
            JOIN org_branches b ON b.id = h.branch_id
            JOIN org_cities c ON c.id = b.city_id
            WHERE h.team_id = %s ORDER BY h.start_date
            """,
            (team_id,),
        )
        rows = cur.fetchall()
    return {"history": [
        {"id": r[0], "branch_id": r[1], "branch": r[2], "city": r[3],
         "start_date": r[4].isoformat(), "end_date": r[5].isoformat() if r[5] else None, "changed_by": r[6]}
        for r in rows
    ]}


# ---------------------------------------------------------- roles & scopes
@router.get("/roles")
def list_roles(access: Access = Depends(get_access)):
    return {"roles": [
        {"key": k, "label": v["label"], "org_wide": v["org_wide"], "needs_team": k not in TEAMLESS_ROLES,
         "capabilities": sorted(v["caps"])}
        for k, v in ROLE_DEFS.items()
    ]}


@router.get("/users")
def list_users_with_scopes(access: Access = Depends(require_cap(MANAGE_USERS))):
    with transaction() as cur:
        cur.execute(
            "SELECT id, username, role, COALESCE(team, ''), COALESCE(is_active, TRUE) FROM users ORDER BY username"
        )
        users = [{"id": r[0], "username": r[1], "role": r[2],
                  "role_label": ROLE_DEFS.get(r[2], {}).get("label", r[2]),
                  "team": r[3], "is_active": r[4], "scopes": []} for r in cur.fetchall()]
        cur.execute("SELECT user_id, scope_type, scope_id FROM user_scopes ORDER BY scope_type, scope_id")
        by_id = {u["id"]: u for u in users}
        for uid, st, sid in cur.fetchall():
            if uid in by_id:
                by_id[uid]["scopes"].append({"scope_type": st, "scope_id": sid})
    return {"users": users}


class ScopeIn(BaseModel):
    scope_type: Literal["org", "city", "branch", "team"]
    scope_id: Optional[int] = None


class ScopesIn(BaseModel):
    scopes: List[ScopeIn] = Field(default_factory=list)


_SCOPE_TABLE = {"city": "org_cities", "branch": "org_branches", "team": "teams"}


@router.put("/users/{user_id}/scopes")
def set_user_scopes(user_id: int, payload: ScopesIn, access: Access = Depends(require_cap(MANAGE_USERS))):
    clean = []
    seen = set()
    for s in payload.scopes:
        sid = None if s.scope_type == "org" else s.scope_id
        if s.scope_type != "org" and sid is None:
            raise HTTPException(status_code=400, detail=f"scope_id required for {s.scope_type} scope")
        key = (s.scope_type, sid)
        if key not in seen:
            seen.add(key)
            clean.append(key)

    with transaction() as cur:
        cur.execute("SELECT username FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        for st, sid in clean:
            if st != "org":
                cur.execute(f"SELECT 1 FROM {_SCOPE_TABLE[st]} WHERE id = %s", (sid,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail=f"{st} {sid} not found")
        cur.execute("SELECT scope_type, scope_id FROM user_scopes WHERE user_id = %s", (user_id,))
        old = sorted([list(r) for r in cur.fetchall()], key=str)
        cur.execute("DELETE FROM user_scopes WHERE user_id = %s", (user_id,))
        for st, sid in clean:
            cur.execute(
                "INSERT INTO user_scopes (user_id, scope_type, scope_id, granted_by) VALUES (%s, %s, %s, %s)",
                (user_id, st, sid, access.username),
            )
        audit.record(cur, access, "user.scopes_set", "user", user_id,
                     {"username": row[0], "old": old, "new": [list(k) for k in clean]})
    return {"status": "ok", "scopes": [{"scope_type": st, "scope_id": sid} for st, sid in clean]}


class RoleIn(BaseModel):
    role: str


@router.put("/users/{user_id}/role")
def set_user_role(user_id: int, payload: RoleIn, access: Access = Depends(require_cap(MANAGE_USERS))):
    role = (payload.role or "").strip()
    if role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")
    with transaction() as cur:
        cur.execute("SELECT username, role, COALESCE(team, '') FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        username, old_role, team = row
        if user_id == access.user_id and role != old_role:
            raise HTTPException(status_code=400, detail="You cannot change your own role")
        if role not in TEAMLESS_ROLES and not team:
            raise HTTPException(status_code=400, detail="This role needs a home team; assign a team first")
        if old_role == "admin" and role != "admin":
            cur.execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND COALESCE(is_active, TRUE)")
            if cur.fetchone()[0] <= 1:
                raise HTTPException(status_code=400, detail="At least one active Super Admin is required")
        cur.execute("UPDATE users SET role = %s WHERE id = %s", (role, user_id))
        if role in TEAMLESS_ROLES and old_role not in TEAMLESS_ROLES:
            # No longer a field seller: close open team membership, stop target tracking
            cur.execute(
                "UPDATE user_team_history SET end_date = %s WHERE user_id = %s AND end_date IS NULL",
                (date.today().isoformat(), user_id),
            )
            cur.execute("UPDATE users SET target_applicable = FALSE WHERE id = %s", (user_id,))
        audit.record(cur, access, "user.role_change", "user", user_id,
                     {"username": username, "from": old_role, "to": role})
    return {"status": "ok", "note": "User must log in again for the new role to apply"}


# ------------------------------------------------------------------- audit
@router.get("/audit")
def list_audit(limit: int = 100, access: Access = Depends(require_cap(VIEW_AUDIT))):
    limit = max(1, min(int(limit), 500))
    with transaction() as cur:
        cur.execute(
            """
            SELECT id, occurred_at, actor_username, action, entity_type, entity_id, details
            FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return {"events": [
        {"id": r[0], "occurred_at": r[1].isoformat(), "actor": r[2], "action": r[3],
         "entity_type": r[4], "entity_id": r[5], "details": r[6]}
        for r in rows
    ]}
