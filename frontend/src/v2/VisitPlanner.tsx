import { useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  CalendarCheck,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardPlus,
  PackageCheck,
  RefreshCw,
  UserRound,
  X,
} from "lucide-react";
import { apiJson } from "./authFetch";

type Visit = {
  id: number;
  meeting_date: string;
  meeting_time: string;
  meeting_type: string;
  meeting_status: string;
  sales_person: string;
  team: string;
  client_name: string;
  product: string;
  client_response: string;
  notes: string;
  next_meeting_date: string;
  next_meeting_time: string;
  order_amount: number;
  quantity: number;
  days_overdue?: number;
};
type Day = { date: string; visits: Visit[]; count: number; closed: number };
type Resp = {
  start: string;
  end: string;
  today: string;
  days: Day[];
  summary: {
    visits_in_range: number;
    visits_today: number;
    orders_in_range: number;
    followups_due_today: number;
    followups_upcoming: number;
    followups_overdue: number;
  };
  due_today: Visit[];
  upcoming: Visit[];
  overdue: Visit[];
  sales_people: string[];
};

type Props = {
  canFilterPeople: boolean;
  onLogVisit: () => void;
  onOpenCustomer: (name: string) => void;
};

// Dates are plain YYYY-MM-DD strings; do the math in UTC so the local timezone never shifts the day
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayName = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
const dayNum = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

function statusTone(status: string) {
  const s = (status || "").toLowerCase();
  if (s === "order received") return "good";
  if (s === "rejected" || s === "closed") return "bad";
  if (s === "interested") return "warm";
  return "neutral";
}

export default function VisitPlanner({ canFilterPeople, onLogVisit, onOpenCustomer }: Props) {
  const [start, setStart] = useState<string>("");
  const [person, setPerson] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Visit | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    const p = new URLSearchParams({ days: "7" });
    if (start) p.set("start", start);
    if (person) p.set("sales_person", person);
    apiJson<Resp>(`/api/v2/visits/planner?${p}`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [start, person, reload]);

  const s = data?.summary;
  const kpis = useMemo(
    () => [
      { label: "Visits today", value: s?.visits_today ?? 0, icon: <CalendarCheck />, tone: 1 },
      { label: "Visits this week", value: s?.visits_in_range ?? 0, icon: <CalendarClock />, tone: 4 },
      { label: "Follow-ups due", value: (s?.followups_due_today ?? 0) + (s?.followups_upcoming ?? 0), icon: <AlarmClock />, tone: 3 },
      { label: "Overdue follow-ups", value: s?.followups_overdue ?? 0, icon: <AlarmClock />, tone: 5 },
      { label: "Orders this week", value: s?.orders_in_range ?? 0, icon: <PackageCheck />, tone: 2 },
    ],
    [s]
  );

  const FollowList = ({ title, items, kind }: { title: string; items: Visit[]; kind: "overdue" | "today" | "upcoming" }) => (
    <div className={`card v2-follow v2-follow-${kind}`}>
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          <p className="section-subtext">{items.length} client{items.length === 1 ? "" : "s"}</p>
        </div>
      </div>
      <div className="v2-follow-list">
        {items.length === 0 && <p className="org-muted">Kuch pending nahi 🎉</p>}
        {items.slice(0, 40).map((v) => (
          <button key={`${v.id}-${kind}`} className="v2-follow-item" onClick={() => setDetail(v)}>
            <div>
              <strong>{v.client_name}</strong>
              <small>
                {v.sales_person} · {v.product || "—"}
              </small>
            </div>
            <span className="v2-follow-when">
              {kind === "overdue" ? `${v.days_overdue}d late` : kind === "today" ? "Today" : dayNum(v.next_meeting_date)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="v2-stack">
      <div className="card">
        <div className="section-head v2-wrap">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CalendarClock size={20} /> Visit Planner
            </h2>
            <p className="section-subtext">
              {data ? `${dayNum(data.start)} – ${dayNum(data.end)}` : "This week"} · follow-ups khud track hote hain
            </p>
          </div>
          <div className="v2-controls">
            {canFilterPeople && data && (
              <select className="filter-select" style={{ width: 190 }} value={person} onChange={(e) => setPerson(e.target.value)}>
                <option value="">All salespersons</option>
                {data.sales_people.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
            <div className="v2-seg">
              <button aria-label="Previous week" onClick={() => data && setStart(addDays(data.start, -7))}>
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setStart("")}>This week</button>
              <button aria-label="Next week" onClick={() => data && setStart(addDays(data.start, 7))}>
                <ChevronRight size={16} />
              </button>
            </div>
            <button className="ghost-btn" onClick={() => setReload((n) => n + 1)} disabled={busy}>
              <RefreshCw size={14} />
            </button>
            <button className="action-btn primary-btn" onClick={onLogVisit}>
              <ClipboardPlus size={16} /> Log visit
            </button>
          </div>
        </div>
      </div>

      {error && <div className="status error">{error}</div>}

      <div className="v2-kpi-row">
        {kpis.map((k) => (
          <div className="card metric-card" key={k.label}>
            <div className="v2-kpi-head">
              <span className={`v2-kpi-icon tone-${k.tone}`}>{k.icon}</span>
            </div>
            <p className="metric-title">{k.label}</p>
            <h3 className="metric-value">{k.value}</h3>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h2>Week view</h2>
            <p className="section-subtext">Har din ki visits — card par click karein</p>
          </div>
        </div>
        <div className="v2-week">
          {(data?.days ?? []).map((d) => (
            <div key={d.date} className={`v2-day ${d.date === data?.today ? "today" : ""}`}>
              <div className="v2-day-head">
                <span>{dayName(d.date)}</span>
                <strong>{dayNum(d.date)}</strong>
                <em>{d.count}</em>
              </div>
              <div className="v2-day-body">
                {d.visits.length === 0 && <span className="org-muted">—</span>}
                {d.visits.map((v) => (
                  <button key={v.id} className={`v2-visit-pill tone-${statusTone(v.meeting_status)}`} onClick={() => setDetail(v)}>
                    <b>{v.meeting_time?.slice(0, 5) || ""}</b> {v.client_name}
                    <small>{v.sales_person}</small>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="v2-follow-grid">
        <FollowList title="Overdue follow-ups" items={data?.overdue ?? []} kind="overdue" />
        <FollowList title="Due today" items={data?.due_today ?? []} kind="today" />
        <FollowList title="Upcoming (14 days)" items={data?.upcoming ?? []} kind="upcoming" />
      </div>

      {detail && (
        <div className="v2-drawer-backdrop" onClick={() => setDetail(null)}>
          <aside className="v2-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Visit details">
            <div className="section-head">
              <div>
                <h2>{detail.client_name}</h2>
                <p className="section-subtext">
                  {detail.meeting_date} {detail.meeting_time} · {detail.meeting_type}
                </p>
              </div>
              <button className="ghost-btn" onClick={() => setDetail(null)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <dl className="v2-dl">
              <dt>Status</dt>
              <dd>
                <span className={`v2-status tone-${statusTone(detail.meeting_status)}`}>{detail.meeting_status || "—"}</span>
              </dd>
              <dt>Salesperson</dt>
              <dd>
                <UserRound size={13} /> {detail.sales_person} ({detail.team})
              </dd>
              <dt>Product</dt>
              <dd>{detail.product || "—"}</dd>
              <dt>Client response</dt>
              <dd>{detail.client_response || "—"}</dd>
              <dt>Next follow-up</dt>
              <dd>{detail.next_meeting_date ? `${detail.next_meeting_date} ${detail.next_meeting_time || ""}` : "—"}</dd>
              <dt>Order / Qty</dt>
              <dd>
                {detail.order_amount || 0} / {detail.quantity || 0}
              </dd>
              <dt>Notes</dt>
              <dd>{detail.notes || "—"}</dd>
            </dl>
            <div className="org-form-row">
              <button className="action-btn primary-btn" onClick={() => onOpenCustomer(detail.client_name)}>
                Customer 360
              </button>
              <button className="action-btn" onClick={onLogVisit}>
                <ClipboardPlus size={15} /> Log follow-up visit
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
