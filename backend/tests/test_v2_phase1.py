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


def _raw_sql(sql, params=()):
    """Write straight to the DB (to create old-style data the API no longer allows)."""
    conn = psycopg2.connect(host=os.getenv("POSTGRES_HOST"), port=os.getenv("POSTGRES_PORT"),
                            database=os.getenv("POSTGRES_DB"), user=os.getenv("POSTGRES_USER"),
                            password=os.getenv("POSTGRES_PASSWORD"))
    with conn, conn.cursor() as cur:
        cur.execute(sql, params)
    conn.close()


def raw_sale(team, person, client_name, product, date, qty, amount=0):
    _raw_sql("""INSERT INTO sales_entries (team, sales_person, client_name, client_category, product, year, month,
                quantity, amount, entry_date) VALUES (%s,%s,%s,'',%s,%s,%s,%s,%s,%s)""",
             (team, person, client_name, product, int(date[:4]),
              ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][int(date[5:7]) - 1],
              qty, amount, date))


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
    assert {"city.create", "branch.create", "team.branch_change", "user.scopes_set"} <= actions


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


# ============================================================ Round 2: role home pages + targets
def test_home_pages_by_role(client, admin, org):
    from v2.analytics import _today
    t = _today()
    mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.month - 1]
    for uname, val in [("saddam", 100), ("ali", 50)]:
        r = client.put("/admin/monthly-target", headers=admin, json={
            "username": uname, "team": "Tile Adhesive", "year": t.year, "month": mon,
            "target_type": "QTY", "target_value": val})
        assert r.status_code == 200, r.text
    for sp, q in [("saddam", 30), ("ali", 10)]:
        r = client.post("/data/entry", headers=admin, json={
            "team": "Tile Adhesive", "sales_person": sp, "client_name": "Home Co", "product": "TA-100",
            "entry_date": t.isoformat(), "quantity": q})
        assert r.status_code == 200, r.text

    leader = client.get("/api/v2/home", headers=login(client, "saddam", "pass1234")).json()
    assert leader["kind"] == "leader"
    ta = next(x for x in leader["teams"] if x["team"] == "Tile Adhesive")
    assert ta["target"] == 150 and ta["achieved"] >= 40
    people = {p["username"]: p for p in leader["top_people"]}
    assert people["saddam"]["pct"] == 30.0 and people["ali"]["pct"] == 20.0
    prog = leader["progress"][0]
    assert prog["unit"] == "QTY" and prog["target"] == 150
    assert prog["required_per_day"] is not None and prog["status"] in {"on_track", "close", "behind", "done"}
    assert {x["team"] for x in leader["teams"]} == {"Tile Adhesive"}

    member = client.get("/api/v2/home", headers=login(client, "ali", "pass1234")).json()
    assert member["kind"] == "member"
    assert member["progress"][0]["target"] == 50 and member["progress"][0]["achieved"] == 10
    assert member["teams"] == [] and member["top_people"][0]["username"] == "ali"
    assert member["sales"]["mtd_qty"] == 10

    boss = client.get("/api/v2/home", headers=login(client, "boss", "pass1234")).json()
    assert boss["kind"] == "manager" and len(boss["teams"]) >= 3

    coord = client.get("/api/v2/home", headers=login(client, "khi_coord", "pass1234")).json()
    assert "Lahore Team" not in {x["team"] for x in coord["teams"]}


def test_home_progress_ignores_teams_without_target(client, admin, org):
    body = client.get("/api/v2/home", headers=admin).json()
    qty = next(p for p in body["progress"] if p["unit"] == "QTY")
    with_target = [t for t in body["teams"] if t["target"] and t["unit"] == "QTY"]
    assert qty["target"] == sum(t["target"] for t in with_target)
    assert qty["achieved"] == sum(t["achieved"] for t in with_target)


# ============================================================ Round 3: notifications
def test_notifications(client, org):
    ali = login(client, "ali", "pass1234")
    body = client.get("/api/v2/notifications", headers=ali).json()
    kinds = {i["kind"] for i in body["items"]}
    assert "overdue" in kinds and body["count"] >= 1
    leader = client.get("/api/v2/notifications", headers=login(client, "saddam", "pass1234")).json()
    assert "behind" in {i["kind"] for i in leader["items"]}


# ============================================================ Data health: no double counting
def test_product_report_not_doubled_by_name_variants(client, admin, org):
    client.post("/api/teams", json={"name": "Dup Team"}, headers=admin)
    client.post("/data/entry", headers=admin, json={"team": "Dup Team", "sales_person": "X", "client_name": "Dup Co",
                                                    "product": "WATER GUARD 491 16 KG", "entry_date": "2026-10-05",
                                                    "quantity": 2016})
    # an old-style second spelling in the product list (the API now refuses to create it)
    assert client.post("/api/products", json={"name": "Water Guard 491 16 kg"}, headers=admin).status_code == 409
    _raw_sql("INSERT INTO products (name) VALUES ('Water Guard 491 16 kg')")
    r = client.get("/api/product-contribution-report?year=2026&team=Dup Team", headers=admin).json()
    assert r["overall_total_qty"] == 2016


def test_data_health_merge_and_duplicates(client, admin, org):
    # same line imported twice + a spelling variant in sales
    for _ in range(2):
        raw_sale("Dup Team", "X", "Dup Co", "ZEPOXY Clear FULL", "2026-10-06", 466.5)
    raw_sale("Dup Team", "X", "dup co.", "Zepoxy clear full", "2026-10-07", 1)
    h = client.get("/api/v2/data-health", headers=admin).json()
    keys = {g["key"] for g in h["products"]["groups"]}
    assert "waterguard491_16kg" in keys and "zepoxyclearfull" in keys
    assert h["duplicate_lines"]["extra_lines"] >= 1
    assert any(g["key"] == "dupco" for g in h["clients"]["groups"])

    coord = login(client, "khi_coord", "pass1234")
    assert client.get("/api/v2/data-health", headers=coord).status_code == 403
    boss = login(client, "boss", "pass1234")
    assert client.post("/api/v2/data-health/remove-duplicate-lines", json={"confirm": "DELETE"},
                       headers=boss).status_code == 403

    bad = client.post("/api/v2/data-health/merge", headers=admin,
                      json={"kind": "product", "canonical": "ZEPOXY Clear FULL", "variants": ["Something else"]})
    assert bad.status_code == 400
    r = client.post("/api/v2/data-health/merge", headers=admin,
                    json={"kind": "product", "canonical": "ZEPOXY Clear FULL", "variants": ["Zepoxy clear full"]})
    assert r.status_code == 200 and r.json()["sales_lines_updated"] == 1

    assert client.post("/api/v2/data-health/remove-duplicate-lines", json={}, headers=admin).status_code == 400
    r = client.post("/api/v2/data-health/remove-duplicate-lines", json={"confirm": "DELETE"}, headers=admin)
    assert r.status_code == 200 and r.json()["removed"] >= 1
    rep = client.get("/api/product-contribution-report?year=2026&team=Dup Team&product=ZEPOXY Clear FULL",
                     headers=admin).json()
    assert rep["overall_total_qty"] == 467.5
    after = client.get("/api/v2/data-health", headers=admin).json()
    assert after["duplicate_lines"]["extra_lines"] == 0


def test_name_key_keeps_pack_sizes_apart():
    from v2.datahealth import name_key
    assert name_key("ZEPOXY TABLE TOP DEEP POUR 1.5 KG") == name_key("Zepoxy Table Top Deep Pour 1.5KG")
    assert name_key("ZEPOXY TABLE TOP DEEP POUR 1.5 KG") != name_key("ZEPOXY TABLE TOP DEEP POUR 15 KG")
    assert name_key("Pack 1.50 kg") == name_key("pack 1.5kg")
    assert name_key("WATER GUARD 491 16 KG") != name_key("WATER GUARD 4911 6 KG")
    assert name_key("WATER GUARD 491 16 KG") == name_key("Water-Guard 491 16kg")


def test_data_health_pack_sizes_and_ignore(client, admin, org):
    for name, qty in (("ZEPOXY TABLE TOP DEEP POUR 15 KG", 720), ("ZEPOXY TABLE TOP DEEP POUR 1.5 KG", 84),
                      ("ZEPOXY TABLE TOP DEEP POUR 1.5KG", 13.95)):
        raw_sale("Dup Team", "X", "Pack Co", name, "2026-10-08", qty)
    h = client.get("/api/v2/data-health", headers=admin).json()
    groups = [g for g in h["products"]["groups"] if g["key"].startswith("zepoxytabletopdeeppour")]
    assert len(groups) == 1
    assert {s["name"] for s in groups[0]["spellings"]} == {"ZEPOXY TABLE TOP DEEP POUR 1.5 KG",
                                                            "ZEPOXY TABLE TOP DEEP POUR 1.5KG"}
    bad = client.post("/api/v2/data-health/merge", headers=admin,
                      json={"kind": "product", "canonical": "ZEPOXY TABLE TOP DEEP POUR 15 KG",
                            "variants": ["ZEPOXY TABLE TOP DEEP POUR 1.5 KG"]})
    assert bad.status_code == 400

    boss = login(client, "boss", "pass1234")
    assert client.post("/api/v2/data-health/ignore", headers=boss,
                       json={"kind": "product", "key": groups[0]["key"]}).status_code == 403
    assert client.post("/api/v2/data-health/ignore", headers=admin,
                       json={"kind": "product", "key": groups[0]["key"]}).status_code == 200
    h = client.get("/api/v2/data-health", headers=admin).json()
    assert not any(g["key"] == groups[0]["key"] for g in h["products"]["groups"])
    assert h["ignored"]["product"] == 1
    assert client.post("/api/v2/data-health/ignore/reset", headers=admin).json()["removed"] == 1


# ---------------------------------------------------------------------------
# Safer import (repeat warning, totals check, undo) and consistent names
# ---------------------------------------------------------------------------

def _datewise_xlsx(rows):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Sales"
    ws.append(["Sales Person", "Client Name", "Product", "Date", "Quantity", "Amount"])
    for r in rows:
        ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_import_repeat_warning_check_and_undo(client, admin):
    client.post("/api/teams", json={"name": "Import Team"}, headers=admin)
    raw_sale("Import Team", "Ali", "Old Customer", "ZEPOXY TABLE TOP DEEP POUR 1.5 KG", "2026-01-05", 1)
    content = _datewise_xlsx([
        ("Ali", "Alpha Traders", "WATER GUARD 491 16 KG", "2026-09-01", 2016, 1000),
        ("Ali", "Alpha Traders", "ZEPOXY TABLE TOP DEEP POUR 1.5KG", "2026-09-02", 84, 500),
        ("Ali", "Alpha Traders", "ZEPOXY TABLE TOP DEEP POUR 15 KG", "2026-09-02", 720, 900),
        ("", "Beta", "WATER GUARD 491 16 KG", "2026-09-03", 5, 0),          # skipped: no salesperson
        ("Ali", "Beta", "WATER GUARD 491 16 KG", "not a date", 7, 0),       # skipped: bad date
    ])
    up = lambda extra="": client.post(f"/data/upload?team=Import Team&mode=append{extra}", headers=admin,
                                      files={"file": ("sep.xlsx", io.BytesIO(content))})
    r = up()
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["inserted_rows"] == 3
    chk = body["check"]
    assert chk["skipped_rows"] == 2 and not chk["ok"]
    water = next(p for p in chk["products"] if p["product"] == "WATER GUARD 491 16 KG")
    assert water["file_qty"] == 2028 and water["saved_qty"] == 2016 and water["difference"] == -12
    # 1.5KG was saved under the existing spelling "1.5 KG"; 15 KG stayed separate
    small = next(p for p in chk["products"] if p["product"] == "ZEPOXY TABLE TOP DEEP POUR 1.5 KG")
    assert small["saved_qty"] == 84 and small["difference"] == 0
    big = next(p for p in chk["products"] if p["product"] == "ZEPOXY TABLE TOP DEEP POUR 15 KG")
    assert big["saved_qty"] == 720

    # same file again -> warning, nothing saved
    again = up()
    assert again.status_code == 409
    d = again.json()["detail"]
    assert d["code"] == "repeat_import" and d["same_file"] and d["overlap_lines"] == 3
    # forced import goes through
    forced = up("&force=true")
    assert forced.status_code == 200
    imports = client.get("/api/v2/imports", headers=admin).json()["imports"]
    assert len([i for i in imports if i["team"] == "Import Team"]) == 2

    # undo the forced one
    iid = forced.json()["import_id"]
    assert client.post(f"/api/v2/imports/{iid}/undo", json={}, headers=admin).status_code == 400
    u = client.post(f"/api/v2/imports/{iid}/undo", json={"confirm": "UNDO"}, headers=admin)
    assert u.status_code == 200 and u.json()["removed"] == 3
    assert client.post(f"/api/v2/imports/{iid}/undo", json={"confirm": "UNDO"}, headers=admin).status_code == 400
    rep = client.get("/api/product-contribution-report?year=2026&team=Import Team", headers=admin).json()
    assert rep["overall_total_qty"] == 1 + 2016 + 84 + 720
    actions = {e["action"] for e in client.get("/api/v2/audit", headers=admin).json()["events"]}
    assert {"sales.upload", "sales.import_undo"} <= actions


def test_member_cannot_undo_other_team_import(client, admin, org):
    imports = client.get("/api/v2/imports", headers=admin).json()["imports"]
    iid = next(i["id"] for i in imports if i["team"] == "Import Team" and not i["undone_at"])
    member = login(client, "khi_coord", "pass1234")
    r = client.post(f"/api/v2/imports/{iid}/undo", json={"confirm": "UNDO"}, headers=member)
    assert r.status_code == 403


def test_entry_reuses_existing_spelling(client, admin):
    client.post("/api/teams", json={"name": "Spell Team"}, headers=admin)
    raw_sale("Spell Team", "Ali", "ABC Traders", "Tile Bond 20 KG", "2026-02-01", 1)
    _raw_sql("INSERT INTO clients (name) VALUES ('ABC Traders') ON CONFLICT DO NOTHING")
    _raw_sql("INSERT INTO products (name) VALUES ('Tile Bond 20 KG') ON CONFLICT DO NOTHING")
    r = client.post("/data/entry", headers=admin, json={"team": "Spell Team", "sales_person": "Ali",
                                                        "client_name": "abc traders", "product": "tile bond 20kg",
                                                        "entry_date": "2026-02-02", "quantity": 3})
    assert r.status_code == 200
    saved = r.json()["saved"]
    assert saved["client_name"] == "ABC Traders" and saved["product"] == "Tile Bond 20 KG"
    # a different pack size is a different product
    r = client.post("/data/entry", headers=admin, json={"team": "Spell Team", "sales_person": "Ali",
                                                        "client_name": "ABC Traders", "product": "Tile Bond 2.0 KG",
                                                        "entry_date": "2026-02-02", "quantity": 1})
    assert r.json()["saved"]["product"] == "Tile Bond 2.0 KG"
    m = client.get("/api/v2/names/match?kind=client&name=ABC  traders.", headers=admin).json()
    assert m["saved_as"] == "ABC Traders" and m["changed"] and not m["is_new"]
    m = client.get("/api/v2/names/match?kind=client&name=Brand New Co", headers=admin).json()
    assert m["is_new"] and not m["changed"]
    # visits too, including several products in one visit
    v = {"team": "Spell Team", "sales_person": "Ali", "client_name": "ABC TRADERS", "client_category": "",
         "product": "tile bond 20kg, Something New", "meeting_date": "2026-02-03", "meeting_time": "10:00",
         "meeting_type": "Visit", "meeting_status": "Done", "client_response": "", "notes": ""}
    assert client.post("/api/visit-entry", json=v, headers=admin).status_code == 200
    rows = client.get("/api/visit-entries?team=Spell Team", headers=admin).json()
    rows = rows.get("visits", rows) if isinstance(rows, dict) else rows
    assert any(x["client_name"] == "ABC Traders" and x["product"] == "Tile Bond 20 KG, Something New" for x in rows)
    # admin product list refuses a second spelling
    assert client.post("/api/products", json={"name": "TILE BOND 20kg"}, headers=admin).status_code == 409


def test_monthly_workbook_import_and_check(client, admin):
    from openpyxl import Workbook
    client.post("/api/teams", json={"name": "Monthly Team"}, headers=admin)
    wb = Workbook()
    ws = wb.active
    ws.title = "2025"
    ws.append(["Sales Person", "Client Name", "Product", "Jan", "Feb", "Mar"])
    ws.append(["Sara", "Gamma Co", "Tile Grout 5 KG", 10, 0, 4.5])
    ws.append(["Sara", None, "Tile Grout 5 KG", 3, None, None])  # no customer -> skipped
    buf = io.BytesIO()
    wb.save(buf)
    r = client.post("/data/upload?team=Monthly Team&mode=append", headers=admin,
                    files={"file": ("m.xlsx", io.BytesIO(buf.getvalue()))})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["mode"] == "monthly_excel" and b["inserted_rows"] == 2
    assert b["check"]["file_qty"] == 17.5 and b["check"]["saved_qty"] == 14.5 and b["check"]["skipped_rows"] == 1
    assert b["date_from"] == "2025-01-01" and b["date_to"] == "2025-03-01"


def test_boss_agent_health_and_errors(client, monkeypatch):
    monkeypatch.delenv("BOSS_AGENT_KEY", raising=False)
    h = client.get("/api/boss-agent/health").json()
    assert h["status"] == "problem" and not h["boss_agent_key_configured"] and h["database"] == "ok"
    r = client.post("/api/boss-agent", json={"question": "total sales"}, headers={"x-boss-agent-key": "x"})
    assert r.status_code == 500 and "BOSS_AGENT_KEY" in r.json()["detail"]
    monkeypatch.setenv("BOSS_AGENT_KEY", "k1")
    h = client.get("/api/boss-agent/health", headers={"x-boss-agent-key": "k1"}).json()
    assert h["status"] == "ok" and h["key_matches"] and "k1" not in str(h)
    assert client.get("/api/boss-agent/health", headers={"x-boss-agent-key": "bad"}).json()["status"] == "problem"
    r = client.post("/api/boss-agent", json={"question": "total sales 2026"}, headers={"x-boss-agent-key": "k1"})
    assert r.status_code == 200
