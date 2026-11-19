import { useEffect, useMemo, useState } from "react";
import { Loader2, Lock, LockOpen, Save, SlidersHorizontal, Unlock, X } from "lucide-react";
import { apiJson } from "./authFetch";

type Person = { username: string; team: string; role: string; lock_off: { note: string; by: string; at: string } | null };
type Grant = { id: number; username: string; team: string; date: string; reason: string; by: string; expires_at: string };
type Controls = {
  window_days: number;
  default_window_days: number;
  can_change_window: boolean;
  allowed_dates: string[];
  people: Person[];
  teams: string[];
  open_dates: Grant[];
};
type Target = "user" | "team" | "all";

const pad = (n: number) => String(n).padStart(2, "0");
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

function TargetPicker({
  target,
  setTarget,
  user,
  setUser,
  team,
  setTeam,
  data,
}: {
  target: Target;
  setTarget: (t: Target) => void;
  user: string;
  setUser: (v: string) => void;
  team: string;
  setTeam: (v: string) => void;
  data: Controls;
}) {
  return (
    <div className="v2-lc-target">
      <div className="v2-seg">
        {(
          [
            ["user", "One person"],
            ["team", "A team"],
            ["all", "Everyone"],
          ] as [Target, string][]
        ).map(([k, l]) => (
          <button key={k} className={target === k ? "active" : ""} onClick={() => setTarget(k)}>
            {l}
          </button>
        ))}
      </div>
      {target === "user" && (
        <select className="filter-select" value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">Choose person…</option>
          {data.people.map((p) => (
            <option key={p.username} value={p.username}>
              {p.username} — {p.team}
            </option>
          ))}
        </select>
      )}
      {target === "team" && (
        <select className="filter-select" value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="">Choose team…</option>
          {data.teams.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Super Admin / City Coordinator: open dates directly, turn the lock off/on, change the window. */
export default function LockControls() {
  const [data, setData] = useState<Controls | null>(null);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const [oTarget, setOTarget] = useState<Target>("user");
  const [oUser, setOUser] = useState("");
  const [oTeam, setOTeam] = useState("");
  const [oFrom, setOFrom] = useState(todayIso());
  const [oTo, setOTo] = useState(todayIso());
  const [oHours, setOHours] = useState(24);
  const [oReason, setOReason] = useState("");

  const [xTarget, setXTarget] = useState<Target>("user");
  const [xUser, setXUser] = useState("");
  const [xTeam, setXTeam] = useState("");
  const [xNote, setXNote] = useState("");

  const [win, setWin] = useState<number | "">("");

  useEffect(() => {
    apiJson<Controls>("/api/v2/visit-lock/controls")
      .then((r) => {
        setData(r);
        setWin(r.window_days);
      })
      .catch((e) => setError(e.message));
  }, [tick]);

  const run = async (key: string, path: string, body: unknown, ok: (r: any) => string, method = "POST") => {
    setBusy(key);
    setError("");
    setMsg("");
    try {
      const r = await apiJson(path, { method, body: JSON.stringify(body) });
      setMsg(ok(r));
      setTick((n) => n + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const lockOff = useMemo(() => (data?.people || []).filter((p) => p.lock_off), [data]);
  if (!data) return error ? <div className="status error">{error}</div> : null;

  const who = (t: Target, u: string, tm: string) => (t === "user" ? u : t === "team" ? `team ${tm}` : "everyone in your scope");
  const ready = (t: Target, u: string, tm: string) => (t === "user" ? !!u : t === "team" ? !!tm : true);

  return (
    <div className="card v2-lc">
      <div className="section-head v2-wrap">
        <div>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <SlidersHorizontal size={20} /> Visit lock controls
          </h2>
          <p className="section-subtext">
            Open dates directly, or turn the lock off for someone. Right now visits are open for today and the previous{" "}
            <b>{data.window_days}</b> working days ({data.allowed_dates.slice().reverse().join(", ")}).
          </p>
        </div>
      </div>
      {msg && <div className="status success">{msg}</div>}
      {error && <div className="status error">{error}</div>}

      <div className="v2-leave-grid">
        {/* Open dates */}
        <div className="v2-lc-box">
          <h3 className="v2-leave-title">
            <Unlock size={17} /> Open dates
          </h3>
          <TargetPicker target={oTarget} setTarget={setOTarget} user={oUser} setUser={setOUser} team={oTeam} setTeam={setOTeam} data={data} />
          <div className="v2-leave-form">
            <label className="v2-field">
              <span>From</span>
              <input className="filter-select" type="date" value={oFrom} max={todayIso()}
                onChange={(e) => {
                  setOFrom(e.target.value);
                  if (oTo < e.target.value) setOTo(e.target.value);
                }} />
            </label>
            <label className="v2-field">
              <span>To</span>
              <input className="filter-select" type="date" value={oTo} min={oFrom} max={todayIso()} onChange={(e) => setOTo(e.target.value)} />
            </label>
            <label className="v2-field">
              <span>Open for</span>
              <select className="filter-select" value={oHours} onChange={(e) => setOHours(Number(e.target.value))}>
                {[6, 12, 24, 48, 72].map((h) => (
                  <option key={h} value={h}>
                    {h} hours
                  </option>
                ))}
              </select>
            </label>
            <label className="v2-field v2-leave-note">
              <span>Reason (optional)</span>
              <input className="filter-select" placeholder="e.g. server was down on these days" value={oReason} onChange={(e) => setOReason(e.target.value)} />
            </label>
          </div>
          <button
            className="action-btn primary-btn"
            disabled={busy === "open" || !ready(oTarget, oUser, oTeam) || !oFrom}
            onClick={() =>
              run(
                "open",
                "/api/v2/visit-lock/open",
                { target: oTarget, username: oUser, team: oTeam, date_from: oFrom, date_to: oTo, hours: oHours, reason: oReason },
                (r) => `Opened ${oFrom === oTo ? oFrom : `${oFrom} to ${oTo}`} for ${who(oTarget, oUser, oTeam)} (${r.people} people) for ${oHours} hours.`
              )
            }
          >
            {busy === "open" ? <Loader2 size={15} className="v2-spin" /> : <LockOpen size={15} />} Open dates
          </button>
        </div>

        {/* Lock on/off */}
        <div className="v2-lc-box">
          <h3 className="v2-leave-title">
            <Lock size={17} /> Lock on / off
          </h3>
          <p className="org-muted">With the lock off, a person can enter visits for any past date until you turn it back on.</p>
          <TargetPicker target={xTarget} setTarget={setXTarget} user={xUser} setUser={setXUser} team={xTeam} setTeam={setXTeam} data={data} />
          <input className="filter-select" placeholder="Note (optional), e.g. senior staff" value={xNote} onChange={(e) => setXNote(e.target.value)} />
          <div className="org-form-row">
            <button
              className="action-btn"
              disabled={!!busy || !ready(xTarget, xUser, xTeam)}
              onClick={() =>
                run("off", "/api/v2/visit-lock/exempt", { target: xTarget, username: xUser, team: xTeam, lock_off: true, note: xNote },
                  (r) => `Lock turned OFF for ${who(xTarget, xUser, xTeam)} (${r.people} people).`)
              }
            >
              {busy === "off" ? <Loader2 size={15} className="v2-spin" /> : <LockOpen size={15} />} Turn lock off
            </button>
            <button
              className="action-btn primary-btn"
              disabled={!!busy || !ready(xTarget, xUser, xTeam)}
              onClick={() =>
                run("on", "/api/v2/visit-lock/exempt", { target: xTarget, username: xUser, team: xTeam, lock_off: false },
                  (r) => `Lock turned ON for ${who(xTarget, xUser, xTeam)} (${r.people} people).`)
              }
            >
              {busy === "on" ? <Loader2 size={15} className="v2-spin" /> : <Lock size={15} />} Turn lock on
            </button>
          </div>
          <h4 className="v2-leave-sub">Lock is off for ({lockOff.length})</h4>
          {lockOff.length === 0 && <p className="org-muted">Nobody — the lock applies to everyone.</p>}
          <div className="v2-leave-list">
            {lockOff.map((p) => (
              <div key={p.username} className="v2-leave-item">
                <div>
                  <strong>{p.username}</strong>
                  <small>
                    {p.team} · by {p.lock_off!.by} on {when(p.lock_off!.at)}
                    {p.lock_off!.note ? ` — ${p.lock_off!.note}` : ""}
                  </small>
                </div>
                <button className="ghost-btn" title="Turn the lock back on"
                  onClick={() => run(`on-${p.username}`, "/api/v2/visit-lock/exempt", { target: "user", username: p.username, lock_off: false },
                    () => `Lock turned ON for ${p.username}.`)}>
                  <Lock size={14} /> Lock
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {data.can_change_window && (
        <div className="v2-lc-box v2-lc-window">
          <h3 className="v2-leave-title">Window (Super Admin)</h3>
          <span className="org-muted">Today plus the previous</span>
          <input className="filter-select" type="number" min={0} max={60} value={win}
            onChange={(e) => setWin(e.target.value === "" ? "" : Number(e.target.value))} style={{ width: 90 }} />
          <span className="org-muted">working days (default {data.default_window_days}; Sundays are not counted)</span>
          <button className="action-btn primary-btn" disabled={busy === "win" || win === "" || win === data.window_days}
            onClick={() => run("win", "/api/v2/visit-lock/settings", { window_days: win }, (r) => `Window changed to ${r.window_days} working days.`, "PUT")}>
            {busy === "win" ? <Loader2 size={15} className="v2-spin" /> : <Save size={15} />} Save
          </button>
        </div>
      )}

      <div className="v2-lc-box">
        <h3 className="v2-leave-title">Dates open right now ({data.open_dates.length})</h3>
        {data.open_dates.length === 0 && <p className="org-muted">No extra dates are open.</p>}
        <div className="v2-leave-list" style={{ maxHeight: 360, overflowY: "auto" }}>
          {data.open_dates.map((g) => (
            <div key={g.id} className="v2-leave-item">
              <div>
                <strong>
                  {g.username} · {g.date}
                </strong>
                <small>
                  {g.team} · by {g.by} · open until {when(g.expires_at)}
                  {g.reason ? ` — ${g.reason}` : ""}
                </small>
              </div>
              <button className="ghost-btn" title="Close now"
                onClick={() => run(`c${g.id}`, `/api/v2/visit-lock/open/${g.id}/close`, {}, () => `${g.date} closed again for ${g.username}.`)}>
                <X size={14} /> Close
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
