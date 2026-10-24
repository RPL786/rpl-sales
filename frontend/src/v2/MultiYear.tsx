import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDownRight, ArrowUpRight, CalendarRange, Info, Layers, Minus, Users } from "lucide-react";
import { apiJson } from "./authFetch";
import type { chartColors } from "./accent";

type Chart = ReturnType<typeof chartColors>;
type Total = {
  year: number;
  value: number;
  full: number;
  ytd: number;
  growth_pct: number | null;
  clients_active: number;
  clients_new: number | null;
  clients_lost: number | null;
};
type Row = { name: string; values: Record<string, number>; growth_pct: number | null };
type Resp = {
  years_available: number[];
  years: number[];
  metric: "qty" | "amount";
  mode: "ytd" | "full";
  cutoff: { year: number; month: string; day: number | null; label: string } | null;
  latest_year_partial: boolean;
  monthly: Record<string, number | string>[];
  totals: Total[];
  salespersons: Row[];
  products: Row[];
};

type Props = {
  teams: string[];
  teamLabel: string;
  salesPerson: string;
  chart: Chart;
  tooltipProps: Record<string, unknown>;
  axisProps: Record<string, unknown>;
};

const fmt = (v: number) => new Intl.NumberFormat().format(Math.round(v || 0));

function Growth({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="v2-growth neutral">—</span>;
  const cls = value > 0 ? "up" : value < 0 ? "down" : "neutral";
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span className={`v2-growth ${cls}`}>
      <Icon size={13} />
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

export default function MultiYear({ teams, teamLabel, salesPerson, chart, tooltipProps, axisProps }: Props) {
  const [mode, setMode] = useState<"ytd" | "full">("ytd");
  const [metric, setMetric] = useState<"qty" | "amount">("qty");
  const [years, setYears] = useState<number[]>([]);
  const [chartType, setChartType] = useState<"bar" | "line">("bar");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const teamsKey = teams.join(",");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ mode, metric });
    if (teamsKey) params.set("teams", teamsKey);
    if (salesPerson && salesPerson !== "all") params.set("salesperson", salesPerson);
    if (years.length) params.set("years", years.join(","));
    apiJson<Resp>(`/api/v2/analytics/multi-year?${params}`)
      .then((r) => {
        if (cancelled) return;
        setData(r);
        if (!years.length && r.years.length) setYears(r.years);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, metric, teamsKey, salesPerson, years.join(",")]);

  const yearColors = useMemo(() => {
    const ys = data?.years ?? [];
    // newest year = accent, previous = grey, older = amber / sky / violet
    const older = [chart.muted, "#f5b041", "#38bdf8", "#a78bfa"];
    const map: Record<string, string> = {};
    ys.forEach((y, i) => {
      map[String(y)] = i === ys.length - 1 ? chart.accent : older[(ys.length - 2 - i) % older.length];
    });
    return map;
  }, [data?.years, chart]);

  const toggleYear = (y: number) => {
    setYears((prev) => {
      const next = prev.includes(y) ? prev.filter((x) => x !== y) : [...prev, y].sort();
      return next.length ? next : prev;
    });
  };

  const unit = metric === "qty" ? "Qty" : "Rs";
  const ys = data?.years ?? [];

  return (
    <div className="v2-stack">
      <div className="card">
        <div className="section-head v2-wrap">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Layers size={20} /> Multi-Year Comparison
            </h2>
            <p className="section-subtext">
              {teamLabel}
              {salesPerson && salesPerson !== "all" ? ` · ${salesPerson}` : ""} — jitne saal ka data hai, sab khud aate hain
            </p>
          </div>
          <div className="v2-controls">
            <div className="v2-seg" role="tablist" aria-label="Period">
              <button className={mode === "ytd" ? "active" : ""} onClick={() => setMode("ytd")}>
                Same period (YTD)
              </button>
              <button className={mode === "full" ? "active" : ""} onClick={() => setMode("full")}>
                Full year
              </button>
            </div>
            <div className="v2-seg" role="tablist" aria-label="Metric">
              <button className={metric === "qty" ? "active" : ""} onClick={() => setMetric("qty")}>
                Quantity
              </button>
              <button className={metric === "amount" ? "active" : ""} onClick={() => setMetric("amount")}>
                Amount
              </button>
            </div>
          </div>
        </div>

        {data && data.years_available.length > 0 && (
          <div className="v2-year-chips">
            <span className="org-muted">
              <CalendarRange size={14} /> Years:
            </span>
            {data.years_available.map((y) => (
              <button
                key={y}
                className={`v2-chip ${years.includes(y) ? "active" : ""}`}
                style={years.includes(y) ? { borderColor: yearColors[String(y)] } : undefined}
                onClick={() => toggleYear(y)}
              >
                <i style={{ background: yearColors[String(y)] || "transparent" }} />
                {y}
              </button>
            ))}
          </div>
        )}

        {data?.cutoff && (
          <div className="info-banner" style={{ marginTop: 12 }}>
            <Info size={15} />
            {mode === "ytd"
              ? `Fair comparison: har saal sirf ${data.cutoff.label} ka data compare ho raha hai (${data.cutoff.year} ka data yahan tak hai).`
              : data.latest_year_partial
              ? `Note: ${data.cutoff.year} abhi poora nahi hua (data ${data.cutoff.label} tak). Barabar muqabla ke liye "Same period (YTD)" chunein.`
              : "Poore saal ka muqabla."}
          </div>
        )}
      </div>

      {error && <div className="status error">{error}</div>}
      {loading && !data && (
        <div className="card v2-skeleton">
          <div /> <div /> <div />
        </div>
      )}
      {data && data.years_available.length === 0 && (
        <div className="card">
          <p className="org-muted">Is selection ke liye koi sales data nahi mila.</p>
        </div>
      )}

      {data && data.totals.length > 0 && (
        <>
          <div className="v2-year-grid">
            {data.totals.map((t) => (
              <div className="card metric-card" key={t.year}>
                <div className="v2-kpi-head">
                  <span className="v2-year-badge" style={{ background: yearColors[String(t.year)] }}>
                    {t.year}
                  </span>
                  <Growth value={t.growth_pct} />
                </div>
                <p className="metric-title">
                  {mode === "ytd" ? `${t.year} · ${data.cutoff?.label}` : `${t.year} · Full year`}
                </p>
                <h3 className="metric-value">
                  {metric === "amount" ? "Rs " : ""}
                  {fmt(t.value)}
                  {metric === "qty" ? <small className="v2-unit"> qty</small> : null}
                </h3>
                <p className="metric-sub">
                  <Users size={12} /> {t.clients_active} clients
                  {t.clients_new !== null && (
                    <>
                      {" "}
                      · <span className="positive">+{t.clients_new} new</span> ·{" "}
                      <span className="negative">−{t.clients_lost} lost</span>
                    </>
                  )}
                </p>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="section-head">
              <div>
                <h2>Month-wise {unit}</h2>
                <p className="section-subtext">Har mahine ka saal-ba-saal muqabla</p>
              </div>
              <div className="v2-seg">
                <button className={chartType === "bar" ? "active" : ""} onClick={() => setChartType("bar")}>
                  Bars
                </button>
                <button className={chartType === "line" ? "active" : ""} onClick={() => setChartType("line")}>
                  Lines
                </button>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={320}>
                {chartType === "bar" ? (
                  <BarChart data={data.monthly} barCategoryGap="22%" barGap={3}>
                    <defs>
                      {ys.map((y) => (
                        <linearGradient key={y} id={`myg-${y}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={yearColors[String(y)]} stopOpacity={1} />
                          <stop offset="100%" stopColor={yearColors[String(y)]} stopOpacity={0.45} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="4 6" stroke={chart.grid} vertical={false} />
                    <XAxis dataKey="month" {...axisProps} />
                    <YAxis {...axisProps} width={56} tickFormatter={(v) => fmt(Number(v))} />
                    <Tooltip {...tooltipProps} formatter={(v) => fmt(Number(v))} />
                    <Legend />
                    {ys.map((y) => (
                      <Bar key={y} dataKey={String(y)} fill={`url(#myg-${y})`} radius={[8, 8, 2, 2]} animationDuration={900} />
                    ))}
                  </BarChart>
                ) : (
                  <LineChart data={data.monthly}>
                    <CartesianGrid strokeDasharray="4 6" stroke={chart.grid} vertical={false} />
                    <XAxis dataKey="month" {...axisProps} />
                    <YAxis {...axisProps} width={56} tickFormatter={(v) => fmt(Number(v))} />
                    <Tooltip {...tooltipProps} formatter={(v) => fmt(Number(v))} />
                    <Legend />
                    {ys.map((y, i) => (
                      <Line
                        key={y}
                        type="monotone"
                        dataKey={String(y)}
                        stroke={yearColors[String(y)]}
                        strokeWidth={i === ys.length - 1 ? 3 : 2}
                        strokeDasharray={i === ys.length - 1 ? undefined : "6 5"}
                        dot={{ r: 3, strokeWidth: 0, fill: yearColors[String(y)] }}
                        animationDuration={900}
                      />
                    ))}
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
          </div>

          <div className="analytics-grid v2-two">
            {[
              { title: "Salesperson by year", rows: data.salespersons },
              { title: "Product by year", rows: data.products },
            ].map((block) => (
              <div className="card" key={block.title}>
                <div className="section-head">
                  <div>
                    <h2>{block.title}</h2>
                    <p className="section-subtext">
                      Top {block.rows.length} · growth = {ys[ys.length - 1]} vs {ys[ys.length - 2] ?? "—"}
                    </p>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="data-table v2-compact-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        {ys.map((y) => (
                          <th key={y} style={{ textAlign: "right" }}>
                            {y}
                          </th>
                        ))}
                        <th style={{ textAlign: "right" }}>Growth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {block.rows.map((r) => (
                        <tr key={r.name} style={{ cursor: "default" }}>
                          <td>{r.name}</td>
                          {ys.map((y) => (
                            <td key={y} style={{ textAlign: "right" }}>
                              {fmt(r.values[String(y)] || 0)}
                            </td>
                          ))}
                          <td style={{ textAlign: "right" }}>
                            <Growth value={r.growth_pct} />
                          </td>
                        </tr>
                      ))}
                      {block.rows.length === 0 && (
                        <tr>
                          <td colSpan={ys.length + 2} className="org-muted">
                            No data
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
