import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  Contact,
  Package,
  Search,
  ShoppingBag,
  UserRound,
  X,
} from "lucide-react";
import { apiJson } from "./authFetch";
import type { chartColors } from "./accent";

type Chart = ReturnType<typeof chartColors>;
type Hit = { name: string; last_activity: string | null; total_qty: number; has_sales: boolean };
type C360 = {
  name: string;
  status: "new" | "active" | "at_risk" | "lost" | "prospect";
  first_purchase: string | null;
  last_purchase: string | null;
  sales_lines: number;
  total_qty: number;
  total_amount: number;
  yearly: { year: number; qty: number; amount: number; growth_pct: number | null }[];
  monthly_24: { label: string; qty: number; amount: number }[];
  products: { name: string; qty: number; amount: number; years: Record<string, number> }[];
  salespersons: { sales_person: string; team: string; qty: number }[];
  visits: {
    id: number;
    meeting_date: string;
    meeting_status: string;
    sales_person: string;
    product: string;
    client_response: string;
    notes: string;
    next_meeting_date: string;
  }[];
  visit_count: number;
  last_visit: string | null;
  next_followup: string | null;
};

type Props = {
  initialName?: string;
  chart: Chart;
  tooltipProps: Record<string, unknown>;
  axisProps: Record<string, unknown>;
};

const fmt = (v: number) => new Intl.NumberFormat().format(Math.round(v || 0));
const STATUS: Record<C360["status"], { label: string; tone: string }> = {
  new: { label: "New customer", tone: "good" },
  active: { label: "Active", tone: "good" },
  at_risk: { label: "At risk — is saal order nahi", tone: "warm" },
  lost: { label: "Lost", tone: "bad" },
  prospect: { label: "Prospect (sirf visits)", tone: "neutral" },
};

export default function Customer360({ initialName, chart, tooltipProps, axisProps }: Props) {
  const [q, setQ] = useState(initialName || "");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(initialName || "");
  const [data, setData] = useState<C360 | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (initialName) {
      setQ(initialName);
      setSelected(initialName);
    }
  }, [initialName]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2 || q === selected) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(() => {
      apiJson<{ customers: Hit[] }>(`/api/v2/customers/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => {
          setHits(r.customers);
          setOpen(true);
        })
        .catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [q, selected]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    apiJson<C360>(`/api/v2/customers/360?name=${encodeURIComponent(selected)}`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => {
        if (!cancelled) {
          setData(null);
          setError(e.message);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const pick = (name: string) => {
    setSelected(name);
    setQ(name);
    setOpen(false);
  };

  const last = data?.yearly[data.yearly.length - 1];

  return (
    <div className="v2-stack">
      <div className="card" style={{ position: "relative", zIndex: 5 }}>
        <div className="section-head v2-wrap">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Contact size={20} /> Customer 360
            </h2>
            <p className="section-subtext">Customer ka naam likhein — sales, products, salesperson aur visits ek jagah</p>
          </div>
        </div>
        <div className="v2-search">
          <Search size={18} />
          <input
            value={q}
            placeholder="Customer search karein (kam az kam 2 letters)…"
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => hits.length && setOpen(true)}
          />
          {q && (
            <button
              className="v2-eye"
              aria-label="Clear"
              onClick={() => {
                setQ("");
                setSelected("");
                setData(null);
                setError("");
              }}
            >
              <X size={16} />
            </button>
          )}
          {open && hits.length > 0 && (
            <div className="v2-search-results">
              {hits.map((h) => (
                <button key={h.name} onClick={() => pick(h.name)}>
                  <strong>{h.name}</strong>
                  <small>
                    {h.has_sales ? `${fmt(h.total_qty)} qty` : "visits only"}
                    {h.last_activity ? ` · last ${String(h.last_activity).slice(0, 10)}` : ""}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div className="status error">{error}</div>}
      {loading && (
        <div className="card v2-skeleton">
          <div /> <div /> <div />
        </div>
      )}
      {!selected && !loading && (
        <div className="card v2-empty">
          <Contact size={40} />
          <p>Upar search box mein customer ka naam likhein.</p>
        </div>
      )}

      {data && !loading && (
        <>
          <div className="card v2-c360-head">
            <div className="v2-avatar v2-avatar-lg">{data.name.slice(0, 2).toUpperCase()}</div>
            <div style={{ minWidth: 0 }}>
              <h1 className="v2-c360-name">{data.name}</h1>
              <span className={`v2-status tone-${STATUS[data.status].tone}`}>{STATUS[data.status].label}</span>
            </div>
            <dl className="v2-c360-facts">
              <div>
                <dt>First purchase</dt>
                <dd>{data.first_purchase?.slice(0, 10) || "—"}</dd>
              </div>
              <div>
                <dt>Last purchase</dt>
                <dd>{data.last_purchase?.slice(0, 10) || "—"}</dd>
              </div>
              <div>
                <dt>Last visit</dt>
                <dd>{data.last_visit || "—"}</dd>
              </div>
              <div>
                <dt>Next follow-up</dt>
                <dd>{data.next_followup || "—"}</dd>
              </div>
            </dl>
          </div>

          <div className="v2-kpi-row">
            <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-1">
                  <ShoppingBag />
                </span>
              </div>
              <p className="metric-title">Total quantity (all years)</p>
              <h3 className="metric-value">{fmt(data.total_qty)}</h3>
            </div>
            <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-2">
                  <ShoppingBag />
                </span>
              </div>
              <p className="metric-title">Total amount</p>
              <h3 className="metric-value">Rs {fmt(data.total_amount)}</h3>
            </div>
            <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-3">
                  <CalendarClock />
                </span>
                {last?.growth_pct != null && (
                  <span className={`v2-growth ${last.growth_pct >= 0 ? "up" : "down"}`}>
                    {last.growth_pct >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                    {Math.abs(last.growth_pct).toFixed(1)}%
                  </span>
                )}
              </div>
              <p className="metric-title">{last ? `${last.year} quantity` : "This year"}</p>
              <h3 className="metric-value">{fmt(last?.qty || 0)}</h3>
            </div>
            <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-4">
                  <UserRound />
                </span>
              </div>
              <p className="metric-title">Visits recorded</p>
              <h3 className="metric-value">{data.visit_count}</h3>
            </div>
          </div>

          <div className="card">
            <div className="section-head">
              <div>
                <h2>Last 24 months</h2>
                <p className="section-subtext">Mahana quantity</p>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={data.monthly_24}>
                  <defs>
                    <linearGradient id="c360g" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chart.accent} stopOpacity={0.45} />
                      <stop offset="100%" stopColor={chart.accent} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 6" stroke={chart.grid} vertical={false} />
                  <XAxis dataKey="label" {...axisProps} interval={2} />
                  <YAxis {...axisProps} width={48} />
                  <Tooltip {...tooltipProps} />
                  <Area type="monotone" dataKey="qty" name="Qty" stroke={chart.accent} strokeWidth={3} fill="url(#c360g)" animationDuration={900} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="analytics-grid v2-two">
            <div className="card">
              <div className="section-head">
                <div>
                  <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Package size={18} /> Products
                  </h2>
                  <p className="section-subtext">Kya kya khareedta hai</p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table v2-compact-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      {data.yearly.map((y) => (
                        <th key={y.year} style={{ textAlign: "right" }}>
                          {y.year}
                        </th>
                      ))}
                      <th style={{ textAlign: "right" }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.products.map((p) => (
                      <tr key={p.name} style={{ cursor: "default" }}>
                        <td>{p.name}</td>
                        {data.yearly.map((y) => (
                          <td key={y.year} style={{ textAlign: "right" }}>
                            {fmt(p.years[String(y.year)] || 0)}
                          </td>
                        ))}
                        <td style={{ textAlign: "right", fontWeight: 700 }}>{fmt(p.qty)}</td>
                      </tr>
                    ))}
                    {data.products.length === 0 && (
                      <tr>
                        <td colSpan={data.yearly.length + 2} className="org-muted">
                          Abhi koi sale nahi
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="section-head">
                <div>
                  <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <UserRound size={18} /> Salespersons
                  </h2>
                  <p className="section-subtext">Kaun deal karta hai</p>
                </div>
              </div>
              <div className="v2-follow-list">
                {data.salespersons.map((p) => (
                  <div className="v2-follow-item" key={`${p.sales_person}-${p.team}`}>
                    <div>
                      <strong>{p.sales_person}</strong>
                      <small>{p.team}</small>
                    </div>
                    <span className="v2-follow-when">{fmt(p.qty)} qty</span>
                  </div>
                ))}
                {data.salespersons.length === 0 && <p className="org-muted">—</p>}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="section-head">
              <div>
                <h2>Visit timeline</h2>
                <p className="section-subtext">Aakhri {data.visits.length} visits</p>
              </div>
            </div>
            <ol className="v2-timeline">
              {data.visits.map((v) => (
                <li key={v.id}>
                  <span className="v2-timeline-dot" />
                  <div>
                    <strong>{v.meeting_date}</strong> · {v.sales_person} · {v.product || "—"}{" "}
                    <span className="v2-status">{v.meeting_status || "—"}</span>
                    {(v.client_response || v.notes) && <p>{v.client_response || v.notes}</p>}
                    {v.next_meeting_date && <small>Next follow-up: {v.next_meeting_date}</small>}
                  </div>
                </li>
              ))}
              {data.visits.length === 0 && <p className="org-muted">Is customer ki koi visit record nahi.</p>}
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
