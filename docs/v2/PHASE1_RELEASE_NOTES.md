# RPL Sales V2 — Phase 1 Release Notes & Staging Guide

Branch: `v2` · Status: **ready for staging test. Not for production yet.**

## What's new

### Organization structure (City → Branch → Team)
- New tables: `org_cities`, `org_branches`, plus `teams.branch_id` (nullable, so V1 teams keep working without a branch).
- `team_branch_history`: when a team moves branch, the old row is closed with an end date. **Old history is not rewritten.**
- Admin → **Administration → Organization** screen: add cities and branches, map teams to branches (with effective date), and activate/deactivate cities and branches.

### Roles + Scope
| Role key | Label | Scope |
|---|---|---|
| `admin` | Super Admin | Entire org, all admin actions |
| `super_user` | Boss / Executive | Entire org, view + audit (no admin changes) |
| `city_coordinator` (new) | City Coordinator | Assigned city/branch/team, view only |
| `dashboard_admin` (new) | Dashboard Admin | Assigned scope: upload, data entry, visits on behalf of employees |
| `team_leader` | Team Leader | Own team (V1 rule as-is) |
| `user` | Team Member | Own records (V1 rule as-is) |

- `user_scopes`: a user can get one or more city / branch / team / org scopes.
- The **backend** enforces scope on: dashboard/db, teams list, form options, forecast, data entries, visits, product report and upload.
- Role or active-status changes apply **immediately** (no need to wait for the token to expire).

### Day / Night mode
- Night = the current premium dark look (unchanged). Day = a polished light theme on the same layout.
- The sun/moon toggle sits in the header. The choice is saved per user, in the browser and in the profile (`user_preferences`).

### Navigation + filters
- Tabs are grouped: **Sales Intelligence · Field Operations · Administration**.
- Global Filters now have **City** and **Branch**, which narrow the Team list.

### Audit trail
- `audit_events`: city/branch create/update, team branch move, team rename/delete, role/scope change, sales upload and DB clear are recorded. View them on the Organization screen.

### Security fixes
See `PHASE0_BASELINE.md` §2 (S1–S6, S9).

## DB migration
- Runs automatically at startup (`v2/schema.py`): only `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`. **There is no DROP and no V1 data update.**
- Running it more than once is safe (idempotent; tested).

## Staging deploy steps (VPS)
1. Do the Phase 0 checklist (backup + restore test).
2. Make a separate folder: `git clone -b v2 https://github.com/RPL786/rpl-sales.git rpl-sales-v2`
3. Copy V1's `.env` into `backend/.env` and **change `POSTGRES_DB=rpl_v2_staging`**. Never point it at the production DB.
4. `cd frontend && npm ci && npm run build`
5. `cd backend && pip install -r requirements.txt && uvicorn api:app --host 127.0.0.1 --port 8100`
6. Put it behind a separate subdomain or port, e.g. `v2-staging.<domain>`. V1 keeps running on its current port.

## Run the tests
```bash
# throwaway Postgres DB whose name contains "test"
export POSTGRES_HOST=... POSTGRES_PORT=... POSTGRES_USER=... POSTGRES_PASSWORD=... POSTGRES_DB=rpl_v2_test
export JWT_SECRET_KEY=<32+ chars>
python -m pytest backend/tests -q
```
The test suite **drops and recreates** the DB, so it refuses any DB name that doesn't contain "test".

## Staging acceptance checklist
- [ ] Admin login, all V1 tabs work (Overview, Clients, Products, Team, Forecast, Visit, Data Entry, Admin)
- [ ] Add cities (Karachi, Lahore, Hub), add branches, map every team to a branch
- [ ] Create a City Coordinator with Karachi scope → only Karachi teams are visible, Lahore team gives 403
- [ ] Dashboard Admin with one team scope → upload works for that team; upload to another team is blocked
- [ ] Team Leader / Member: behavior same as V1
- [ ] Day/Night toggle survives refresh and re-login
- [ ] Deactivate a user → that user's session ends immediately
- [ ] Audit trail shows all changes

## Known limits / next phases
- After a DB clear, team scopes and branch mapping must be set again (teams are recreated).
- Unsaved Visit form drafts from before the upgrade won't show (the key is now per user).
- **Phase 2:** SAP Smart Import. **Phase 3:** Sales Allocation/Approval. **Phase 4:** Dynamic multi-year analytics (the current V1 analytics still compare only the latest 2 years).
- Open decisions (master strategy §16) are still pending. In particular, the actual city/branch codes (e.g. KHI-D83, HUB, LHR) must be entered by the admin; Phase 1 does not hard-code them.
