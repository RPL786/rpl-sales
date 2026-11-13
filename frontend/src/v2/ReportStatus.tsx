import { Fragment, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, FileSpreadsheet, Loader2, RefreshCw } from "lucide-react";
import { apiBaseUrl, apiJson } from "./authFetch";

type Cell = {
  date: string;
  status: "reported" | "leave" | "missing" | "off" | "na" | "today";
  visits: number;
  leave?: { reason: string; note: string; status: "pending" | "approved" | "rejected" };
};
type Person = {
  username: string;
  team: string;
  role: string;
  days: Cell[];
  totals: { reported: number; leave: number; missing: number };
};
type Data = {
  from: string;
  to: string;
  dates: { date: string; weekday: string; sunday: boolean }[];
  people: Person[];
  missing: { date: string; weekday: string; username: string; team: string }[];
  on_leave: { date: string; username: string; team: string; reason: string; note: string; status: string }[];
  summary: { people: number; reported_days: number; leave_days: number; missing_days: number };
};

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const approval = (s: string) => (s === "approved" ? "Approved" : s === "rejected" ? "Not approved" : "Pending");
const tone = (s: string) => (s === "approved" ? "tone-good" : s === "rejected" ? "tone-bad" : "tone-warn");

function presets() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return [
    { label: "This week", from: iso(monday), to: iso(now) },
    { label: "This month", from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) },
    {
      label: "Last month",
      from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
    },
  ];
}

/** For every salesperson and day: reported (visits), on leave (with approval), Sunday, or missing. */
export default function ReportStatus() {
  const [range, setRange] = useState(presets()[1]);
  const [team, setTeam] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [teams, setTeams] = useState<string[]>([]);

  useEffect(() => {
    setLoading(true);
    setError("");
    const qs = new URLSearchParams({ date_from: range.from, date_to: range.to, ...(team ? { team } : {}) });
    apiJson<Data>(`/api/v2/visits/report-status?${qs}`)
      .then((r) => {
        setData(r);
        if (!team) setTeams(Array.from(new Set(r.people.map((p) => p.team).filter(Boolean))).sort());
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [range, team, tick]);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams({ date_from: range.from, date_to: range.to, ...(team ? { team } : {}) });
      const res = await fetch(`${apiBaseUrl()}/api/v2/visits/report-status/export?${qs}`);
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = `report_status_${range.from}_to_${range.to}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };

  const groups = useMemo(() => {
    const g: Record<string, Person[]> = {};
    (data?.people || []).forEach((p) => (g[p.team || "—"] ||= []).push(p));
    return Object.entries(g);
  }, [data]);
  const activePreset = presets().find((p) => p.from === range.from && p.to === range.to)?.label;
  const s = data?.summary;
  const single = (data?.people.length || 0) <= 1;

  return (
    <div className="v2-stack v2-rs">
      <div className="card">
        <div className="section-head v2-wrap">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ClipboardCheck size={20} /> Daily report status
            </h2>
            <p className="section-subtext">
              For every day: visits reported, on leave (with approval), or report missing. Sundays are shown grey.
            </p>
          </div>
          <div className="org-form-row">
            <button className="action-btn" disabled={exporting || !data?.people.length} onClick={exportXlsx}>
              {exporting ? <Loader2 size={15} className="v2-spin" /> : <FileSpreadsheet size={15} />} Excel
            </button>
            <button className="ghost-btn" onClick={() => setTick((n) => n + 1)} aria-label="Refresh">
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        <div className="v2-vs-dates">
          {presets().map((p) => (
            <button key={p.label} className={`v2-pick ${activePreset === p.label ? "active" : ""}`} onClick={() => setRange(p)}>
              {p.label}
            </button>
          ))}
          <input className="filter-select" type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
          <span className="org-muted">to</span>
          <input className="filter-select" type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          {teams.length > 1 && (
            <select className="filter-select" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All teams</option>
              {teams.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          )}
          {loading && <Loader2 size={16} className="v2-spin" />}
        </div>

        {s && (
          <div className="v2-vs-summary">
            {!single && (
              <span>
                <b>{s.people}</b> salespeople
              </span>
            )}
            <span>
              <b>{s.reported_days}</b> days reported
            </span>
            <span>
              <b className="rs-blue">{s.leave_days}</b> leave days
            </span>
            <span className={s.missing_days ? "warn" : ""}>
              <b>{s.missing_days}</b> missing reports
            </span>
          </div>
        )}
        <div className="v2-rs-legend">
          <span><i className="rs-cell reported">3</i> visits reported</span>
          <span><i className="rs-cell leave approved">L</i> leave (approved)</span>
          <span><i className="rs-cell leave pending">L</i> leave (pending)</span>
          <span><i className="rs-cell leave rejected">L</i> leave (not approved)</span>
          <span><i className="rs-cell missing">✕</i> report missing</span>
          <span><i className="rs-cell off" /> Sunday</span>
          <span><i className="rs-cell today">·</i> today, nothing yet</span>
        </div>
        {error && <div className="status error">{error}</div>}
      </div>

      {data && data.people.length > 0 && (
        <div className="card">
          <div className="table-wrap v2-rs-wrap">
            <table className="v2-rs-table">
              <thead>
                <tr>
                  <th className="rs-sticky">Salesperson</th>
                  {data.dates.map((d) => (
                    <th key={d.date} className={d.sunday ? "rs-sun" : ""}>
                      <small>{d.weekday.slice(0, 2)}</small>
                      {Number(d.date.slice(8))}
                    </th>
                  ))}
                  <th>Rep.</th>
                  <th>Leave</th>
                  <th>Miss.</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(([teamName, people]) => (
                  <Fragment key={teamName}>
                    {groups.length > 1 && (
                      <tr className="rs-team">
                        <td className="rs-sticky" colSpan={1}>
                          {teamName}
                        </td>
                        <td colSpan={data.dates.length + 3} />
                      </tr>
                    )}
                    {people.map((p) => (
                      <tr key={p.username}>
                        <td className="rs-sticky">
                          <strong>{p.username}</strong>
                          {p.role === "team_leader" && <small> TL</small>}
                        </td>
                        {p.days.map((c) => (
                          <td key={c.date}>
                            <span
                              className={`rs-cell ${c.status} ${c.leave ? c.leave.status : ""}`}
                              title={
                                c.status === "reported"
                                  ? `${c.date}: ${c.visits} visit${c.visits === 1 ? "" : "s"}`
                                  : c.status === "leave"
                                  ? `${c.date}: on leave — ${c.leave!.reason}${c.leave!.note ? ` (${c.leave!.note})` : ""} — ${approval(c.leave!.status)}`
                                  : c.status === "missing"
                                  ? `${c.date}: report missing`
                                  : c.status === "off"
                                  ? `${c.date}: Sunday`
                                  : c.status === "today"
                                  ? `${c.date}: today — no visit yet`
                                  : `${c.date}: not in this team yet`
                              }
                            >
                              {c.status === "reported" ? c.visits : c.status === "leave" ? "L" : c.status === "missing" ? "✕" : c.status === "today" ? "·" : ""}
                            </span>
                          </td>
                        ))}
                        <td className="rs-num">{p.totals.reported}</td>
                        <td className="rs-num rs-blue">{p.totals.leave}</td>
                        <td className={`rs-num ${p.totals.missing ? "rs-red" : ""}`}>{p.totals.missing}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && (
        <div className="v2-leave-grid">
          <div className="card">
            <h3 className="v2-leave-title">Missing reports ({data.missing.length})</h3>
            {data.missing.length === 0 && <p className="org-muted">No missing reports in this period. 🎉</p>}
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
              {data.missing.length > 0 && (
                <table className="data-table v2-compact-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Day</th>
                      <th>Salesperson</th>
                      <th>Team</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.missing.map((m) => (
                      <tr key={`${m.date}-${m.username}`} style={{ cursor: "default" }}>
                        <td>{m.date}</td>
                        <td>{m.weekday}</td>
                        <td>{m.username}</td>
                        <td>{m.team}</td>
                        <td>
                          <span className="v2-status tone-bad">Report missing</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div className="card">
            <h3 className="v2-leave-title">On leave ({data.on_leave.length})</h3>
            {data.on_leave.length === 0 && <p className="org-muted">No leave in this period.</p>}
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
              {data.on_leave.length > 0 && (
                <table className="data-table v2-compact-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Salesperson</th>
                      <th>Reason</th>
                      <th>Approval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.on_leave.map((l) => (
                      <tr key={`${l.date}-${l.username}`} style={{ cursor: "default" }}>
                        <td>{l.date}</td>
                        <td>
                          {l.username}
                          <small className="v2-vs-sub">{l.team}</small>
                        </td>
                        <td>
                          {l.reason}
                          {l.note && <small className="v2-vs-sub">{l.note}</small>}
                        </td>
                        <td>
                          <span className={`v2-status ${tone(l.status)}`}>{approval(l.status)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
