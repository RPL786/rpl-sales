import { useEffect, useMemo, useState } from "react";
import { Building2, History, MapPin, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { apiJson } from "./authFetch";

type Team = { id: number; name: string; branch_id: number | null; is_active: boolean };
type Branch = { id: number; city_id: number; code: string; name: string; is_active: boolean; teams: Team[] };
type City = { id: number; code: string; name: string; is_active: boolean; branches: Branch[] };
type Tree = { cities: City[]; unassigned_teams: Team[] };
type Scope = { scope_type: "org" | "city" | "branch" | "team"; scope_id: number | null };
type UserRow = { id: number; username: string; role: string; role_label: string; team: string; is_active: boolean; scopes: Scope[] };
type RoleDef = { key: string; label: string; org_wide: boolean; needs_team: boolean };
type AuditEvent = { id: number; occurred_at: string; actor: string; action: string; entity_type: string; entity_id: string; details: any };

const today = () => new Date().toISOString().slice(0, 10);

export default function OrgAdmin() {
  const [tree, setTree] = useState<Tree>({ cities: [], unassigned_teams: [] });
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [cityForm, setCityForm] = useState({ code: "", name: "" });
  const [branchForm, setBranchForm] = useState({ city_id: "", code: "", name: "" });
  const [teamMove, setTeamMove] = useState<Record<number, { branch_id: string; effective_date: string }>>({});
  const [scopeDraft, setScopeDraft] = useState<Record<number, { scope_type: Scope["scope_type"]; scope_id: string }>>({});

  const branches = useMemo(() => tree.cities.flatMap((c) => c.branches.map((b) => ({ ...b, city: c }))), [tree]);
  const allTeams = useMemo(
    () => [...branches.flatMap((b) => b.teams), ...tree.unassigned_teams].sort((a, b) => a.name.localeCompare(b.name)),
    [branches, tree.unassigned_teams]
  );

  const label = (s: Scope) => {
    if (s.scope_type === "org") return "Entire organization";
    if (s.scope_type === "city") return `City: ${tree.cities.find((c) => c.id === s.scope_id)?.name ?? s.scope_id}`;
    if (s.scope_type === "branch") {
      const b = branches.find((x) => x.id === s.scope_id);
      return `Branch: ${b ? `${b.city.name} / ${b.name}` : s.scope_id}`;
    }
    return `Team: ${allTeams.find((t) => t.id === s.scope_id)?.name ?? s.scope_id}`;
  };

  const loadAll = async () => {
    setBusy(true);
    try {
      const [t, u, r, a] = await Promise.all([
        apiJson<Tree>("/api/v2/org/tree"),
        apiJson<{ users: UserRow[] }>("/api/v2/users"),
        apiJson<{ roles: RoleDef[] }>("/api/v2/roles"),
        apiJson<{ events: AuditEvent[] }>("/api/v2/audit?limit=40"),
      ]);
      setTree(t);
      setUsers(u.users);
      setRoles(r.roles);
      setEvents(a.events);
    } catch (e: any) {
      setMsg({ kind: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const run = async (fn: () => Promise<any>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "success", text: ok });
      await loadAll();
    } catch (e: any) {
      setMsg({ kind: "error", text: e.message });
    }
  };

  const addCity = () =>
    run(
      () => apiJson("/api/v2/org/cities", { method: "POST", body: JSON.stringify(cityForm) }).then(() => setCityForm({ code: "", name: "" })),
      "City added"
    );

  const addBranch = () =>
    run(
      () =>
        apiJson("/api/v2/org/branches", {
          method: "POST",
          body: JSON.stringify({ ...branchForm, city_id: Number(branchForm.city_id) }),
        }).then(() => setBranchForm({ city_id: branchForm.city_id, code: "", name: "" })),
      "Branch added"
    );

  const toggleCity = (c: City) =>
    run(
      () => apiJson(`/api/v2/org/cities/${c.id}`, { method: "PUT", body: JSON.stringify({ code: c.code, name: c.name, is_active: !c.is_active }) }),
      c.is_active ? "City deactivated" : "City activated"
    );

  const toggleBranch = (b: Branch) =>
    run(
      () =>
        apiJson(`/api/v2/org/branches/${b.id}`, {
          method: "PUT",
          body: JSON.stringify({ city_id: b.city_id, code: b.code, name: b.name, is_active: !b.is_active }),
        }),
      b.is_active ? "Branch deactivated" : "Branch activated"
    );

  const moveTeam = (team: Team) => {
    const d = teamMove[team.id] ?? { branch_id: String(team.branch_id ?? ""), effective_date: today() };
    return run(
      () =>
        apiJson(`/api/v2/org/teams/${team.id}/branch`, {
          method: "PUT",
          body: JSON.stringify({ branch_id: d.branch_id ? Number(d.branch_id) : null, effective_date: d.effective_date || today() }),
        }),
      `${team.name}: branch updated (history kept)`
    );
  };

  const saveScopes = (u: UserRow, scopes: Scope[]) =>
    run(() => apiJson(`/api/v2/users/${u.id}/scopes`, { method: "PUT", body: JSON.stringify({ scopes }) }), `${u.username}: scope saved`);

  const addScope = (u: UserRow) => {
    const d = scopeDraft[u.id] ?? { scope_type: "branch", scope_id: "" };
    if (d.scope_type !== "org" && !d.scope_id) {
      setMsg({ kind: "error", text: "Pehle scope target select karein" });
      return;
    }
    const next: Scope = { scope_type: d.scope_type, scope_id: d.scope_type === "org" ? null : Number(d.scope_id) };
    saveScopes(u, [...u.scopes, next]);
  };

  const changeRole = (u: UserRow, role: string) =>
    run(() => apiJson(`/api/v2/users/${u.id}/role`, { method: "PUT", body: JSON.stringify({ role }) }), `${u.username}: role updated (user ko dobara login karna hoga)`);

  const scopeTargets = (type: Scope["scope_type"]) => {
    if (type === "city") return tree.cities.map((c) => ({ id: c.id, name: c.name }));
    if (type === "branch") return branches.map((b) => ({ id: b.id, name: `${b.city.name} / ${b.name}` }));
    if (type === "team") return allTeams.map((t) => ({ id: t.id, name: t.name }));
    return [];
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <div className="section-head">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Building2 size={20} /> Organization Structure
            </h2>
            <p className="section-subtext">City → Branch → Team. Team ko branch move karne se purani history change nahi hoti.</p>
          </div>
          <button className="ghost-btn" onClick={loadAll} disabled={busy}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        {msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}

        <div className="org-grid">
          <div>
            {tree.cities.length === 0 && <p className="org-muted">Abhi koi city add nahi hui. Pehle Karachi, Lahore, Hub jaisi cities add karein.</p>}
            {tree.cities.map((c) => (
              <div className="org-city" key={c.id} style={{ opacity: c.is_active ? 1 : 0.55 }}>
                <div className="org-city-head">
                  <strong style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <MapPin size={15} /> {c.name} <span className="org-code">{c.code}</span>
                  </strong>
                  <button className="ghost-btn" onClick={() => toggleCity(c)}>{c.is_active ? "Deactivate" : "Activate"}</button>
                </div>
                {c.branches.length === 0 && <p className="org-muted">Is city mein abhi koi branch nahi.</p>}
                {c.branches.map((b) => (
                  <div className="org-branch" key={b.id} style={{ opacity: b.is_active ? 1 : 0.55 }}>
                    <div className="org-branch-head">
                      <span>
                        {b.name} <span className="org-code">{b.code}</span>
                      </span>
                      <button className="ghost-btn" onClick={() => toggleBranch(b)}>{b.is_active ? "Deactivate" : "Activate"}</button>
                    </div>
                    <div className="org-team-row">
                      {b.teams.length === 0 ? <span className="org-muted">No teams</span> : b.teams.map((t) => <span className="org-team-chip" key={t.id}>{t.name}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div>
            <h3 style={{ margin: "0 0 4px" }}>Add City</h3>
            <div className="org-form-row">
              <input className="filter-select" placeholder="Code (KHI)" value={cityForm.code} onChange={(e) => setCityForm({ ...cityForm, code: e.target.value.toUpperCase() })} />
              <input className="filter-select" placeholder="Name (Karachi)" value={cityForm.name} onChange={(e) => setCityForm({ ...cityForm, name: e.target.value })} />
              <button className="action-btn primary-btn" onClick={addCity}>Add City</button>
            </div>

            <h3 style={{ margin: "18px 0 4px" }}>Add Branch</h3>
            <div className="org-form-row">
              <select className="filter-select" value={branchForm.city_id} onChange={(e) => setBranchForm({ ...branchForm, city_id: e.target.value })}>
                <option value="">Select city</option>
                {tree.cities.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <input className="filter-select" placeholder="Code (KHI-D83)" value={branchForm.code} onChange={(e) => setBranchForm({ ...branchForm, code: e.target.value.toUpperCase() })} />
              <input className="filter-select" placeholder="Name (D83)" value={branchForm.name} onChange={(e) => setBranchForm({ ...branchForm, name: e.target.value })} />
              <button className="action-btn primary-btn" onClick={addBranch} disabled={!branchForm.city_id}>Add Branch</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h2>Team → Branch Mapping</h2>
            <p className="section-subtext">Effective date se team naye branch mein jayegi; is date se pehle ka data purane branch mein rahega.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Team</th><th>Current branch</th><th>New branch</th><th>Effective date</th><th></th></tr>
            </thead>
            <tbody>
              {allTeams.map((t) => {
                const cur = branches.find((b) => b.id === t.branch_id);
                const d = teamMove[t.id] ?? { branch_id: String(t.branch_id ?? ""), effective_date: today() };
                return (
                  <tr key={t.id} style={{ cursor: "default" }}>
                    <td>{t.name}</td>
                    <td>{cur ? `${cur.city.name} / ${cur.name}` : <span className="org-muted">Not mapped</span>}</td>
                    <td>
                      <select className="filter-select" value={d.branch_id} onChange={(e) => setTeamMove({ ...teamMove, [t.id]: { ...d, branch_id: e.target.value } })}>
                        <option value="">— Not mapped —</option>
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>{b.city.name} / {b.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="date" className="filter-select" value={d.effective_date} onChange={(e) => setTeamMove({ ...teamMove, [t.id]: { ...d, effective_date: e.target.value } })} />
                    </td>
                    <td>
                      <button className="action-btn" onClick={() => moveTeam(t)} disabled={String(t.branch_id ?? "") === d.branch_id}>Save</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ShieldCheck size={20} /> Roles &amp; Access Scope
            </h2>
            <p className="section-subtext">Role = kya kar sakta hai. Scope = kahan (city / branch / team). Team Leader aur Member ko apni home team khud milti hai.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th><Users size={14} /> User</th><th>Role</th><th>Home team</th><th>Extra scope</th><th>Add scope</th></tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const d = scopeDraft[u.id] ?? { scope_type: "branch" as const, scope_id: "" };
                const roleDef = roles.find((r) => r.key === u.role);
                return (
                  <tr key={u.id} style={{ cursor: "default", opacity: u.is_active ? 1 : 0.5 }}>
                    <td>{u.username}</td>
                    <td>
                      <select className="filter-select" value={u.role} onChange={(e) => changeRole(u, e.target.value)}>
                        {roles.map((r) => (
                          <option key={r.key} value={r.key}>{r.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>{u.team || <span className="org-muted">—</span>}</td>
                    <td>
                      {roleDef?.org_wide ? (
                        <span className="org-muted">Entire organization (role)</span>
                      ) : u.role === "user" ? (
                        <span className="org-muted">Sirf apna record</span>
                      ) : (
                        <div className="org-scope-list">
                          {u.scopes.length === 0 && <span className="org-muted">None</span>}
                          {u.scopes.map((s, i) => (
                            <span className="org-scope-chip" key={`${s.scope_type}-${s.scope_id}`}>
                              {label(s)}
                              <button aria-label="Remove scope" onClick={() => saveScopes(u, u.scopes.filter((_, j) => j !== i))}>×</button>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {!roleDef?.org_wide && u.role !== "user" && (
                        <div className="org-form-row" style={{ marginTop: 0 }}>
                          <select className="filter-select" value={d.scope_type} onChange={(e) => setScopeDraft({ ...scopeDraft, [u.id]: { scope_type: e.target.value as Scope["scope_type"], scope_id: "" } })}>
                            <option value="city">City</option>
                            <option value="branch">Branch</option>
                            <option value="team">Team</option>
                            <option value="org">Entire org</option>
                          </select>
                          {d.scope_type !== "org" && (
                            <select className="filter-select" value={d.scope_id} onChange={(e) => setScopeDraft({ ...scopeDraft, [u.id]: { ...d, scope_id: e.target.value } })}>
                              <option value="">Select…</option>
                              {scopeTargets(d.scope_type).map((x) => (
                                <option key={x.id} value={x.id}>{x.name}</option>
                              ))}
                            </select>
                          )}
                          <button className="action-btn" onClick={() => addScope(u)}>Add</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <History size={20} /> Audit Trail
            </h2>
            <p className="section-subtext">Structure, role, scope aur upload changes ka record.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={4} className="org-muted">No events yet</td></tr>
              )}
              {events.map((e) => (
                <tr key={e.id} style={{ cursor: "default" }}>
                  <td>{new Date(e.occurred_at).toLocaleString()}</td>
                  <td>{e.actor || "—"}</td>
                  <td>{e.action}</td>
                  <td style={{ fontSize: 12, maxWidth: 420, wordBreak: "break-word" }}>{JSON.stringify(e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
