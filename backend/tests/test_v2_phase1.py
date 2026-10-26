"""Phase 1 tests: auth hardening, org hierarchy, scoped roles, preferences, audit, V1 regression.

Runs against a THROWAWAY PostgreSQL database configured via POSTGRES_* env vars.
Never point this at production: the test drops all tables at start.

    POSTGRES_DB=rpl_v2_test ... python -m pytest backend/tests -q
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import psycopg2
import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

if "test" not in (os.getenv("POSTGRES_DB") or ""):
    pytest.skip("Refusing to run: POSTGRES_DB must be a test database (name containing 'test')",
                allow_module_level=True)


def _reset_db():
    conn = psycopg2.connect(host=os.getenv("POSTGRES_HOST"), port=os.getenv("POSTGRES_PORT"),
                            database=os.getenv("POSTGRES_DB"), user=os.getenv("POSTGRES_USER"),
                            password=os.getenv("POSTGRES_PASSWORD"))
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    conn.close()


_reset_db()

from fastapi.testclient import TestClient  # noqa: E402

(BACKEND.parent / "frontend" / "dist" / "assets").mkdir(parents=True, exist_ok=True)
import api  # noqa: E402

ADMIN = (os.getenv("ADMIN_USERNAME", "admin"), os.getenv("ADMIN_PASSWORD", "admin123"))


@pytest.fixture(scope="module")
def client():
    with TestClient(api.app) as c:
        yield c


def login(client, username, password):
    r = client.post("/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def admin(client):
    return login(client, *ADMIN)


@pytest.fixture(scope="module")
def org(client, admin):
    """Karachi (KHI-D83 branch: Tile Adhesive, BCM), Lahore (LHR-MAIN: Lahore Team)."""
    for team in ["Tile Adhesive", "BCM", "Lahore Team", "Unmapped Team"]:
        assert client.post("/api/teams", json={"name": team}, headers=admin).status_code == 200
    teams = {t["name"]: t["id"] for t in client.get("/api/teams", headers=admin).json()["teams"]}

    khi = client.post("/api/v2/org/cities", json={"code": "KHI", "name": "Karachi"}, headers=admin).json()["id"]
    lhr = client.post("/api/v2/org/cities", json={"code": "LHR", "name": "Lahore"}, headers=admin).json()["id"]
    d83 = client.post("/api/v2/org/branches", json={"city_id": khi, "code": "KHI-D83", "name": "D83"},
                      headers=admin).json()["id"]
    lmain = client.post("/api/v2/org/branches", json={"city_id": lhr, "code": "LHR-MAIN", "name": "Lahore Main"},
                        headers=admin).json()["id"]
    for name, br in [("Tile Adhesive", d83), ("BCM", d83), ("Lahore Team", lmain)]:
        r = client.put(f"/api/v2/org/teams/{teams[name]}/branch",
                       json={"branch_id": br, "effective_date": "2025-01-01"}, headers=admin)
        assert r.status_code == 200, r.text

    # sales data
    for team, sp in [("Tile Adhesive", "ALI KHAN"), ("BCM", "AHMED"), ("Lahore Team", "USMAN")]:
        for d in ["2025-03-10", "2026-03-10"]:
            r = client.post("/data/entry", json={"team": team, "sales_person": sp, "client_name": f"{team} Client",
                                                 "product": "TA-100", "entry_date": d, "quantity": 10, "amount": 1000},
                            headers=admin)
            assert r.status_code == 200, r.text

    users = {}
    for uname, role, team in [("saddam", "team_leader", "Tile Adhesive"), ("ali", "user", "Tile Adhesive"),
                              ("khi_coord", "city_coordinator", ""), ("dash_admin", "dashboard_admin", ""),
                              ("boss", "super_user", "")]:
        r = client.post("/admin/create-user", json={"username": uname, "password": "pass1234", "team": team,
                                                    "role": role}, headers=admin)
        assert r.status_code == 200, r.text
    for u in client.get("/api/v2/users", headers=admin).json()["users"]:
        users[u["username"]] = u["id"]

    assert client.put(f"/api/v2/users/{users['khi_coord']}/scopes",
                      json={"scopes": [{"scope_type": "city", "scope_id": khi}]}, headers=admin).status_code == 200
    assert client.put(f"/api/v2/users/{users['dash_admin']}/scopes",
                      json={"scopes": [{"scope_type": "team", "scope_id": teams["BCM"]}]},
                      headers=admin).status_code == 200
    return {"teams": teams, "users": users, "khi": khi, "lhr": lhr, "d83": d83, "lmain": lmain}


# ------------------------------------------------------------ auth hardening
@pytest.mark.parametrize("method,url", [
    ("post", "/data/upload?team=BCM&mode=replace"),
    ("put", "/form/team/rename"),
    ("post", "/form/team"),
    ("post", "/reset"),
    ("post", "/upload"),
    ("get", "/dashboard"),
    ("get", "/forecast?team=BCM"),
    ("get", "/form/options?team=BCM"),
    ("post", "/salesperson-insights"),
    ("get", "/api/v2/me"),
    ("get", "/api/v2/org/tree"),
])
def test_previously_open_endpoints_require_login(client, method, url):
    kwargs = {}
    if url.startswith("/data/upload") or url == "/upload":
        kwargs["files"] = {"file": ("x.xlsx", io.BytesIO(b"x"))}
    elif method in ("post", "put"):
        kwargs["json"] = {"old_name": "BCM", "new_name": "HACKED", "name": "X"}
    r = getattr(client, method)(url, **kwargs)
    assert r.status_code == 401, (url, r.status_code, r.text)


def test_member_cannot_rename_or_upload(client, org):
    ali = login(client, "ali", "pass1234")
    assert client.put("/form/team/rename", json={"old_name": "BCM", "new_name": "X"}, headers=ali).status_code == 403
    r = client.post("/data/upload?team=Tile Adhesive&mode=replace", headers=ali,
                    files={"file": ("x.xlsx", io.BytesIO(b"x"))})
    assert r.status_code == 403


# ------------------------------------------------------------ org hierarchy
def test_org_tree_admin_sees_everything(client, admin, org):
    tree = client.get("/api/v2/org/tree", headers=admin).json()
    assert tree["org_wide"] is True
    names = {c["name"] for c in tree["cities"]}
    assert names == {"Karachi", "Lahore"}
    karachi = next(c for c in tree["cities"] if c["name"] == "Karachi")
    assert {t["name"] for t in karachi["branches"][0]["teams"]} == {"Tile Adhesive", "BCM"}
    assert [t["name"] for t in tree["unassigned_teams"]] == ["Unmapped Team"]


def test_city_can_have_multiple_branches(client, admin, org):
    r = client.post("/api/v2/org/branches", json={"city_id": org["khi"], "code": "KHI-2", "name": "Karachi 2"},
                    headers=admin)
    assert r.status_code == 200
    dup = client.post("/api/v2/org/branches", json={"city_id": org["khi"], "code": "KHI-2", "name": "Other"},
                      headers=admin)
    assert dup.status_code == 409
    bad = client.post("/api/v2/org/cities", json={"code": "bad code!", "name": "X"}, headers=admin)
    assert bad.status_code == 400


def test_team_move_keeps_history(client, admin, org):
    tid = org["teams"]["BCM"]
    r = client.put(f"/api/v2/org/teams/{tid}/branch",
                   json={"branch_id": org["lmain"], "effective_date": "2026-07-01"}, headers=admin)
    assert r.status_code == 200
    hist = client.get(f"/api/v2/org/teams/{tid}/branch-history", headers=admin).json()["history"]
    assert [(h["branch"], h["start_date"], h["end_date"]) for h in hist] == [
        ("D83", "2025-01-01", "2026-07-01"),
        ("Lahore Main", "2026-07-01", None),
    ]
    back = client.put(f"/api/v2/org/teams/{tid}/branch",
                      json={"branch_id": org["d83"], "effective_date": "2026-01-01"}, headers=admin)
    assert back.status_code == 400  # cannot go before current assignment
    assert client.put(f"/api/v2/org/teams/{tid}/branch",
                      json={"branch_id": org["d83"], "effective_date": "2026-08-01"}, headers=admin).status_code == 200


# ------------------------------------------------------------ scoped access
def test_city_coordinator_sees_only_karachi(client, org):
    h = login(client, "khi_coord", "pass1234")
    me = client.get("/api/v2/me", headers=h).json()
    assert me["role_label"] == "City Coordinator"
    assert set(me["teams_in_scope"]) == {"Tile Adhesive", "BCM"}

    teams = {t["name"] for t in client.get("/api/teams", headers=h).json()["teams"]}
    assert teams == {"Tile Adhesive", "BCM"}

    tree = client.get("/api/v2/org/tree", headers=h).json()
    assert [c["name"] for c in tree["cities"]] == ["Karachi"]
    assert tree["unassigned_teams"] == []

    assert client.get("/dashboard/db?team=Lahore Team", headers=h).status_code == 403
    assert client.get("/dashboard/db?team=Tile Adhesive", headers=h).status_code == 200

    rep = client.get("/api/product-contribution-report?year=2026", headers=h)
    assert rep.status_code == 200
    assert "Lahore" not in rep.text
    assert client.get("/api/product-contribution-report?year=2026&team=Lahore Team", headers=h).status_code == 403

    entries = client.get("/data/entries", headers=h).json()["entries"]
    assert entries and {e["team"] for e in entries} <= {"Tile Adhesive", "BCM"}

    # coordinators cannot manage org or users
    assert client.post("/api/v2/org/cities", json={"code": "HUB", "name": "Hub"}, headers=h).status_code == 403
    assert client.get("/api/v2/users", headers=h).status_code == 403
    assert client.get("/dashboard", headers=h).status_code == 403


def test_dashboard_admin_upload_scope(client, org):
    h = login(client, "dash_admin", "pass1234")
    out = client.post("/data/upload?team=Tile Adhesive&mode=replace", headers=h,
                      files={"file": ("x.xlsx", io.BytesIO(b"not excel"))})
    assert out.status_code == 403
    inside = client.post("/data/upload?team=BCM&mode=append", headers=h,
                         files={"file": ("x.xlsx", io.BytesIO(b"not excel"))})
    assert inside.status_code != 403  # passes permission; fails later on bad file content
    r = client.post("/data/entry", json={"team": "Tile Adhesive", "sales_person": "X", "client_name": "C",
                                         "product": "P", "entry_date": "2026-01-01", "quantity": 1}, headers=h)
    assert r.status_code == 403


def test_team_leader_and_member_keep_v1_rules(client, org):
    leader = login(client, "saddam", "pass1234")
    assert client.get("/dashboard/db?team=Tile Adhesive", headers=leader).status_code == 200
    assert client.get("/dashboard/db?team=BCM", headers=leader).status_code == 403
    member = login(client, "ali", "pass1234")
    assert client.get("/dashboard/db?team=BCM", headers=member).status_code == 403
    assert client.get("/form/options?team=Tile Adhesive", headers=member).status_code == 200
    assert client.get("/form/options?team=BCM", headers=member).status_code == 403
    assert client.post("/api/v2/org/cities", json={"code": "HUB", "name": "Hub"}, headers=member).status_code == 403


def test_boss_is_org_wide_but_cannot_manage(client, org):
    boss = login(client, "boss", "pass1234")
    assert client.get("/dashboard/db?team=Lahore Team", headers=boss).status_code == 200
    assert client.get("/api/v2/audit", headers=boss).status_code == 200
    assert client.put(f"/api/v2/users/{org['users']['ali']}/role", json={"role": "admin"},
                      headers=boss).status_code == 403


# ------------------------------------------------------------ roles & prefs & audit
def test_role_change_rules(client, admin, org):
    admin_id = client.get("/api/v2/me", headers=admin).json()["user_id"]
    assert client.put(f"/api/v2/users/{admin_id}/role", json={"role": "user"}, headers=admin).status_code == 400
    assert client.put(f"/api/v2/users/{org['users']['ali']}/role", json={"role": "wizard"},
                      headers=admin).status_code == 400
    assert client.put(f"/api/v2/users/{org['users']['khi_coord']}/role", json={"role": "team_leader"},
                      headers=admin).status_code == 400  # needs a home team
    assert client.put(f"/api/v2/users/{org['users']['saddam']}/role", json={"role": "team_leader"},
                      headers=admin).status_code == 200


def test_theme_preference_persists(client, org):
    h = login(client, "ali", "pass1234")
    assert client.get("/api/v2/me", headers=h).json()["preferences"]["theme"] == "night"
    assert client.put("/api/v2/me/preferences", json={"theme": "day"}, headers=h).status_code == 200
    h2 = login(client, "ali", "pass1234")
    assert client.get("/api/v2/me", headers=h2).json()["preferences"]["theme"] == "day"
    assert client.put("/api/v2/me/preferences", json={"theme": "pink"}, headers=h).status_code == 422
    r = client.put("/api/v2/me/preferences", json={"accent": "emerald"}, headers=h)
    assert r.status_code == 200 and r.json()["preferences"] == {"theme": "day", "accent": "emerald"}
    assert client.get("/api/v2/me", headers=h).json()["preferences"]["accent"] == "emerald"
    assert client.put("/api/v2/me/preferences", json={"accent": "gold"}, headers=h).status_code == 422
    assert client.put("/api/v2/me/preferences", json={}, headers=h).status_code == 400


def test_audit_trail_records_changes(client, admin, org):
    events = client.get("/api/v2/audit", headers=admin).json()["events"]
    actions = {e["action"] for e in events}
    assert {"city.create", "branch.create", "team.branch_change", "user.scopes_set", "sales.upload"} <= actions


def test_schema_migration_is_idempotent(client):
    from v2.schema import ensure_v2_schema
    ensure_v2_schema()
    ensure_v2_schema()
    api.ensure_database_schema()


# ------------------------------------------------------------ V1 regression
def test_v1_admin_flows_still_work(client, admin, org):
    r = client.get("/dashboard/db?team=Tile Adhesive", headers=admin)
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["this_year_sales"] > 0
    assert client.get("/admin/users", headers=admin).status_code == 200
    assert client.get("/api/visit-entries", headers=admin).status_code == 200
    assert client.get("/form/options?team=BCM", headers=admin).json()["sales_people"] == ["AHMED"]
    assert client.get("/forecast?team=BCM", headers=admin).status_code == 200


# ------------------------------------------------------------ review fixes
def test_form_options_and_dashboard_teams_are_scoped(client, org):
    h = login(client, "khi_coord", "pass1234")
    assert set(client.get("/form/options", headers=h).json()["teams"]) == {"BCM", "Tile Adhesive"}
    assert client.get("/forecast?team=Lahore Team", headers=h).status_code == 403


def test_dashboard_admin_team_name_is_canonical(client, admin, org):
    h = login(client, "dash_admin", "pass1234")
    r = client.post("/data/entry", json={"team": "bcm", "sales_person": "AHMED", "client_name": "C",
                                         "product": "P", "entry_date": "2026-02-01", "quantity": 1}, headers=h)
    assert r.status_code == 200 and r.json()["saved"]["team"] == "BCM"
    names = [t["name"] for t in client.get("/api/teams", headers=admin).json()["teams"]]
    assert "bcm" not in names
    v = client.post("/api/visit-entry", headers=h, json={
        "team": "BCM", "sales_person": "AHMED", "client_name": "C", "client_category": "", "product": "P",
        "meeting_date": "2026-10-21", "meeting_time": "10:00", "meeting_type": "Visit", "meeting_status": "Done",
        "client_response": "", "order_amount": 0, "quantity": 0, "future_potential": 0,
        "next_meeting_date": "", "next_meeting_time": "", "notes": ""})
    assert v.status_code == 200, v.text
    v2 = client.post("/api/visit-entry", headers=h, json={
        "team": "Tile Adhesive", "sales_person": "ALI", "client_name": "C", "client_category": "", "product": "P",
        "meeting_date": "2026-10-21", "meeting_time": "10:00", "meeting_type": "Visit", "meeting_status": "Done",
        "client_response": "", "order_amount": 0, "quantity": 0, "future_potential": 0,
        "next_meeting_date": "", "next_meeting_time": "", "notes": ""})
    assert v2.status_code == 403


def test_boss_cannot_clear_database(client, org):
    boss = login(client, "boss", "pass1234")
    assert client.post("/admin/clear-database", headers=boss).status_code == 403


def test_role_change_and_deactivation_apply_immediately(client, admin, org):
    uid = org["users"]["dash_admin"]
    h = login(client, "dash_admin", "pass1234")
    assert client.put(f"/api/v2/users/{uid}/role", json={"role": "city_coordinator"}, headers=admin).status_code == 200
    r = client.post("/data/upload?team=BCM&mode=append", headers=h, files={"file": ("x.xlsx", io.BytesIO(b"x"))})
    assert r.status_code == 403  # same old token, new role already applied
    assert client.put(f"/api/v2/users/{uid}/role", json={"role": "dashboard_admin"}, headers=admin).status_code == 200
    assert client.put(f"/admin/deactivate-user/{uid}", json={"inactive_date": "2026-10-21"},
                      headers=admin).status_code == 200
    assert client.get("/data/entries", headers=h).status_code == 401
    assert client.put(f"/admin/reactivate-user/{uid}", headers=admin).status_code == 200


def test_deleting_team_removes_its_scopes(client, admin, org):
    tid = client.post("/api/teams", json={"name": "Temp Team"}, headers=admin)
    teams = {t["name"]: t["id"] for t in client.get("/api/teams", headers=admin).json()["teams"]}
    uid = org["users"]["khi_coord"]
    client.put(f"/api/v2/users/{uid}/scopes", json={"scopes": [
        {"scope_type": "city", "scope_id": org["khi"]}, {"scope_type": "team", "scope_id": teams["Temp Team"]}]},
        headers=admin)
    assert client.delete(f"/api/teams/{teams['Temp Team']}", headers=admin).status_code == 200
    scopes = next(u for u in client.get("/api/v2/users", headers=admin).json()["users"] if u["id"] == uid)["scopes"]
    assert scopes == [{"scope_type": "city", "scope_id": org["khi"]}]


# ============================================================ Phase 4/5: analytics, customer 360, planner
from datetime import date as _date, timedelta as _td  # noqa: E402


@pytest.fixture(scope="module")
def my_team(client, admin, org):
    assert client.post("/api/teams", json={"name": "MY Team"}, headers=admin).status_code == 200
    for d, q in [("2024-02-15", 5), ("2024-06-10", 7), ("2025-02-10", 8), ("2025-06-01", 4),
                 ("2026-01-10", 3), ("2026-02-14", 6)]:
        r = client.post("/data/entry", json={"team": "MY Team", "sales_person": "ZAIN", "client_name": "Alpha Builders",
                                             "product": "TA-200", "entry_date": d, "quantity": q, "amount": q * 100},
                        headers=admin)
        assert r.status_code == 200, r.text
    return "MY Team"


def test_multi_year_ytd_is_fair(client, admin, my_team):
    r = client.get("/api/v2/analytics/multi-year?teams=MY Team&mode=ytd", headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["years_available"] == [2024, 2025, 2026]
    assert body["years"] == [2024, 2025, 2026]
    assert body["cutoff"]["month"] == "Feb" and body["cutoff"]["day"] == 14
    totals = {t["year"]: t for t in body["totals"]}
    assert totals[2024]["value"] == 0      # 15 Feb is after the 14 Feb cutoff
    assert totals[2025]["value"] == 8
    assert totals[2026]["value"] == 9
    assert totals[2026]["growth_pct"] == 12.5
    assert [m["month"] for m in body["monthly"]] == ["Jan", "Feb"]
    assert body["salespersons"][0]["name"] == "ZAIN"


def test_multi_year_full_and_amount(client, admin, my_team):
    body = client.get("/api/v2/analytics/multi-year?teams=MY Team&mode=full&metric=amount&years=2025,2026",
                      headers=admin).json()
    assert body["years"] == [2025, 2026]
    totals = {t["year"]: t for t in body["totals"]}
    assert totals[2025]["value"] == 1200 and totals[2026]["value"] == 900
    assert totals[2026]["growth_pct"] == -25.0
    assert len(body["monthly"]) == 12


def test_multi_year_scope(client, org, my_team):
    coord = login(client, "khi_coord", "pass1234")
    assert client.get("/api/v2/analytics/multi-year?teams=Lahore Team", headers=coord).status_code == 403
    body = client.get("/api/v2/analytics/multi-year?mode=full", headers=coord).json()
    names = {s["name"] for s in body["salespersons"]}
    assert "USMAN" not in names and "ZAIN" not in names
    member = login(client, "ali", "pass1234")
    assert client.get("/api/v2/analytics/multi-year", headers=member).status_code == 403


def test_customer_360(client, admin, org, my_team):
    r = client.get("/api/v2/customers/360?name=alpha builders", headers=admin)
    assert r.status_code == 200, r.text
    c = r.json()
    assert [y["year"] for y in c["yearly"]] == [2024, 2025, 2026]
    assert c["total_qty"] == 33
    assert c["products"][0]["name"] == "TA-200"
    assert c["salespersons"][0]["sales_person"] == "ZAIN"
    assert len(c["monthly_24"]) == 24
    found = client.get("/api/v2/customers/search?q=alpha", headers=admin).json()["customers"]
    assert found and found[0]["name"] == "Alpha Builders"

    coord = login(client, "khi_coord", "pass1234")
    assert client.get("/api/v2/customers/360?name=Lahore Team Client", headers=coord).status_code == 404
    names = [x["name"] for x in client.get("/api/v2/customers/search?q=client", headers=coord).json()["customers"]]
    assert "Lahore Team Client" not in names and "Tile Adhesive Client" in names


def _visit(client, h, client_name, meeting, nxt="", status="Interested"):
    r = client.post("/api/visit-entry", headers=h, json={
        "team": "", "sales_person": "", "client_name": client_name, "client_category": "", "product": "TA-100",
        "meeting_date": meeting, "meeting_time": "10:00", "meeting_type": "Visit", "meeting_status": status,
        "client_response": "", "order_amount": 0, "quantity": 0, "future_potential": 0,
        "next_meeting_date": nxt, "next_meeting_time": "", "notes": ""})
    assert r.status_code == 200, r.text


def test_visit_planner_followups(client, org):
    ali = login(client, "ali", "pass1234")
    t = _date.today()
    iso = lambda n: (t + _td(days=n)).isoformat()  # noqa: E731
    _visit(client, ali, "Overdue Co", iso(-10), iso(-3))
    _visit(client, ali, "Done Co", iso(-20), iso(-5))
    _visit(client, ali, "Done Co", iso(-2))                       # follow-up completed by this later visit
    _visit(client, ali, "Soon Co", iso(0), iso(3))
    _visit(client, ali, "Closed Co", iso(-9), iso(-1), status="Order Received")

    p = client.get("/api/v2/visits/planner", headers=ali).json()
    overdue = [v["client_name"] for v in p["overdue"]]
    assert overdue == ["Overdue Co"] and p["overdue"][0]["days_overdue"] == 3
    assert [v["client_name"] for v in p["upcoming"]] == ["Soon Co"]
    assert p["summary"]["visits_today"] >= 1
    assert len(p["days"]) == 7

    leader = login(client, "saddam", "pass1234")
    assert "Overdue Co" in [v["client_name"] for v in client.get("/api/v2/visits/planner", headers=leader).json()["overdue"]]
    boss = login(client, "boss", "pass1234")
    assert client.get("/api/v2/visits/planner?sales_person=ali", headers=boss).json()["summary"]["followups_overdue"] == 1
    other = client.get("/api/v2/visits/planner?sales_person=nobody", headers=boss).json()
    assert other["summary"]["followups_overdue"] == 0


def test_multi_year_mixed_granularity_is_prorated(client, admin, org):
    assert client.post("/api/teams", json={"name": "Mix Team"}, headers=admin).status_code == 200
    rows = [("2025-10-01", 310)] + [(f"2026-10-{d:02d}", 10) for d in range(1, 11)]  # 2025 monthly, 2026 daily
    rows += [("2026-09-15", 1)]
    for d, q in rows:
        assert client.post("/data/entry", json={"team": "Mix Team", "sales_person": "Zain ", "client_name": "Mix Co",
                                                "product": "P1", "entry_date": d, "quantity": q},
                           headers=admin).status_code == 200
    assert client.post("/data/entry", json={"team": "Mix Team", "sales_person": "ZAIN", "client_name": "Mix Co",
                                            "product": "P1", "entry_date": "2026-10-02", "quantity": 5},
                       headers=admin).status_code == 200
    body = client.get("/api/v2/analytics/multi-year?teams=Mix Team&mode=ytd", headers=admin).json()
    assert body["cutoff"]["day"] == 10 and body["prorated_years"] == [2025]
    totals = {t["year"]: t["value"] for t in body["totals"]}
    assert totals[2025] == 100.0           # 310 * 10/31
    assert totals[2026] == 106.0           # 100 daily + 5 + 1 (Sep)
    names = [r["name"] for r in body["salespersons"]]
    assert len(names) == 1                  # "Zain " and "ZAIN" are one person
    assert body["salespersons"][0]["values"]["2026"] == 106.0


def test_member_scope_cannot_be_widened(client, admin, org):
    uid = org["users"]["ali"]
    r = client.put(f"/api/v2/users/{uid}/scopes", json={"scopes": [{"scope_type": "org"}]}, headers=admin)
    assert r.status_code == 400


def test_customer_search_escapes_wildcards(client, admin, org):
    assert client.get("/api/v2/customers/search?q=%25%25", headers=admin).json()["customers"] == []


def test_customer_360_visits_only_prospect(client, admin, org):
    r = client.get("/api/v2/customers/360?name=Overdue Co", headers=admin)
    assert r.status_code == 200, r.text
    c = r.json()
    assert c["status"] == "prospect" and c["visit_count"] == 1 and len(c["visits"]) == 1
    soon = client.get("/api/v2/customers/360?name=Soon Co", headers=admin).json()
    assert soon["next_followup"] == (_date.today() + _td(days=3)).isoformat()


# ============================================================ Round 1: all-teams dashboard, safe clear
def test_dashboard_without_team_combines_scope(client, admin, org):
    body = client.get("/dashboard/db", headers=admin).json()
    assert not body["metadata"].get("empty_state")
    assert body["metadata"]["view_label"] == "All teams"
    names = {m["name"] for m in body["team"]}
    assert {"ALI KHAN", "AHMED", "USMAN"} <= names

    coord = login(client, "khi_coord", "pass1234")
    cb = client.get("/dashboard/db", headers=coord).json()
    cnames = {m["name"] for m in cb["team"]}
    assert "USMAN" not in cnames and "ALI KHAN" in cnames
    assert cb["metadata"]["view_label"] == "All my teams"
    assert client.get("/dashboard/db?teams=Lahore Team", headers=coord).status_code == 403
    one = client.get("/dashboard/db?teams=BCM", headers=coord).json()
    assert {m["name"] for m in one["team"]} <= {"AHMED"}


def test_clear_database_needs_typed_confirmation(client, admin, org):
    r = client.post("/admin/clear-database", headers=admin)
    assert r.status_code == 400
    r = client.post("/admin/clear-database", json={"confirm": "delete"}, headers=admin)
    assert r.status_code == 400
    assert client.get("/dashboard/db?team=BCM", headers=admin).json()["summary"]["this_year_sales"] > 0
