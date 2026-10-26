import { useEffect, useState } from "react";
import {
  AlarmClock,
  ArrowDownRight,
  ArrowUpRight,
  CalendarCheck,
  CalendarClock,
  ClipboardPlus,
  Contact,
  Flame,
  Gauge,
  Layers,
  RefreshCw,
  Target,
  TrendingUp,
  Trophy,
  UserRoundX,
} from "lucide-react";
import { apiJson } from "./authFetch";

type Progress = {
  unit: "QTY" | "AMOUNT";
  target: number;
  achieved: number;
  pct: number | null;
  remaining: number;
  required_per_day: number | null;
  current_per_day: number;
  projected: number;
  projected_pct: number | null;
  expected_by_today: number;
  status: "done" | "on_track" | "close" | "behind" | null;
};
type TeamRow = { team: string; unit: string; target: number; achieved: number; pct: number | null };
type Person = { username: string; team: string; unit: string; target: number; achieved: number; pct: number | null };
type Visit = { id: number; client_name: string; sales_person: string; product: string; meeting_time: string; meeting_status: string; next_meeting_date?: string; days_overdue?: number };
type Home = {
  kind: "manager" | "leader" | "member";
  username: string;
  role_label: string;
  home_team: string;
  today: string;
  month: { name: string; year: number; day: number; days: number; elapsed_pct: number; days_left: number };
  progress: Progress[];
  teams: TeamRow[];
  top_people: Person[];
  attention: Person[];
  people_without_target: number;
  sales: {
    month_label: string;
    mtd_qty: number;
    mtd_qty_ly: number;
    mtd_growth: number | null;
    ytd_qty: number;
    ytd_qty_ly: number;
    ytd_growth: number | null;
    mtd_amount: number;
  };
  at_risk: { count: number; top: { name: string; last_year_qty: number }[] };
  followups: { overdue: number; today: number; upcoming: number; overdue_list: Visit[]; today_list: Visit[] };
  visits_today: Visit[];
  visits_this_week: number;
};

type Props = {
  canViewDashboards: boolean;
  onNavigate: (tab: string) => void;
  onOpenCustomer: (name: string) => void;
};

const fmt = (v: number) => new Intl.NumberFormat().format(Math.round(v || 0));
const money = (unit: string, v: number) => (unit === "AMOUNT" ? `Rs ${fmt(v)}` : `${fmt(v)}`);
const unitLabel = (unit: string) => (unit === "AMOUNT" ? "Amount target" : "Quantity target");

const STATUS: Record<string, { label: string; tone: string }> = {
  done: { label: "Target poora 🎉", tone: "good" },
  on_track: { label: "On track", tone: "good" },
  close: { label: "Thoda peeche", tone: "warm" },
  behind: { label: "Peeche — speed barhayein", tone: "bad" },
};

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Subah bakhair";
  if (h < 17) return "Assalam o Alaikum";
  return "Shaam bakhair";
}

function Ring({ pct, expected, size = 150 }: { pct: number; expected: number; size?: number }) {
  const r = (size - 18) / 2;
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(pct, 100));
  const exp = Math.max(0, Math.min(expected, 100));
  const angle = (exp / 100) * 360 - 90;
  const ex = size / 2 + r * Math.cos((angle * Math.PI) / 180);
  const ey = size / 2 + r * Math.sin((angle * Math.PI) / 180);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="v2-ring" role="img" aria-label={`${pct.toFixed(0)} percent`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="v2-ring-track" strokeWidth={12} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="v2-ring-fill"
        strokeWidth={12}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - shown / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <circle cx={ex} cy={ey} r={5} className="v2-ring-marker">
        <title>Aaj tak itna hona chahiye tha</title>
      </circle>
      <text x="50%" y="48%" textAnchor="middle" className="v2-ring-value">
        {pct.toFixed(0)}%
      </text>
      <text x="50%" y="63%" textAnchor="middle" className="v2-ring-sub">
        achieved
      </text>
    </svg>
  );
}

function Growth({ v }: { v: number | null }) {
  if (v === null || v === undefined) return <span className="v2-growth neutral">—</span>;
  return (
    <span className={`v2-growth ${v >= 0 ? "up" : "down"}`}>
      {v >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {Math.abs(v).toFixed(1)}%
    </span>
  );
}

function Bar({ pct, expected }: { pct: number | null; expected: number }) {
  const p = Math.max(0, Math.min(pct ?? 0, 100));
  const tone = pct === null ? "neutral" : pct >= expected ? "good" : pct >= expected * 0.85 ? "warm" : "bad";
  return (
    <div className="v2-bar">
      <div className={`v2-bar-fill tone-${tone}`} style={{ width: `${p}%` }} />
      <div className="v2-bar-expected" style={{ left: `${Math.min(expected, 100)}%` }} title="Aaj tak ka expected" />
    </div>
  );
}

export default function HomePage({ canViewDashboards, onNavigate, onOpenCustomer }: Props) {
  const [data, setData] = useState<Home | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError("");
    apiJson<Home>("/api/v2/home")
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [tick]);

  if (error) return <div className="status error">{error}</div>;
  if (!data)
    return (
      <div className="card v2-skeleton">
        <div /> <div /> <div />
      </div>
    );

  const m = data.month;
  const isMember = data.kind === "member";
  const main = data.progress[0];

  return (
    <div className="v2-stack v2-home">
      {/* Greeting + month clock */}
      <div className="card v2-hello">
        <div>
          <p className="eyebrow">{data.role_label}{data.home_team ? ` · ${data.home_team}` : ""}</p>
          <h2 className="v2-hello-title">
            {greeting()}, {data.username} 👋
          </h2>
          <p className="section-subtext">
            {isMember ? "Yeh raha aap ka aaj ka din." : "Yeh raha aaj ka haal."} {m.name} {m.year} ka din {m.day}/{m.days} —{" "}
            <b>{m.days_left} din baaqi</b>.
          </p>
        </div>
        <div className="v2-hello-actions">
          {isMember || !canViewDashboards ? (
            <>
              <button className="action-btn primary-btn" onClick={() => onNavigate("visit")}>
                <ClipboardPlus size={16} /> Log visit
              </button>
              <button className="action-btn" onClick={() => onNavigate("planner")}>
                <CalendarClock size={16} /> Visit Planner
              </button>
            </>
          ) : (
            <>
              <button className="action-btn primary-btn" onClick={() => onNavigate("overview")}>
                <TrendingUp size={16} /> Sales Overview
              </button>
              <button className="action-btn" onClick={() => onNavigate("multiYear")}>
                <Layers size={16} /> Multi-Year
              </button>
            </>
          )}
          <button className="ghost-btn" onClick={() => setTick((n) => n + 1)} aria-label="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="v2-month-track" title={`Mahina ${m.elapsed_pct}% guzar gaya`}>
          <div style={{ width: `${m.elapsed_pct}%` }} />
        </div>
      </div>

      {/* Target progress */}
      {data.progress.length === 0 ? (
        <div className="card v2-empty-target">
          <Target size={28} />
          <div>
            <strong>Is mahine ka target set nahi</strong>
            <p className="org-muted">
              Admin → Monthly target mein {isMember ? "aap ka" : "team members ka"} {m.name} target daalein, phir yahan progress aur roz ka hisaab nazar aayega.
            </p>
          </div>
        </div>
      ) : (
        <div className="v2-target-grid">
          {data.progress.map((p) => {
            const st = p.status ? STATUS[p.status] : null;
            return (
              <div className="card v2-target-card" key={p.unit}>
                <Ring pct={p.pct ?? 0} expected={m.elapsed_pct} />
                <div className="v2-target-info">
                  <div className="v2-target-head">
                    <h3>
                      <Target size={17} /> {unitLabel(p.unit)} · {m.name}
                    </h3>
                    {st && <span className={`v2-status tone-${st.tone}`}>{st.label}</span>}
                  </div>
                  <div className="v2-target-numbers">
                    <div>
                      <small>Achieved</small>
                      <strong>{money(p.unit, p.achieved)}</strong>
                    </div>
                    <div>
                      <small>Target</small>
                      <strong>{money(p.unit, p.target)}</strong>
                    </div>
                    <div>
                      <small>Baaqi</small>
                      <strong>{money(p.unit, p.remaining)}</strong>
                    </div>
                  </div>
                  <div className="v2-runrate">
                    <div className="v2-runrate-item need">
                      <Flame size={16} />
                      <span>
                        Roz chahiye
                        <b>{p.required_per_day !== null ? money(p.unit, p.required_per_day) : "—"}</b>
                      </span>
                    </div>
                    <div className="v2-runrate-item">
                      <Gauge size={16} />
                      <span>
                        Abhi roz
                        <b>{money(p.unit, p.current_per_day)}</b>
                      </span>
                    </div>
                    <div className="v2-runrate-item">
                      <TrendingUp size={16} />
                      <span>
                        Mahine ke aakhir tak
                        <b>
                          {money(p.unit, p.projected)} {p.projected_pct !== null ? `(${p.projected_pct.toFixed(0)}%)` : ""}
                        </b>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* KPI row */}
      <div className="v2-kpi-row">
        <div className="card metric-card">
          <div className="v2-kpi-head">
            <span className="v2-kpi-icon tone-1">
              <CalendarCheck />
            </span>
            <Growth v={data.sales.mtd_growth} />
          </div>
          <p className="metric-title">Is mahine ({data.sales.month_label})</p>
          <h3 className="metric-value">{fmt(data.sales.mtd_qty)}</h3>
          <p className="metric-sub">Pichhle saal isi waqt: {fmt(data.sales.mtd_qty_ly)}</p>
        </div>
        <div className="card metric-card">
          <div className="v2-kpi-head">
            <span className="v2-kpi-icon tone-4">
              <TrendingUp />
            </span>
            <Growth v={data.sales.ytd_growth} />
          </div>
          <p className="metric-title">Saal ab tak (YTD)</p>
          <h3 className="metric-value">{fmt(data.sales.ytd_qty)}</h3>
          <p className="metric-sub">Pichhla saal: {fmt(data.sales.ytd_qty_ly)}</p>
        </div>
        <button className="card metric-card v2-kpi-link" onClick={() => onNavigate("planner")}>
          <div className="v2-kpi-head">
            <span className="v2-kpi-icon tone-5">
              <AlarmClock />
            </span>
          </div>
          <p className="metric-title">Follow-ups</p>
          <h3 className="metric-value">
            {data.followups.overdue} <small className="v2-unit">overdue</small>
          </h3>
          <p className="metric-sub">
            Aaj {data.followups.today} · agle 14 din {data.followups.upcoming}
          </p>
        </button>
        <div className="card metric-card">
          <div className="v2-kpi-head">
            <span className="v2-kpi-icon tone-3">
              <UserRoundX />
            </span>
          </div>
          <p className="metric-title">Customers at risk</p>
          <h3 className="metric-value">{data.at_risk.count}</h3>
          <p className="metric-sub">Pichhle saal khareeda, is saal abhi tak nahi</p>
        </div>
      </div>

      {/* Manager / leader: teams + people */}
      {!isMember && data.teams.length > 0 && (
        <div className="card">
          <div className="section-head">
            <div>
              <h2>Team targets — {m.name}</h2>
              <p className="section-subtext">Kaali lakeer = aaj tak kitna hona chahiye tha ({m.elapsed_pct}%)</p>
            </div>
          </div>
          <div className="v2-team-bars">
            {data.teams.map((t) => (
              <div className="v2-team-bar" key={t.team}>
                <div className="v2-team-bar-head">
                  <strong>{t.team}</strong>
                  <span>
                    {money(t.unit, t.achieved)} / {t.target ? money(t.unit, t.target) : "no target"}
                    <b>{t.pct !== null ? ` · ${t.pct.toFixed(0)}%` : ""}</b>
                  </span>
                </div>
                <Bar pct={t.pct} expected={m.elapsed_pct} />
              </div>
            ))}
          </div>
        </div>
      )}

      {!isMember && (data.top_people.length > 0 || data.attention.length > 0) && (
        <div className="v2-two analytics-grid">
          <div className="card">
            <div className="section-head">
              <div>
                <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Trophy size={18} /> Leaderboard
                </h2>
                <p className="section-subtext">Is mahine target % ke hisaab se</p>
              </div>
            </div>
            <div className="v2-people">
              {data.top_people.map((p, i) => (
                <div className="v2-person" key={`${p.username}-${p.team}`}>
                  <span className="v2-rank">{i + 1}</span>
                  <div>
                    <strong>{p.username}</strong>
                    <small>{p.team}</small>
                  </div>
                  <Bar pct={p.pct} expected={m.elapsed_pct} />
                  <b>{p.pct !== null ? `${p.pct.toFixed(0)}%` : "—"}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="section-head">
              <div>
                <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <AlarmClock size={18} /> Madad chahiye
                </h2>
                <p className="section-subtext">Aaj ki expected raftaar ({m.elapsed_pct}%) se peeche</p>
              </div>
            </div>
            <div className="v2-people">
              {data.attention.length === 0 && <p className="org-muted">Sab raftaar par hain 👍</p>}
              {data.attention.map((p) => (
                <div className="v2-person" key={`${p.username}-${p.team}`}>
                  <span className="v2-rank warn">!</span>
                  <div>
                    <strong>{p.username}</strong>
                    <small>
                      {p.team} · baaqi {money(p.unit, Math.max(p.target - p.achieved, 0))}
                    </small>
                  </div>
                  <Bar pct={p.pct} expected={m.elapsed_pct} />
                  <b>{p.pct !== null ? `${p.pct.toFixed(0)}%` : "—"}</b>
                </div>
              ))}
            </div>
            {data.people_without_target > 0 && (
              <p className="org-muted" style={{ marginTop: 10 }}>
                {data.people_without_target} log aise hain jin ka is mahine target set nahi.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Today + follow-ups + at-risk customers */}
      <div className="v2-follow-grid">
        <div className="card v2-follow v2-follow-today">
          <div className="section-head">
            <div>
              <h2>Aaj ki visits</h2>
              <p className="section-subtext">{data.visits_today.length} visit · is hafte {data.visits_this_week}</p>
            </div>
          </div>
          <div className="v2-follow-list">
            {data.visits_today.length === 0 && (
              <button className="v2-follow-item" onClick={() => onNavigate("visit")}>
                <div>
                  <strong>Abhi koi visit nahi</strong>
                  <small>Visit log karne ke liye click karein</small>
                </div>
                <span className="v2-follow-when">+ Log</span>
              </button>
            )}
            {data.visits_today.map((v) => (
              <button key={v.id} className="v2-follow-item" onClick={() => onOpenCustomer(v.client_name)}>
                <div>
                  <strong>{v.client_name}</strong>
                  <small>
                    {v.sales_person} · {v.meeting_status || "—"}
                  </small>
                </div>
                <span className="v2-follow-when">{v.meeting_time?.slice(0, 5)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="card v2-follow v2-follow-overdue">
          <div className="section-head">
            <div>
              <h2>Follow-ups</h2>
              <p className="section-subtext">
                {data.followups.overdue} overdue · {data.followups.today} aaj
              </p>
            </div>
          </div>
          <div className="v2-follow-list">
            {[...data.followups.overdue_list, ...data.followups.today_list].length === 0 && (
              <p className="org-muted">Koi pending follow-up nahi 🎉</p>
            )}
            {data.followups.overdue_list.map((v) => (
              <button key={`o-${v.id}`} className="v2-follow-item" onClick={() => onOpenCustomer(v.client_name)}>
                <div>
                  <strong>{v.client_name}</strong>
                  <small>{v.sales_person}</small>
                </div>
                <span className="v2-follow-when late">{v.days_overdue}d late</span>
              </button>
            ))}
            {data.followups.today_list.map((v) => (
              <button key={`t-${v.id}`} className="v2-follow-item" onClick={() => onOpenCustomer(v.client_name)}>
                <div>
                  <strong>{v.client_name}</strong>
                  <small>{v.sales_person}</small>
                </div>
                <span className="v2-follow-when">Aaj</span>
              </button>
            ))}
          </div>
        </div>

        <div className="card v2-follow v2-follow-upcoming">
          <div className="section-head">
            <div>
              <h2>Customers at risk</h2>
              <p className="section-subtext">Pichhle saal ke sab se bade jo is saal nahi aaye</p>
            </div>
          </div>
          <div className="v2-follow-list">
            {data.at_risk.top.length === 0 && <p className="org-muted">Koi nahi 👍</p>}
            {data.at_risk.top.map((c) => (
              <button key={c.name} className="v2-follow-item" onClick={() => onOpenCustomer(c.name)}>
                <div>
                  <strong>{c.name}</strong>
                  <small>Pichhla saal: {fmt(c.last_year_qty)} qty</small>
                </div>
                <span className="v2-follow-when">
                  <Contact size={12} /> 360
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {main && main.status === "behind" && !isMember && (
        <p className="org-muted" style={{ textAlign: "center" }}>
          Tip: "Madad chahiye" wale logon ke saath aaj hi follow-up plan banayein.
        </p>
      )}
    </div>
  );
}
