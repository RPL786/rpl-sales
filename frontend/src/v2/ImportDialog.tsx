import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  History,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { apiBaseUrl, apiJson } from "./authFetch";

type Props = {
  teams: string[];
  defaultTeam: string;
  onClose: () => void;
  onDone: () => void;
};

type ProductCheck = {
  product: string;
  file_name?: string | null;
  file_lines: number;
  saved_lines: number;
  file_qty: number;
  saved_qty: number;
  difference: number;
};
type Skipped = { sheet: string; row: number; reason: string; product: string; quantity: number };
type Check = {
  ok: boolean;
  file_qty: number;
  saved_qty: number;
  difference: number;
  products: ProductCheck[];
  mismatched_products: number;
  skipped_rows: number;
  skipped: Skipped[];
};
type Result = {
  inserted_rows: number;
  import_id: number;
  replaced_rows?: number;
  date_from?: string;
  date_to?: string;
  check?: Check;
};
type Repeat = {
  message: string;
  same_file: null | { filename: string; imported_at: string; by: string; rows: number };
  overlap_lines: number;
  overlap_qty: number;
  file_lines: number;
  date_from: string | null;
  date_to: string | null;
};
type ImportRow = {
  id: number;
  team: string;
  filename: string;
  mode: string;
  rows: number;
  qty: number;
  date_from: string | null;
  date_to: string | null;
  imported_at: string;
  by: string;
  undone_at: string | null;
  check_ok: boolean | null;
};

const fmt = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v || 0);
const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
const off = (p: ProductCheck) => Math.abs(p.difference) > Math.max(0.01, Math.abs(p.file_qty) * 1e-6);

function UndoButton({ id, onUndone }: { id: number; onUndone: (msg: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const undo = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await apiJson<{ removed: number; note: string }>(`/api/v2/imports/${id}/undo`, {
        method: "POST",
        body: JSON.stringify({ confirm: "UNDO" }),
      });
      onUndone(`${r.removed} lines removed. ${r.note}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  if (!asking) {
    return (
      <>
        <button className="ghost-btn" onClick={() => setAsking(true)}>
          <RotateCcw size={14} /> Undo import
        </button>
        {error && <small className="v2-voice-err">{error}</small>}
      </>
    );
  }
  return (
    <span className="v2-imp-confirm">
      Remove all lines from this import?
      <button className="action-btn v2-btn-danger" disabled={busy} onClick={undo}>
        {busy ? <Loader2 size={14} className="v2-spin" /> : null} Yes, undo
      </button>
      <button className="ghost-btn" onClick={() => setAsking(false)}>
        No
      </button>
    </span>
  );
}

function CheckReport({ check }: { check: Check }) {
  const [showAll, setShowAll] = useState(false);
  const bad = check.products.filter(off);
  const rows = showAll ? check.products : bad;
  return (
    <div className="v2-imp-check">
      <div className={`v2-imp-verdict ${check.ok ? "ok" : "warn"}`}>
        {check.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <div>
          <strong>{check.ok ? "Totals match the Excel file" : "Some totals do not match the Excel file"}</strong>
          <small>
            Excel quantity {fmt(check.file_qty)} · saved {fmt(check.saved_qty)}
            {!check.ok && ` · difference ${fmt(check.difference)}`}
          </small>
        </div>
      </div>

      {(rows.length > 0 || check.products.length > 0) && (
        <>
          <div className="table-wrap">
            <table className="data-table v2-compact-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th style={{ textAlign: "right" }}>Excel qty</th>
                  <th style={{ textAlign: "right" }}>Saved qty</th>
                  <th style={{ textAlign: "right" }}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.product} style={{ cursor: "default" }}>
                    <td>
                      {p.product}
                      {p.file_name && p.file_name !== p.product && <small className="org-muted"> (Excel: {p.file_name})</small>}
                    </td>
                    <td style={{ textAlign: "right" }}>{fmt(p.file_qty)}</td>
                    <td style={{ textAlign: "right" }}>{fmt(p.saved_qty)}</td>
                    <td style={{ textAlign: "right" }}>
                      {off(p) ? <span className="v2-status tone-bad">{fmt(p.difference)}</span> : <span className="v2-status tone-good">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="ghost-btn" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show only differences" : `Show all ${check.products.length} products`}
          </button>
        </>
      )}

      {check.skipped_rows > 0 && (
        <details className="v2-imp-skipped">
          <summary>
            {check.skipped_rows} Excel row{check.skipped_rows === 1 ? " was" : "s were"} not saved — see why
          </summary>
          <ul>
            {check.skipped.map((s, i) => (
              <li key={i}>
                Sheet "{s.sheet}" row {s.row}: {s.reason} — {s.product}, qty {fmt(s.quantity)}
              </li>
            ))}
          </ul>
          <small className="org-muted">Fix these rows in Excel and import only them again.</small>
        </details>
      )}
    </div>
  );
}

function RecentImports({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    apiJson<{ imports: ImportRow[] }>("/api/v2/imports")
      .then((r) => setRows(r.imports.slice(0, 8)))
      .catch(() => setRows([]));
  }, [refresh, tick]);
  if (!rows) return <p className="org-muted">Loading…</p>;
  if (!rows.length) return <p className="org-muted">No imports yet.</p>;
  return (
    <div className="v2-imp-history">
      {msg && <div className="status success">{msg}</div>}
      {rows.map((r) => (
        <div key={r.id} className={`v2-imp-item ${r.undone_at ? "undone" : ""}`}>
          <div>
            <strong>{r.filename || "Excel file"}</strong>
            <small>
              {r.team} · {r.rows} lines · qty {fmt(r.qty)}
              {r.date_from && ` · ${r.date_from}${r.date_to && r.date_to !== r.date_from ? ` to ${r.date_to}` : ""}`}
            </small>
            <small>
              {when(r.imported_at)} by {r.by || "—"} · {r.mode === "replace" ? "Replace" : "Add"}
              {r.check_ok === false && " · totals did not match"}
            </small>
          </div>
          {r.undone_at ? (
            <span className="v2-status">Undone</span>
          ) : (
            <UndoButton
              id={r.id}
              onUndone={(m) => {
                setMsg(m);
                setTick((n) => n + 1);
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Excel import as a guided dialog: team → add or replace → file → totals check. */
export default function ImportDialog({ teams, defaultTeam, onClose, onDone }: Props) {
  const [team, setTeam] = useState(defaultTeam || "");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [repeat, setRepeat] = useState<Repeat | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [undoneMsg, setUndoneMsg] = useState("");

  const canSubmit = !!team && !!file && !busy && (mode === "append" || confirmReplace);

  const submit = async (force = false) => {
    if (!team || !file) return;
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `${apiBaseUrl()}/data/upload?team=${encodeURIComponent(team)}&mode=${mode}${force ? "&force=true" : ""}`,
        { method: "POST", body: fd }
      );
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body?.detail?.code === "repeat_import") {
        setRepeat(body.detail as Repeat);
        return;
      }
      if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `Upload failed (${res.status})`);
      setRepeat(null);
      setResult(body as Result);
      onDone();
    } catch (e: any) {
      setError(e.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v2-drawer-backdrop" onClick={onClose}>
      <div className="v2-modal v2-modal-wide" role="dialog" aria-label="Import Excel" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <FileSpreadsheet size={20} /> Import Excel
            </h2>
            <p className="section-subtext">Choose a team, choose a method, attach a file</p>
          </div>
          <button className="ghost-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {result ? (
          <div className="v2-modal-body">
            {undoneMsg ? (
              <div className="v2-modal-done">
                <RotateCcw size={40} />
                <h3>Import undone</h3>
                <p className="org-muted">{undoneMsg}</p>
              </div>
            ) : (
              <>
                <div className="v2-modal-done compact">
                  <CheckCircle2 size={36} />
                  <h3>{result.inserted_rows} lines imported</h3>
                  <p className="org-muted">
                    Team: {team}
                    {result.date_from && ` · ${result.date_from}${result.date_to !== result.date_from ? ` to ${result.date_to}` : ""}`}
                    {!!result.replaced_rows && ` · ${result.replaced_rows} old lines replaced`}
                  </p>
                </div>
                {result.check && <CheckReport check={result.check} />}
              </>
            )}
            <div className="org-form-row" style={{ justifyContent: "space-between" }}>
              {!undoneMsg ? (
                <UndoButton
                  id={result.import_id}
                  onUndone={(m) => {
                    setUndoneMsg(m);
                    onDone();
                  }}
                />
              ) : (
                <span />
              )}
              <button className="action-btn primary-btn" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : repeat ? (
          <div className="v2-modal-body">
            <div className="v2-imp-verdict warn">
              <AlertTriangle size={20} />
              <div>
                <strong>Already imported?</strong>
                <small>{repeat.message} Importing again with "Add" would count these sales twice.</small>
              </div>
            </div>
            <ul className="v2-imp-reasons">
              {repeat.same_file && (
                <li>
                  This exact file was imported on <b>{when(repeat.same_file.imported_at)}</b> by {repeat.same_file.by || "—"} (
                  {repeat.same_file.rows} lines).
                </li>
              )}
              {repeat.overlap_lines > 0 && (
                <li>
                  <b>
                    {repeat.overlap_lines} of {repeat.file_lines}
                  </b>{" "}
                  lines in this file (qty {fmt(repeat.overlap_qty)}) are already saved for {team}
                  {repeat.date_from && ` (${repeat.date_from} to ${repeat.date_to})`}.
                </li>
              )}
            </ul>
            <p className="org-muted">
              If you are sending corrected data for the same period, use "Replace" or undo the earlier import first (Recent imports below).
            </p>
            {error && <div className="status error">{error}</div>}
            <div className="org-form-row" style={{ justifyContent: "flex-end" }}>
              <button className="action-btn primary-btn" onClick={() => setRepeat(null)}>
                Don't import
              </button>
              <button className="action-btn" disabled={busy} onClick={() => submit(true)}>
                {busy ? <Loader2 size={16} className="v2-spin" /> : null} Import anyway
              </button>
            </div>
            <button className="ghost-btn" onClick={() => setShowHistory((v) => !v)}>
              <History size={14} /> Recent imports
            </button>
            {showHistory && <RecentImports refresh={0} />}
          </div>
        ) : (
          <div className="v2-modal-body">
            <label className="v2-field">
              <span>1. Team</span>
              <select className="filter-select" value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">Select team…</option>
                {teams.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <div className="v2-field">
              <span>2. Method</span>
              <div className="v2-choice">
                <button className={mode === "append" ? "active" : ""} onClick={() => setMode("append")}>
                  <strong>Add</strong>
                  <small>New rows are added to the existing data</small>
                </button>
                <button
                  className={mode === "replace" ? "active danger" : ""}
                  onClick={() => {
                    setMode("replace");
                    setConfirmReplace(false);
                  }}
                >
                  <strong>Replace</strong>
                  <small>Remove all of this team's existing data and load the new file</small>
                </button>
              </div>
              {mode === "replace" && (
                <label className="v2-check">
                  <input type="checkbox" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} />
                  Yes, replace the existing sales data for <b>{team || "this team"}</b>
                </label>
              )}
            </div>

            <label className="v2-field">
              <span>3. Excel file</span>
              <div className={`v2-drop ${file ? "has-file" : ""}`}>
                <Upload size={18} />
                <span>{file ? file.name : "Choose a file (.xlsx / .xls)"}</span>
                <input type="file" accept=".xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </div>
            </label>

            {error && <div className="status error">{error}</div>}

            <div className="org-form-row" style={{ justifyContent: "space-between" }}>
              <button className="ghost-btn" onClick={() => setShowHistory((v) => !v)}>
                <History size={14} /> Recent imports
              </button>
              <div className="org-form-row">
                <button className="action-btn" onClick={onClose}>
                  Cancel
                </button>
                <button className="action-btn primary-btn" disabled={!canSubmit} onClick={() => submit(false)}>
                  {busy ? <Loader2 size={16} className="v2-spin" /> : <Upload size={16} />}
                  {busy ? "Importing…" : "Import"}
                </button>
              </div>
            </div>
            {showHistory && <RecentImports refresh={0} />}
          </div>
        )}
      </div>
    </div>
  );
}
