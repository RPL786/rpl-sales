import { useEffect, useState } from "react";
import { CheckCircle2, Copy, EyeOff, Loader2, Merge, Package, RefreshCw, ShieldCheck, Trash2, Users } from "lucide-react";
import { apiJson } from "./authFetch";

type Spelling = { name: string; lines: number; qty: number };
type Group = { key: string; suggested: string; spellings: Spelling[]; total_lines: number };
type DupLine = {
  team: string;
  sales_person: string;
  client_name: string;
  product: string;
  entry_date: string;
  quantity: number;
  amount: number;
  copies: number;
};
type Health = {
  products: { groups: Group[]; count: number };
  clients: { groups: Group[]; count: number };
  ignored?: { product: number; client: number };
  duplicate_lines: { groups: number; extra_lines: number; extra_qty: number; sample: DupLine[] };
};

const fmt = (v: number) => new Intl.NumberFormat().format(Math.round((v || 0) * 100) / 100);

function VariantGroups({
  kind,
  groups,
  onMerged,
}: {
  kind: "product" | "client";
  groups: Group[];
  onMerged: (msg: string) => void;
}) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const merge = async (g: Group) => {
    const canonical = choice[g.key] ?? g.suggested;
    setBusy(g.key);
    setError("");
    try {
      const r = await apiJson<{ sales_lines_updated: number; visits_updated: number }>("/api/v2/data-health/merge", {
        method: "POST",
        body: JSON.stringify({ kind, canonical, variants: g.spellings.map((s) => s.name).filter((n) => n !== canonical) }),
      });
      onMerged(`Merged into "${canonical}" — ${r.sales_lines_updated} sales lines and ${r.visits_updated} visits updated.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const notSame = async (g: Group) => {
    setBusy(g.key);
    setError("");
    try {
      await apiJson("/api/v2/data-health/ignore", { method: "POST", body: JSON.stringify({ kind, key: g.key }) });
      onMerged(`Marked as different ${kind === "product" ? "products" : "customers"} — hidden from this list.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  if (!groups.length) {
    return (
      <p className="org-muted v2-dh-ok">
        <CheckCircle2 size={16} /> No duplicate spellings found.
      </p>
    );
  }
  return (
    <div className="v2-dh-groups">
      {error && <div className="status error">{error}</div>}
      {groups.map((g) => {
        const selected = choice[g.key] ?? g.suggested;
        return (
          <div className="v2-dh-group" key={g.key}>
            <div className="v2-dh-spellings">
              {g.spellings.map((s) => (
                <label key={s.name} className={`v2-dh-spelling ${selected === s.name ? "active" : ""}`}>
                  <input
                    type="radio"
                    name={`${kind}-${g.key}`}
                    checked={selected === s.name}
                    onChange={() => setChoice((c) => ({ ...c, [g.key]: s.name }))}
                  />
                  <span>
                    <strong>{s.name}</strong>
                    <small>
                      {s.lines} sales line{s.lines === 1 ? "" : "s"}
                      {kind === "product" ? ` · ${fmt(s.qty)} qty` : ""}
                      {s.lines === 0 ? " · product list only" : ""}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <button className="action-btn primary-btn" disabled={!!busy} onClick={() => merge(g)}>
              {busy === g.key ? <Loader2 size={15} className="v2-spin" /> : <Merge size={15} />} Keep selected, merge others
            </button>
            <button className="ghost-btn" disabled={!!busy} onClick={() => notSame(g)} title="These are different items — stop showing them">
              <EyeOff size={14} /> Not the same
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default function DataHealth() {
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const [confirm, setConfirm] = useState("");
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    setError("");
    apiJson<Health>("/api/v2/data-health")
      .then(setData)
      .catch((e) => setError(e.message));
  }, [tick]);

  const done = (m: string) => {
    setMsg(m);
    setTick((n) => n + 1);
  };

  const removeDuplicates = async () => {
    setRemoving(true);
    setError("");
    try {
      const r = await apiJson<{ removed: number }>("/api/v2/data-health/remove-duplicate-lines", {
        method: "POST",
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      setConfirm("");
      done(`${r.removed} duplicate sales line${r.removed === 1 ? "" : "s"} removed.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRemoving(false);
    }
  };

  const resetIgnored = async () => {
    setError("");
    try {
      const r = await apiJson<{ removed: number }>("/api/v2/data-health/ignore/reset", { method: "POST" });
      done(`${r.removed} hidden group${r.removed === 1 ? "" : "s"} shown again.`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const hiddenCount = (data?.ignored?.product || 0) + (data?.ignored?.client || 0);
  const d = data?.duplicate_lines;
  return (
    <div className="v2-stack">
      <div className="card">
        <div className="section-head v2-wrap">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ShieldCheck size={20} /> Data Health
            </h2>
            <p className="section-subtext">
              Finds problems that make totals wrong: the same product or customer spelled differently, and sales lines imported twice.
            </p>
          </div>
          <button className="ghost-btn" onClick={() => setTick((n) => n + 1)}>
            <RefreshCw size={14} /> Re-check
          </button>
        </div>
        {msg && <div className="status success">{msg}</div>}
        {error && <div className="status error">{error}</div>}
      </div>

      {!data && !error && (
        <div className="card v2-skeleton">
          <div /> <div /> <div />
        </div>
      )}

      {data && (
        <>
          <div className="v2-kpi-row">
            <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className={`v2-kpi-icon ${data.products.count ? "tone-3" : "tone-2"}`}>
                  <Package />
                </span>
              </div>
              <p className="metric-title">Product name variants</p>
              <h3 className="metric-value">{data.products.count}</h3>
              <p className="metric-sub">Same product, different spelling</p>
            </div>
            <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className={`v2-kpi-icon ${data.clients.count ? "tone-3" : "tone-2"}`}>
                  <Users />
                </span>
              </div>
              <p className="metric-title">Customer name variants</p>
              <h3 className="metric-value">{data.clients.count}</h3>
              <p className="metric-sub">Same customer, different spelling</p>
            </div>
            <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className={`v2-kpi-icon ${d?.extra_lines ? "tone-5" : "tone-2"}`}>
                  <Copy />
                </span>
              </div>
              <p className="metric-title">Duplicate sales lines</p>
              <h3 className="metric-value">{d?.extra_lines ?? 0}</h3>
              <p className="metric-sub">Extra quantity counted: {fmt(d?.extra_qty ?? 0)}</p>
            </div>
          </div>

          <div className="card">
            <div className="section-head">
              <div>
                <h2>Product names</h2>
                <p className="section-subtext">
                  Pick the correct spelling; all sales and visits move to it and the extra names are removed. Pack sizes are kept
                  apart (1.5 KG never matches 15 KG). If a group is really different items, click "Not the same".
                </p>
              </div>
            </div>
            <VariantGroups kind="product" groups={data.products.groups} onMerged={done} />
          </div>

          <div className="card">
            <div className="section-head">
              <div>
                <h2>Customer names</h2>
                <p className="section-subtext">Merging makes Customer 360, retention and at-risk lists accurate.</p>
              </div>
            </div>
            <VariantGroups kind="client" groups={data.clients.groups} onMerged={done} />
          </div>

          {hiddenCount > 0 && (
            <p className="org-muted">
              {hiddenCount} group{hiddenCount === 1 ? "" : "s"} marked "Not the same" are hidden.{" "}
              <button className="ghost-btn" onClick={resetIgnored}>
                Show them again
              </button>
            </p>
          )}

          <div className="card">
            <div className="section-head">
              <div>
                <h2>Sales lines imported twice</h2>
                <p className="section-subtext">
                  Lines identical in team, salesperson, customer, product, date, quantity and amount. Usually the same Excel file
                  was imported with "Add" more than once.
                </p>
              </div>
            </div>
            {!d?.extra_lines ? (
              <p className="org-muted v2-dh-ok">
                <CheckCircle2 size={16} /> No duplicate lines found.
              </p>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table v2-compact-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Team</th>
                        <th>Salesperson</th>
                        <th>Customer</th>
                        <th>Product</th>
                        <th style={{ textAlign: "right" }}>Qty</th>
                        <th style={{ textAlign: "right" }}>Copies</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.sample.map((r, i) => (
                        <tr key={i} style={{ cursor: "default" }}>
                          <td>{String(r.entry_date || "").slice(0, 10)}</td>
                          <td>{r.team}</td>
                          <td>{r.sales_person}</td>
                          <td>{r.client_name}</td>
                          <td>{r.product}</td>
                          <td style={{ textAlign: "right" }}>{fmt(r.quantity)}</td>
                          <td style={{ textAlign: "right" }}>
                            <span className="v2-status tone-bad">×{r.copies}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="org-muted" style={{ marginTop: 10 }}>
                  Check a few against your Excel first — two genuinely identical sales on the same day would also appear here. Keeps
                  one copy of each line. Take a backup first (More → Download Backup).
                </p>
                <div className="org-form-row">
                  <input
                    className="filter-select"
                    style={{ maxWidth: 260 }}
                    placeholder='Type "DELETE" to confirm'
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                  <button className="action-btn v2-btn-danger" disabled={confirm !== "DELETE" || removing} onClick={removeDuplicates}>
                    {removing ? <Loader2 size={16} className="v2-spin" /> : <Trash2 size={16} />} Remove {d.extra_lines} extra copies
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
