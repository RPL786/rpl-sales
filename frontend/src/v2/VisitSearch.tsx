import { Fragment, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileSpreadsheet,
  FileText,
  Loader2,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { apiBaseUrl, apiJson } from "./authFetch";

export type VisitRow = {
  id: number;
  meeting_date: string;
  meeting_time: string;
  team: string;
  sales_person: string;
  client_name: string;
  client_category?: string;
  product: string;
  meeting_type: string;
  meeting_status: string;
  client_response?: string;
  notes?: string;
  next_meeting_date?: string;
  next_meeting_time?: string;
  order_amount?: number;
  quantity?: number;
  created_by?: string;
  created_at?: string;
  entered_at?: string;
  entered_late_days?: number | null;
  edited?: { count: number; last: string; by: string } | null;
};

type Result = {
  total: number;
  page: number;
  pages: number;
  summary: {
    visits: number;
    customers: number;
    people: number;
    orders: number;
    order_amount: number;
    open_followups: number;
    first_date: string | null;
    last_date: string | null;
  };
  items: VisitRow[];
  options: { sales_people: string[]; teams: string[]; statuses: string[]; meeting_types: string[] };
};

type Activity = {
  sales_person: string;
  from: string;
  to: string;
  days: {
    date: string;
    weekday: string;
    visits: number;
    orders: number;
    entries: number;
    late_entries: number;
    sunday: boolean;
    future: boolean;
    leave?: { reason: string; status: string } | null;
  }[];
  summary: {
    visits: number;
    orders: number;
    working_days: number;
    days_with_visits: number;
    days_without_visits: number;
    late_entries: number;
    leave_days?: number;
  };
  changes: { action: string; at: string; by: string; client_name: string; meeting_date: string }[];
};

type Filters = {
  q: string;
  sales_person: string;
  team: string;
  status: string;
  meeting_type: string;
  date_from: string;
  date_to: string;
};

const EMPTY: Filters = { q: "", sales_person: "", team: "", status: "", meeting_type: "", date_from: "", date_to: "" };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmt = (v: number) => new Intl.NumberFormat().format(Math.round(v || 0));
const pl = (n: number, one: string, many: string) => (n === 1 ? one : many);

function presets() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endLast = new Date(now.getFullYear(), now.getMonth(), 0);
  return [
    { label: "Today", from: iso(now), to: iso(now) },
    { label: "This week", from: iso(monday), to: iso(now) },
    { label: "This month", from: iso(firstThis), to: iso(now) },
    { label: "Last month", from: iso(firstLast), to: iso(endLast) },
    { label: "All dates", from: "", to: "" },
  ];
}

function qs(f: Filters, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams();
  Object.entries({ ...f, ...extra }).forEach(([k, v]) => {
    if (v !== "" && v !== undefined && v !== null) p.set(k, String(v));
  });
  return p.toString();
}

function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!text || !words.length) return <>{text}</>;
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  if (!esc.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${esc.join("|")})`, "ig"));
  return (
    <>
      {parts.map((p, i) => (words.some((w) => w.toLowerCase() === p.toLowerCase()) ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

function statusTone(s: string) {
  const v = (s || "").toLowerCase();
  if (v === "order received") return "tone-good";
  if (v === "rejected" || v === "closed") return "tone-bad";
  if (v === "need follow-up") return "tone-warn";
  return "";
}

function ActivityPanel({ person, from, to, onClose }: { person: string; from: string; to: string; onClose: () => void }) {
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    apiJson<Activity>(`/api/v2/visits/activity?${qs({ ...EMPTY, sales_person: person, date_from: from, date_to: to })}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [person, from, to]);

  // group days by month for calendar grids
  const months = useMemo(() => {
    const m: Record<string, Activity["days"]> = {};
    (data?.days || []).forEach((d) => {
      (m[d.date.slice(0, 7)] ||= []).push(d);
    });
    return Object.entries(m);
  }, [data]);

  return (
    <div className="card v2-activity">
      <div className="section-head v2-wrap">
        <div>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CalendarDays size={20} /> Activity calendar — {person}
          </h2>
          <p className="section-subtext">
            Visits per day by meeting date. Red = working day with no visit, blue L = leave. A dot means some entries were
            typed in on a later day.
          </p>
        </div>
        <button className="ghost-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      {error && <div className="status error">{error}</div>}
      {!data && !error && <p className="org-muted">Loading…</p>}
      {data && (
        <>
          <div className="v2-vs-summary">
            <span>
              <b>{data.summary.visits}</b> visits
            </span>
            <span>
              <b>{data.summary.orders}</b> orders
            </span>
            <span>
              <b>{data.summary.days_with_visits}</b> of {data.summary.working_days} working days with visits
            </span>
            <span className={data.summary.days_without_visits ? "warn" : ""}>
              <b>{data.summary.days_without_visits}</b> days without visits
            </span>
            {(data.summary.leave_days || 0) > 0 && (
              <span>
                <b>{data.summary.leave_days}</b> leave days
              </span>
            )}
            {data.summary.late_entries > 0 && (
              <span>
                <b>{data.summary.late_entries}</b> entered on a later day
              </span>
            )}
          </div>
          <div className="v2-cal-months">
            {months.map(([ym, days]) => {
              const first = new Date(`${ym}-01T00:00:00`);
              const lead = (first.getDay() + 6) % 7; // Monday first
              const label = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
              const shownLead = days[0].date.endsWith("-01") ? lead : (new Date(`${days[0].date}T00:00:00`).getDay() + 6) % 7;
              return (
                <div key={ym} className="v2-cal">
                  <strong>{label}</strong>
                  <div className="v2-cal-grid">
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                      <span key={d} className="v2-cal-head">
                        {d.slice(0, 2)}
                      </span>
                    ))}
                    {Array.from({ length: shownLead }).map((_, i) => (
                      <span key={`e${i}`} />
                    ))}
                    {days.map((d) => (
                      <span
                        key={d.date}
                        className={`v2-cal-day ${d.sunday ? "off" : ""} ${d.future ? "future" : ""} ${
                          !d.sunday && !d.future && !d.visits && !d.leave ? "none" : ""
                        } ${d.visits ? "has" : ""} ${d.leave ? "leave" : ""}`}
                        title={`${d.date} (${d.weekday}): ${d.visits} visits, ${d.orders} orders, ${d.entries} entered this day${
                          d.late_entries ? `, ${d.late_entries} entered late` : ""
                        }${d.leave ? ` — on leave (${d.leave.reason}, ${d.leave.status === "rejected" ? "not approved" : d.leave.status})` : ""}`}
                      >
                        <small>{Number(d.date.slice(8))}</small>
                        <b>{d.leave && !d.visits ? "L" : d.visits || (d.sunday || d.future ? "" : "0")}</b>
                        {d.late_entries > 0 && <i className="v2-cal-late" />}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {data.changes.length > 0 && (
            <div className="v2-cal-changes">
              <strong>Edited or deleted visits in this period</strong>
              <ul>
                {data.changes.map((c, i) => (
                  <li key={i}>
                    {c.action === "delete" ? "Deleted" : "Edited"}: {c.client_name} ({c.meeting_date}) — by {c.by || "—"} on{" "}
                    {c.at ? new Date(c.at).toLocaleString() : "—"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Visit list with smart search, filters, summary, activity calendar and Excel/PDF export. */
export default function VisitSearch({
  isAdmin,
  refreshKey = 0,
  onEdit,
  onDelete,
}: {
  isAdmin: boolean;
  refreshKey?: number;
  onEdit?: (v: VisitRow) => void;
  onDelete?: (id: number) => void;
}) {
  const [f, setF] = useState<Filters>(EMPTY);
  const [typed, setTyped] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [showCal, setShowCal] = useState(false);
  const [exporting, setExporting] = useState<"" | "xlsx" | "pdf">("");

  // debounce typing
  useEffect(() => {
    const t = window.setTimeout(() => {
      setF((x) => (x.q === typed ? x : { ...x, q: typed }));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    apiJson<Result>(`/api/v2/visits/search?${qs(f, { page, page_size: 50 })}`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [f, page, refreshKey]);

  const set = (k: keyof Filters, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setPage(1);
  };
  const words = useMemo(() => f.q.split(/\s+/).filter((w) => w.length > 1), [f.q]);
  const opts = data?.options;
  const isMemberView = (opts?.sales_people.length || 0) <= 1 && !isAdmin;
  const calPerson = f.sales_person || (isMemberView ? opts?.sales_people[0] || "" : "");
  const anyFilter = Object.values(f).some(Boolean);
  const activePreset = presets().find((p) => p.from === f.date_from && p.to === f.date_to)?.label;

  const downloadXlsx = async () => {
    setExporting("xlsx");
    try {
      const res = await fetch(`${apiBaseUrl()}/api/v2/visits/export?${qs(f)}`);
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `visits_${(f.sales_person || "all").replace(/\s+/g, "_")}_${f.date_from || "start"}_to_${f.date_to || "today"}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExporting("");
    }
  };

  const downloadPdf = async () => {
    setExporting("pdf");
    try {
      const r = await apiJson<{ items: VisitRow[] }>(`/api/v2/visits/export?${qs(f, { format: "json" })}`);
      const { default: jsPDF } = await import("jspdf");
      await import("jspdf-autotable");
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(14);
      doc.text("RPL Sales — Visit report", 14, 14);
      doc.setFontSize(9);
      const parts = [
        f.sales_person && `Salesperson: ${f.sales_person}`,
        f.team && `Team: ${f.team}`,
        f.status && `Status: ${f.status}`,
        f.meeting_type && `Type: ${f.meeting_type}`,
        `Period: ${f.date_from || "start"} to ${f.date_to || "today"}`,
        f.q && `Search: "${f.q}"`,
      ].filter(Boolean);
      doc.text(parts.join("   ·   "), 14, 21);
      doc.text(
        `${r.items.length} visits · ${new Set(r.items.map((v) => v.client_name.toLowerCase())).size} customers · ${
          r.items.filter((v) => v.meeting_status === "Order Received").length
        } orders · generated ${new Date().toLocaleString()}`,
        14,
        26
      );
      (doc as any).autoTable({
        startY: 30,
        styles: { fontSize: 7, cellPadding: 1.5 },
        headStyles: { fillColor: [249, 115, 22] },
        head: [["Date", "Time", "Salesperson", "Customer", "Product", "Type", "Status", "Notes / response", "Next", "Entered at"]],
        body: r.items.map((v) => [
          v.meeting_date,
          (v.meeting_time || "").slice(0, 5),
          v.sales_person,
          v.client_name,
          v.product,
          v.meeting_type,
          v.meeting_status,
          [v.client_response, v.notes].filter(Boolean).join(" — "),
          v.next_meeting_date || "",
          v.entered_at || "",
        ]),
      });
      doc.save(`visits_${(f.sales_person || "all").replace(/\s+/g, "_")}_${f.date_from || "start"}_to_${f.date_to || "today"}.pdf`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExporting("");
    }
  };

  const s = data?.summary;
  return (
    <div className="v2-stack v2-visit-search">
      <div className="card">
        <div className="section-head v2-wrap">
          <div>
            <h2>Visit list</h2>
            <p className="section-subtext">Type any words in any order — customer, salesperson, product, status, notes or month.</p>
          </div>
          <div className="org-form-row">
            <button className="action-btn" disabled={!!exporting || !data?.total} onClick={downloadXlsx}>
              {exporting === "xlsx" ? <Loader2 size={15} className="v2-spin" /> : <FileSpreadsheet size={15} />} Excel
            </button>
            <button className="action-btn" disabled={!!exporting || !data?.total} onClick={downloadPdf}>
              {exporting === "pdf" ? <Loader2 size={15} className="v2-spin" /> : <FileText size={15} />} PDF
            </button>
            <button
              className={`action-btn ${showCal ? "primary-btn" : ""}`}
              disabled={!calPerson}
              title={calPerson ? "Day-by-day activity" : "Choose a salesperson first"}
              onClick={() => setShowCal((v) => !v)}
            >
              <CalendarDays size={15} /> Activity
            </button>
          </div>
        </div>

        <div className="v2-search v2-vs-search">
          <Search size={18} />
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder='e.g. "usman october interested" or "abc 1.5kg"'
            aria-label="Search visits"
          />
          {typed && (
            <button className="ghost-btn" onClick={() => setTyped("")} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="v2-vs-filters">
          {!isMemberView && (
            <select className="filter-select" value={f.sales_person} onChange={(e) => set("sales_person", e.target.value)}>
              <option value="">All salespeople</option>
              {opts?.sales_people.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
          {(opts?.teams.length || 0) > 1 && (
            <select className="filter-select" value={f.team} onChange={(e) => set("team", e.target.value)}>
              <option value="">All teams</option>
              {opts?.teams.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
          <select className="filter-select" value={f.status} onChange={(e) => set("status", e.target.value)}>
            <option value="">All statuses</option>
            {opts?.statuses.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select className="filter-select" value={f.meeting_type} onChange={(e) => set("meeting_type", e.target.value)}>
            <option value="">All visit types</option>
            {opts?.meeting_types.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>

        <div className="v2-vs-dates">
          {presets().map((p) => (
            <button
              key={p.label}
              className={`v2-pick ${activePreset === p.label ? "active" : ""}`}
              onClick={() => {
                setF((x) => ({ ...x, date_from: p.from, date_to: p.to }));
                setPage(1);
              }}
            >
              {p.label}
            </button>
          ))}
          <input className="filter-select" type="date" value={f.date_from} onChange={(e) => set("date_from", e.target.value)} aria-label="From" />
          <span className="org-muted">to</span>
          <input className="filter-select" type="date" value={f.date_to} onChange={(e) => set("date_to", e.target.value)} aria-label="To" />
          {anyFilter && (
            <button
              className="ghost-btn"
              onClick={() => {
                setF(EMPTY);
                setTyped("");
                setPage(1);
              }}
            >
              Clear all
            </button>
          )}
        </div>

        {s && (
          <div className="v2-vs-summary">
            <span>
              <b>{fmt(s.visits)}</b> {pl(s.visits, "visit", "visits")}
            </span>
            <span>
              <b>{fmt(s.customers)}</b> {pl(s.customers, "customer", "customers")}
            </span>
            <span>
              <b>{fmt(s.orders)}</b> {pl(s.orders, "order", "orders")}{s.order_amount ? ` (Rs ${fmt(s.order_amount)})` : ""}
            </span>
            {!isMemberView && (
              <span>
                <b>{fmt(s.people)}</b> {pl(s.people, "salesperson", "salespeople")}
              </span>
            )}
            <span>
              <b>{fmt(s.open_followups)}</b> open {pl(s.open_followups, "follow-up", "follow-ups")}
            </span>
            {s.first_date && (
              <span className="org-muted">
                {s.first_date === s.last_date ? s.first_date : `${s.first_date} → ${s.last_date}`}
              </span>
            )}
            {loading && <Loader2 size={14} className="v2-spin" />}
          </div>
        )}
        {error && <div className="status error">{error}</div>}
      </div>

      {showCal && calPerson && (
        <ActivityPanel
          person={calPerson}
          from={f.date_from || presets()[2].from}
          to={f.date_to || iso(new Date())}
          onClose={() => setShowCal(false)}
        />
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table v2-vs-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Salesperson</th>
                <th>Customer</th>
                <th>Product</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Next follow-up</th>
                <th>Entered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={9} className="org-muted">
                    No visits match. Try fewer words or clear the filters.
                  </td>
                </tr>
              )}
              {data?.items.map((v) => {
                const expanded = open === v.id;
                return (
                  <Fragment key={v.id}>
                    <tr className={expanded ? "open" : ""} onClick={() => setOpen(expanded ? null : v.id)}>
                      <td>
                        {v.meeting_date}
                        <small className="v2-vs-sub">{(v.meeting_time || "").slice(0, 5)}</small>
                      </td>
                      <td>
                        <Highlight text={v.sales_person} words={words} />
                        <small className="v2-vs-sub">{v.team}</small>
                      </td>
                      <td>
                        <strong>
                          <Highlight text={v.client_name} words={words} />
                        </strong>
                        <small className="v2-vs-sub">{v.meeting_type}</small>
                      </td>
                      <td>
                        <Highlight text={v.product} words={words} />
                      </td>
                      <td>
                        <span className={`v2-status ${statusTone(v.meeting_status)}`}>{v.meeting_status || "—"}</span>
                      </td>
                      <td className="v2-vs-notes">
                        <Highlight text={[v.client_response, v.notes].filter(Boolean).join(" — ")} words={words} />
                      </td>
                      <td>{v.next_meeting_date || "—"}</td>
                      <td>
                        <small>{v.entered_at || "—"}</small>
                        {(v.entered_late_days || 0) > 0 && <span className="v2-status tone-warn">+{v.entered_late_days}d</span>}
                        {v.edited && <span className="v2-status">edited</span>}
                      </td>
                      <td>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</td>
                    </tr>
                    {expanded && (
                      <tr className="v2-vs-detail">
                        <td colSpan={9}>
                          <div className="v2-vs-detail-grid">
                            <div>
                              <small>Customer response</small>
                              <p>{v.client_response || "—"}</p>
                            </div>
                            <div>
                              <small>Notes</small>
                              <p>{v.notes || "—"}</p>
                            </div>
                            <div>
                              <small>Category</small>
                              <p>{v.client_category || "—"}</p>
                            </div>
                            <div>
                              <small>Order</small>
                              <p>
                                {v.quantity ? `${fmt(v.quantity)} qty` : "—"}
                                {v.order_amount ? ` · Rs ${fmt(v.order_amount)}` : ""}
                              </p>
                            </div>
                            <div>
                              <small>Entered</small>
                              <p>
                                {v.entered_at || "—"} by {v.created_by || "—"}
                                {(v.entered_late_days || 0) > 0 && ` (${v.entered_late_days} days after the visit date)`}
                              </p>
                            </div>
                            {v.edited && (
                              <div>
                                <small>Edited</small>
                                <p>
                                  {v.edited.count}× · last by {v.edited.by || "—"} on {new Date(v.edited.last).toLocaleString()}
                                </p>
                              </div>
                            )}
                          </div>
                          {isAdmin && (onEdit || onDelete) && (
                            <div className="org-form-row" style={{ marginTop: 8 }}>
                              {onEdit && (
                                <button
                                  className="action-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onEdit(v);
                                    window.scrollTo({ top: 0, behavior: "smooth" });
                                  }}
                                >
                                  <Pencil size={14} /> Edit
                                </button>
                              )}
                              {onDelete && (
                                <button
                                  className="action-btn v2-btn-danger"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(v.id);
                                  }}
                                >
                                  <Trash2 size={14} /> Delete
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && data.pages > 1 && (
          <div className="v2-vs-pager">
            <button className="ghost-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft size={14} /> Previous
            </button>
            <span className="org-muted">
              Page {page} of {data.pages} · {fmt(data.total)} visits
            </span>
            <button className="ghost-btn" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
