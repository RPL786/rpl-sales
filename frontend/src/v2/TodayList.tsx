import { useEffect, useState } from "react";
import { AlarmClock, CalendarCheck, CheckCircle2, Contact, ListChecks, Moon, Play, RefreshCw } from "lucide-react";
import { apiJson } from "./authFetch";

export type TodayItem = {
  kind: "overdue" | "followup" | "planned" | "quiet";
  client_name: string;
  sales_person: string;
  team: string;
  product: string;
  reason: string;
  detail: string;
  done: boolean;
  last_order?: string;
};
type Today = {
  today: string;
  sales_person: string;
  people: string[];
  summary: { total: number; open: number; done: number; overdue: number; followups: number; quiet: number };
  items: TodayItem[];
};

const ICON = {
  overdue: <AlarmClock size={16} />,
  followup: <CalendarCheck size={16} />,
  planned: <CalendarCheck size={16} />,
  quiet: <Moon size={16} />,
};

/** "Who should I visit today?" — follow-ups first, then regular customers who went quiet. */
export default function TodayList({
  canPickPerson,
  onStartVisit,
  onOpenCustomer,
}: {
  canPickPerson: boolean;
  onStartVisit: (item: TodayItem) => void;
  onOpenCustomer: (name: string) => void;
}) {
  const [person, setPerson] = useState("");
  const [data, setData] = useState<Today | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError("");
    apiJson<Today>(`/api/v2/today${person ? `?sales_person=${encodeURIComponent(person)}` : ""}`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [person, tick]);

  const items = data?.items || [];
  const visible = showAll ? items : items.slice(0, 8);
  const s = data?.summary;

  return (
    <div className="card v2-today">
      <div className="section-head v2-wrap">
        <div>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ListChecks size={20} /> Today's list
          </h2>
          <p className="section-subtext">
            {s
              ? s.total === 0
                ? "Nothing pending — a good day to find new customers."
                : `${s.open} to visit${s.done ? ` · ${s.done} done` : ""} — follow-ups first, then customers who stopped ordering`
              : "Loading…"}
          </p>
        </div>
        <div className="org-form-row">
          {canPickPerson && data && (
            <select className="filter-select" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Salesperson">
              <option value="">Everyone</option>
              {data.people.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
          <button className="ghost-btn" onClick={() => setTick((n) => n + 1)} aria-label="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {error && <div className="status error">{error}</div>}
      {s && s.total > 0 && (
        <div className="v2-today-progress" aria-label={`${s.done} of ${s.total} done`}>
          <div style={{ width: `${Math.round((s.done / s.total) * 100)}%` }} />
        </div>
      )}

      <div className="v2-today-list">
        {visible.map((it) => (
          <div key={`${it.kind}-${it.client_name}-${it.sales_person}`} className={`v2-today-item kind-${it.kind} ${it.done ? "done" : ""}`}>
            <span className="v2-today-icon">{it.done ? <CheckCircle2 size={16} /> : ICON[it.kind]}</span>
            <div className="v2-today-main">
              <strong>{it.client_name}</strong>
              <small>
                <span className="v2-today-reason">{it.done ? "Visited today" : it.reason}</span>
                {it.detail ? ` · ${it.detail}` : ""}
                {canPickPerson && !person && it.sales_person ? ` · ${it.sales_person}` : ""}
              </small>
            </div>
            <div className="v2-today-actions">
              <button className="ghost-btn" onClick={() => onOpenCustomer(it.client_name)} title="Customer 360">
                <Contact size={14} />
              </button>
              {!it.done && (
                <button className="action-btn primary-btn" onClick={() => onStartVisit(it)}>
                  <Play size={14} /> Start visit
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {items.length > 8 && (
        <button className="ghost-btn" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show less" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
