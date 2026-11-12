import { useEffect, useState } from "react";
import { CalendarOff, Check, Loader2, Lock, RefreshCw, Send, Trash2, X } from "lucide-react";
import { apiJson } from "./authFetch";
import { loadLockStatus, type LockStatus } from "./VisitLock";

type Leave = {
  id: number;
  username: string;
  team: string;
  date_from: string;
  date_to: string;
  days: number;
  reason_type: string;
  note: string;
  status: "pending" | "approved" | "rejected";
  decided_by?: string;
  decided_at?: string;
  decision_note?: string;
  created_at?: string;
  can_decide: boolean;
  can_cancel: boolean;
};
type UnlockReq = {
  id: number;
  username?: string;
  team?: string;
  unlock_date: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  decided_by?: string;
  decision_note?: string;
  expires_at?: string;
  active: boolean;
  can_decide?: boolean;
};

const STATUS_TONE: Record<string, string> = { approved: "tone-good", rejected: "tone-bad", pending: "tone-warn" };
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const range = (l: Leave) => (l.date_from === l.date_to ? l.date_from : `${l.date_from} → ${l.date_to}`);
const pad = (n: number) => String(n).padStart(2, "0");
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function Decide({ onDecide }: { onDecide: (approve: boolean, note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "a" | "r">("");
  const go = async (approve: boolean) => {
    setBusy(approve ? "a" : "r");
    try {
      await onDecide(approve, note);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="v2-decide">
      <input className="filter-select" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="action-btn primary-btn" disabled={!!busy} onClick={() => go(true)}>
        {busy === "a" ? <Loader2 size={14} className="v2-spin" /> : <Check size={14} />} Approve
      </button>
      <button className="action-btn v2-btn-danger" disabled={!!busy} onClick={() => go(false)}>
        {busy === "r" ? <Loader2 size={14} className="v2-spin" /> : <X size={14} />} Reject
      </button>
    </div>
  );
}

/** Leave & visit-date unlock: own requests for everyone, approvals for TL / City Coordinator / Super Admin. */
export default function LeavePage({ role }: { role: string }) {
  const isApproverLeave = ["admin", "city_coordinator", "team_leader"].includes(role);
  const canSeeUnlocks = ["admin", "city_coordinator", "team_leader", "super_user"].includes(role);
  const seesOthers = role !== "user";

  const [lock, setLock] = useState<LockStatus | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [myLeaves, setMyLeaves] = useState<Leave[]>([]);
  const [teamLeaves, setTeamLeaves] = useState<Leave[]>([]);
  const [unlocks, setUnlocks] = useState<UnlockReq[]>([]);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [leaveFilter, setLeaveFilter] = useState<"pending" | "all">("pending");
  const [unlockFilter, setUnlockFilter] = useState<"pending" | "all">("pending");

  const [lf, setLf] = useState({ date_from: todayIso(), date_to: todayIso(), reason_type: "", note: "" });
  const [uf, setUf] = useState({ date: "", reason: "" });
  const [busy, setBusy] = useState("");

  useEffect(() => {
    setError("");
    loadLockStatus(true).then(setLock);
    apiJson<{ leaves: Leave[]; reasons: string[] }>("/api/v2/leaves?mine=true")
      .then((r) => {
        setMyLeaves(r.leaves);
        setReasons(r.reasons);
      })
      .catch((e) => setError(e.message));
    if (seesOthers) {
      apiJson<{ leaves: Leave[] }>(`/api/v2/leaves?status=${leaveFilter}`)
        .then((r) => setTeamLeaves(r.leaves))
        .catch(() => setTeamLeaves([]));
    }
    if (canSeeUnlocks) {
      apiJson<{ requests: UnlockReq[] }>(`/api/v2/visit-unlock/requests?status=${unlockFilter}`)
        .then((r) => setUnlocks(r.requests))
        .catch(() => setUnlocks([]));
    }
  }, [tick, leaveFilter, unlockFilter, seesOthers, canSeeUnlocks]);

  const refresh = (m = "") => {
    setMsg(m);
    setTick((n) => n + 1);
  };

  const call = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      refresh(okMsg);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const addLeave = () =>
    call(
      "leave",
      () => apiJson("/api/v2/leaves", { method: "POST", body: JSON.stringify(lf) }),
      "Leave added. It shows on your calendar now; your manager can approve it."
    ).then(() => setLf((x) => ({ ...x, note: "" })));

  const askUnlock = () =>
    call(
      "unlock",
      () => apiJson("/api/v2/visit-unlock/requests", { method: "POST", body: JSON.stringify(uf) }),
      "Unlock request sent to the City Coordinator / Super Admin."
    ).then(() => setUf({ date: "", reason: "" }));

  const othersLeaves = teamLeaves;

  return (
    <div className="v2-stack v2-leave">
      <div className="card">
        <div className="section-head v2-wrap">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CalendarOff size={20} /> Leave & Unlock
            </h2>
            <p className="section-subtext">
              Mark days you were on leave, and ask for an older visit date to be opened.
              {lock && !lock.exempt && (
                <>
                  {" "}
                  Visits are open for <b>{lock.allowed_dates.slice().reverse().join(", ")}</b> (Sundays are not counted).
                </>
              )}
            </p>
          </div>
          <button className="ghost-btn" onClick={() => refresh()} aria-label="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
        {msg && <div className="status success">{msg}</div>}
        {error && <div className="status error">{error}</div>}
      </div>

      <div className="v2-leave-grid">
        {/* My leave */}
        <div className="card">
          <h3 className="v2-leave-title">
            <CalendarOff size={17} /> Mark leave
          </h3>
          <div className="v2-leave-form">
            <label className="v2-field">
              <span>From</span>
              <input className="filter-select" type="date" value={lf.date_from}
                onChange={(e) => setLf((x) => ({ ...x, date_from: e.target.value, date_to: x.date_to < e.target.value ? e.target.value : x.date_to }))} />
            </label>
            <label className="v2-field">
              <span>To</span>
              <input className="filter-select" type="date" value={lf.date_to} min={lf.date_from}
                onChange={(e) => setLf((x) => ({ ...x, date_to: e.target.value }))} />
            </label>
            <label className="v2-field">
              <span>Reason</span>
              <select className="filter-select" value={lf.reason_type} onChange={(e) => setLf((x) => ({ ...x, reason_type: e.target.value }))}>
                <option value="">Choose…</option>
                {reasons.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label className="v2-field v2-leave-note">
              <span>Details {lf.reason_type === "Other" ? "(required)" : "(optional)"}</span>
              <input className="filter-select" placeholder="e.g. fever, family wedding" value={lf.note}
                onChange={(e) => setLf((x) => ({ ...x, note: e.target.value }))} />
            </label>
          </div>
          <button className="action-btn primary-btn" disabled={busy === "leave" || !lf.reason_type || !lf.date_from} onClick={addLeave}>
            {busy === "leave" ? <Loader2 size={15} className="v2-spin" /> : <Send size={15} />} Save leave
          </button>

          <h4 className="v2-leave-sub">My leave</h4>
          {myLeaves.length === 0 && <p className="org-muted">No leave recorded.</p>}
          <div className="v2-leave-list">
            {myLeaves.map((l) => (
              <div key={l.id} className="v2-leave-item">
                <div>
                  <strong>{range(l)}</strong>
                  <small>
                    {l.reason_type}
                    {l.note ? ` — ${l.note}` : ""} · {l.days} day{l.days === 1 ? "" : "s"}
                  </small>
                  {l.decided_by && (
                    <small>
                      {l.status === "approved" ? "Approved" : "Not approved"} by {l.decided_by}
                      {l.decision_note ? ` — "${l.decision_note}"` : ""}
                    </small>
                  )}
                </div>
                <span className={`v2-status ${STATUS_TONE[l.status]}`}>{l.status === "rejected" ? "not approved" : l.status}</span>
                {l.can_cancel && (
                  <button className="ghost-btn" title="Cancel this leave"
                    onClick={() => call(`c${l.id}`, () => apiJson(`/api/v2/leaves/${l.id}`, { method: "DELETE" }), "Leave cancelled.")}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Unlock */}
        {lock && !lock.exempt && (
          <div className="card">
            <h3 className="v2-leave-title">
              <Lock size={17} /> Unlock an older visit date
            </h3>
            <p className="org-muted">
              For a date before {lock.earliest_allowed}. A City Coordinator or Super Admin approves it; the date then stays open for{" "}
              {lock.unlock_hours} hours.
            </p>
            <div className="v2-leave-form">
              <label className="v2-field">
                <span>Date</span>
                <input className="filter-select" type="date" max={lock.earliest_allowed} value={uf.date}
                  onChange={(e) => setUf((x) => ({ ...x, date: e.target.value }))} />
              </label>
              <label className="v2-field v2-leave-note">
                <span>Reason</span>
                <input className="filter-select" placeholder="e.g. no signal at the site" value={uf.reason}
                  onChange={(e) => setUf((x) => ({ ...x, reason: e.target.value }))} />
              </label>
            </div>
            <button className="action-btn primary-btn" disabled={busy === "unlock" || !uf.date || uf.reason.trim().length < 5} onClick={askUnlock}>
              {busy === "unlock" ? <Loader2 size={15} className="v2-spin" /> : <Send size={15} />} Request unlock
            </button>
            <h4 className="v2-leave-sub">My requests</h4>
            {lock.my_requests.length === 0 && <p className="org-muted">No requests yet.</p>}
            <div className="v2-leave-list">
              {lock.my_requests.map((r) => (
                <div key={r.id} className="v2-leave-item">
                  <div>
                    <strong>{r.unlock_date}</strong>
                    <small>{r.reason}</small>
                  </div>
                  <span className={`v2-status ${STATUS_TONE[r.status]}`}>
                    {r.status === "approved" ? (r.active ? "open now" : "expired") : r.status === "rejected" ? "not approved" : "pending"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Approvals */}
      {canSeeUnlocks && (
        <div className="card">
          <div className="section-head v2-wrap">
            <div>
              <h2>Unlock requests</h2>
              <p className="section-subtext">
                {role === "admin" || role === "city_coordinator"
                  ? "Approving opens that date for that person for 24 hours."
                  : "Only a City Coordinator or Super Admin can unlock dates."}
              </p>
            </div>
            <div className="v2-seg">
              {(["pending", "all"] as const).map((f) => (
                <button key={f} className={unlockFilter === f ? "active" : ""} onClick={() => setUnlockFilter(f)}>
                  {f === "pending" ? "Waiting" : "All"}
                </button>
              ))}
            </div>
          </div>
          {unlocks.length === 0 && <p className="org-muted">Nothing here.</p>}
          <div className="v2-leave-list">
            {unlocks.map((r) => (
              <div key={r.id} className="v2-leave-item wide">
                <div>
                  <strong>
                    {r.username} · {r.unlock_date}
                  </strong>
                  <small>
                    {r.team} · asked {when(r.requested_at)}
                  </small>
                  <small>“{r.reason}”</small>
                  {r.decided_by && (
                    <small>
                      {r.status === "approved" ? "Unlocked" : "Not approved"} by {r.decided_by}
                      {r.decision_note ? ` — "${r.decision_note}"` : ""}
                    </small>
                  )}
                </div>
                <span className={`v2-status ${STATUS_TONE[r.status]}`}>{r.status === "rejected" ? "not approved" : r.status}</span>
                {r.status === "pending" && r.can_decide && (
                  <Decide
                    onDecide={(approve, note) =>
                      call(`u${r.id}`, () => apiJson(`/api/v2/visit-unlock/requests/${r.id}/decide`, { method: "POST", body: JSON.stringify({ approve, note }) }),
                        approve ? `${r.unlock_date} unlocked for ${r.username} for 24 hours.` : "Request rejected.")
                    }
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {seesOthers && (
        <div className="card">
          <div className="section-head v2-wrap">
            <div>
              <h2>Team leave</h2>
              <p className="section-subtext">
                Leave always shows on calendars and reports; approval is recorded separately.
                {isApproverLeave ? "" : " (View only.)"}
              </p>
            </div>
            <div className="v2-seg">
              {(["pending", "all"] as const).map((f) => (
                <button key={f} className={leaveFilter === f ? "active" : ""} onClick={() => setLeaveFilter(f)}>
                  {f === "pending" ? "Waiting" : "All"}
                </button>
              ))}
            </div>
          </div>
          {othersLeaves.length === 0 && <p className="org-muted">Nothing here.</p>}
          <div className="v2-leave-list">
            {othersLeaves.map((l) => (
              <div key={l.id} className="v2-leave-item wide">
                <div>
                  <strong>
                    {l.username} · {range(l)}
                  </strong>
                  <small>
                    {l.team} · {l.reason_type}
                    {l.note ? ` — ${l.note}` : ""} · {l.days} day{l.days === 1 ? "" : "s"}
                  </small>
                  {l.decided_by && (
                    <small>
                      {l.status === "approved" ? "Approved" : "Not approved"} by {l.decided_by}
                      {l.decision_note ? ` — "${l.decision_note}"` : ""}
                    </small>
                  )}
                </div>
                <span className={`v2-status ${STATUS_TONE[l.status]}`}>{l.status === "rejected" ? "not approved" : l.status}</span>
                {l.can_decide && (
                  <Decide
                    onDecide={(approve, note) =>
                      call(`l${l.id}`, () => apiJson(`/api/v2/leaves/${l.id}/decide`, { method: "POST", body: JSON.stringify({ approve, note }) }),
                        approve ? "Leave approved." : "Leave marked as not approved.")
                    }
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
