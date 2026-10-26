# RPL Sales V2 — Phase 0 Baseline (21 Oct 2026)

This is a review of the V1 code (`main`, commit `8df311e`). Its purpose is to lock in a safe starting point before V2.

## 1. Current system snapshot

| Area | Finding |
|---|---|
| Backend | FastAPI, a single file `backend/api.py` (~6,200 lines, 56 endpoints) plus `auth_utils.py` and `sales_auditor.py` |
| DB | PostgreSQL via psycopg2 (env `POSTGRES_*`). Schema is created at startup by `ensure_database_schema()` |
| Frontend | React 19 + Vite + TS. `App.tsx` ~2,900 lines with 11 tabs; components: VisitForm, DataEntry, AdminPanel, Forecast, ProductContribution, RessiBot |
| Roles | `admin`, `super_user`, `team_leader`, `user`, all set in the JWT (12h expiry) |
| Teams | Linked everywhere by **team name** (TEXT), not by id. `user_team_history` already has start/end dates |
| Years | `load_database_data` compares only the **last 2 years** (`years[-2]`, `years[-1]`). Multi-year comes in Phase 4 |
| Sales attribution | `sales_entries.sales_person` is free text. There are no SAP fields (invoice no, SAP employee) |

## 2. Security findings (V1 live is affected)

| # | Issue | Risk | V2 status |
|---|---|---|---|
| S1 | `POST /data/upload` had **no login check**. `mode=replace` deletes a team's whole sales data | **Critical** | Fixed: login + upload permission + scope |
| S2 | `PUT /form/team/rename` had no login. It renames the team and also updates `sales_entries` | **High** | Fixed: admin only + audit |
| S3 | `POST /form/team`, `POST /upload`, `POST /reset`, `GET /dashboard`, `GET /forecast`, `GET /form/options`, `POST /salesperson-insights` had no login | High/Medium | Fixed |
| S4 | `GET /api/product-contribution-report` showed **every team** to any logged-in user | Medium | Fixed: scope filter |
| S5 | A deactivated user's token kept working for 12 hours; role changes only applied after re-login | Medium | Fixed: role/team/is_active are read from the DB on every request |
| S6 | `super_user` could call `/admin/clear-database` | Medium | Fixed: Super Admin only + audit |
| S7 | `ADMIN_CLEAR_PASSWORD = "chai123"` hard-coded (unused). Default admin password `admin123` if `.env` is missing | Low/Medium | Recommend: always set `ADMIN_PASSWORD` in `.env` on the VPS |
| S8 | `backend/data/sales_dashboard.db`, `data/sales_dashboard.db` and `__pycache__` are committed in git | Low | Recommend: remove from repo (check that they hold no real data) |
| S9 | Visit form draft used one shared localStorage key, so one user's draft showed to the next user on the same browser | Low | Fixed: per-user key |

> **Recommendation:** S1 and S2 are dangerous for V1 live. The V2 branch has the fix, but a minimal hotfix is needed on V1 too (see section 5).

## 3. Other technical notes

- On a fresh/staging DB, `api.py` crashed at import (`ai_settings` table missing). Fixed so that a staging DB can now be created.
- `@app.on_event("startup")` is deprecated (works, but should move to lifespan later).
- The frontend bundle is 1.1 MB (one chunk) and `ressibot-car.png` is 1.7 MB. Code-splitting and image compression come in a later phase.
- In `App.tsx` the hooks sit after an early `return` (login screen). It works because `authUser` never changes, but this needs a refactor in the Phase 4/5 UI split.
- Tests: V1 had none. V2 adds `backend/tests/test_v2_phase1.py` (29 tests).

## 4. V1 backup + restore checklist (before any V2 deploy)

1. On the VPS, record the current state: `git -C <app> rev-parse HEAD`, and back up `.env` (store it safely, not in git).
2. DB backup:
   `pg_dump -Fc -h <host> -U <user> <db> > rpl_v1_$(date +%F).dump`
3. **Restore test** (in a separate DB, never in production):
   `createdb rpl_restore_test && pg_restore -d rpl_restore_test rpl_v1_<date>.dump`
   Then compare row counts: `SELECT COUNT(*) FROM sales_entries;` must be the same in both DBs. Check `users`, `visit_entries` and `sales_targets` too.
4. Keep the backup in at least 2 places (VPS + offline).
5. Only then create the V2 staging DB from this dump: `createdb rpl_v2_staging && pg_restore -d rpl_v2_staging ...`

## 5. Proposed V1 hotfix (optional, recommended)

Branch `hotfix/v1-auth` (V1 `main` + minimal changes, no V2 features):
- Backend: `Depends(require_admin)` / `Depends(get_current_user)` on the S1–S3 endpoints
- Frontend: `authFetch.ts`, so every API call sends the token

Before merging, test once on staging: admin uploads, the Forecast tab and the Visit form.
