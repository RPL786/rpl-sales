"""Role + scope authorization for RPL Sales V2.

Role  = WHAT a user may do (capabilities).
Scope = WHERE they may do it (org / city / branch / team).

Existing V1 role strings are kept so current users and tokens keep working:
    admin       -> Super Admin
    super_user  -> Boss / Executive
    team_leader -> Team Leader / Sales Manager
    user        -> Team Member
New V2 roles:
    city_coordinator, dashboard_admin
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Iterable, Optional, Set

from fastapi import Depends, Header, HTTPException
from jose import JWTError, jwt

from auth_utils import ALGORITHM, SECRET_KEY

from .db import connect

# Capabilities -------------------------------------------------------------
MANAGE_ORG = "manage_org"            # cities, branches, team->branch mapping
MANAGE_USERS = "manage_users"        # roles and scopes
VIEW_REPORTS = "view_reports"        # sales dashboards within scope
UPLOAD_SALES = "upload_sales"        # Excel upload / data entry for teams in scope
VIEW_TEAM_VISITS = "view_team_visits"
VIEW_AUDIT = "view_audit"
SYSTEM_ADMIN = "system_admin"        # AI settings, clear DB, backups

ROLE_DEFS: Dict[str, Dict] = {
    "admin": {
        "label": "Super Admin",
        "org_wide": True,
        "uses_home_team": False,
        "caps": {MANAGE_ORG, MANAGE_USERS, VIEW_REPORTS, UPLOAD_SALES, VIEW_TEAM_VISITS, VIEW_AUDIT, SYSTEM_ADMIN},
    },
    "super_user": {
        "label": "Boss / Executive",
        "org_wide": True,
        "uses_home_team": False,
        "caps": {VIEW_REPORTS, VIEW_TEAM_VISITS, VIEW_AUDIT},
    },
    "city_coordinator": {
        "label": "City Coordinator",
        "org_wide": False,
        "uses_home_team": False,
        "caps": {VIEW_REPORTS, VIEW_TEAM_VISITS},
    },
    "dashboard_admin": {
        "label": "Dashboard Admin",
        "org_wide": False,
        "uses_home_team": False,
        "caps": {VIEW_REPORTS, UPLOAD_SALES, VIEW_TEAM_VISITS},
    },
    "team_leader": {
        "label": "Team Leader",
        "org_wide": False,
        "uses_home_team": True,
        "caps": {VIEW_REPORTS, VIEW_TEAM_VISITS},
    },
    "user": {
        "label": "Team Member",
        "org_wide": False,
        "uses_home_team": True,
        "caps": set(),
    },
}

V1_ROLES = {"admin", "super_user", "team_leader", "user"}
ALL_ROLES = set(ROLE_DEFS)
# Roles that do not need a home team when created
TEAMLESS_ROLES = {"admin", "super_user", "city_coordinator", "dashboard_admin"}


def role_caps(role: str) -> FrozenSet[str]:
    return frozenset(ROLE_DEFS.get(role, {}).get("caps", set()))


def norm(value: object) -> str:
    return str(value or "").strip().casefold()


# Token -----------------------------------------------------------------------
def refresh_user(payload: dict) -> dict:
    """Reload role / team / is_active from the database.

    Tokens live for hours; without this a demoted or deactivated user would keep
    their old rights until the token expired.
    """
    uid = payload.get("user_id")
    conn = connect()
    try:
        cur = conn.cursor()
        if uid is not None:
            cur.execute(
                "SELECT id, username, role, COALESCE(team, ''), COALESCE(is_active, TRUE) FROM users WHERE id = %s",
                (uid,),
            )
        else:
            cur.execute(
                "SELECT id, username, role, COALESCE(team, ''), COALESCE(is_active, TRUE) FROM users WHERE username = %s",
                (payload.get("username") or "",),
            )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row or not row[4]:
        raise HTTPException(status_code=401, detail="Account inactive or not found. Please login again.")
    fresh = dict(payload)
    fresh.update({"user_id": row[0], "username": row[1], "role": row[2], "team": row[3]})
    return fresh


def decode_user(authorization: str = Header(default="")) -> dict:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Login required")
    token = authorization.replace("Bearer ", "", 1).strip()
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return refresh_user(payload)


def canonical_team(team: str) -> Optional[str]:
    """Return the stored team name matching `team` (case/space-insensitive), or None."""
    team = (team or "").strip()
    if not team:
        return None
    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM teams WHERE LOWER(TRIM(name)) = LOWER(%s) ORDER BY id LIMIT 1", (team,))
        row = cur.fetchone()
        return row[0] if row else None
    finally:
        conn.close()


# Scope -------------------------------------------------------------------
@dataclass
class Access:
    user_id: Optional[int]
    username: str
    role: str
    home_team: str
    caps: FrozenSet[str]
    # None => entire organization; otherwise names of teams in scope
    team_names: Optional[Set[str]] = field(default=None)

    @property
    def org_wide(self) -> bool:
        return self.team_names is None

    def can(self, cap: str) -> bool:
        return cap in self.caps

    def allows_team(self, team: str) -> bool:
        if self.team_names is None:
            return True
        return norm(team) in {norm(t) for t in self.team_names}

    def filter_teams(self, teams: Iterable[str]) -> list:
        return [t for t in teams if self.allows_team(t)]


_SCOPE_TEAMS_SQL = """
    SELECT DISTINCT t.name
    FROM user_scopes s
    JOIN teams t ON (
        (s.scope_type = 'team' AND s.scope_id = t.id)
        OR (s.scope_type = 'branch' AND s.scope_id = t.branch_id)
        OR (s.scope_type = 'city' AND s.scope_id = (
            SELECT b.city_id FROM org_branches b WHERE b.id = t.branch_id))
    )
    WHERE s.user_id = %s
"""


def resolve_access(user: dict) -> Access:
    """Build an Access object from a decoded JWT payload, reading scopes from DB."""
    role = str(user.get("role") or "")
    user_id = user.get("user_id")
    username = str(user.get("username") or "")
    home_team = str(user.get("team") or "").strip()
    rdef = ROLE_DEFS.get(role)
    if rdef is None:
        # Unknown role: no capabilities, no data
        return Access(user_id, username, role, home_team, frozenset(), set())

    if rdef["org_wide"]:
        return Access(user_id, username, role, home_team, role_caps(role), None)

    teams: Set[str] = set()
    if rdef["uses_home_team"] and home_team:
        teams.add(home_team)

    if user_id is not None:
        conn = connect()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT 1 FROM user_scopes WHERE user_id = %s AND scope_type = 'org' LIMIT 1",
                (user_id,),
            )
            if cur.fetchone():
                return Access(user_id, username, role, home_team, role_caps(role), None)
            cur.execute(_SCOPE_TEAMS_SQL, (user_id,))
            teams.update(r[0] for r in cur.fetchall() if r[0])
        except Exception:
            # V2 tables missing (should not happen after startup migration): fall back to home team only
            conn.rollback()
        finally:
            conn.close()

    return Access(user_id, username, role, home_team, role_caps(role), teams)


def get_access(user: dict = Depends(decode_user)) -> Access:
    return resolve_access(user)


def require_cap(cap: str):
    def _dep(access: Access = Depends(get_access)) -> Access:
        if not access.can(cap):
            raise HTTPException(status_code=403, detail="You do not have permission for this action")
        return access

    return _dep


def assert_team_allowed(access: Access, team: str) -> None:
    if team and not access.allows_team(team):
        raise HTTPException(status_code=403, detail="This team is outside your assigned scope")
