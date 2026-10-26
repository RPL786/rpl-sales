import { useState } from "react";
import { CheckCircle2, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { apiBaseUrl } from "./authFetch";

type Props = {
  teams: string[];
  defaultTeam: string;
  onClose: () => void;
  onDone: () => void;
};

/** Excel import as a guided dialog (team → add or replace → file), instead of hidden confirm() prompts. */
export default function ImportDialog({ teams, defaultTeam, onClose, onDone }: Props) {
  const [team, setTeam] = useState(defaultTeam || "");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<number | null>(null);

  const canSubmit = !!team && !!file && !busy && (mode === "append" || confirmReplace);

  const submit = async () => {
    if (!canSubmit || !file) return;
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `${apiBaseUrl()}/data/upload?team=${encodeURIComponent(team)}&mode=${mode}`,
        { method: "POST", body: fd }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `Upload failed (${res.status})`);
      setResult(Number(body?.inserted_rows || 0));
      onDone();
    } catch (e: any) {
      setError(e.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v2-drawer-backdrop" onClick={onClose}>
      <div className="v2-modal" role="dialog" aria-label="Import Excel" onClick={(e) => e.stopPropagation()}>
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

        {result !== null ? (
          <div className="v2-modal-done">
            <CheckCircle2 size={44} />
            <h3>{result} rows imported</h3>
            <p className="org-muted">Team: {team}</p>
            <button className="action-btn primary-btn" onClick={onClose}>
              Done
            </button>
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

            <div className="org-form-row" style={{ justifyContent: "flex-end" }}>
              <button className="action-btn" onClick={onClose}>
                Cancel
              </button>
              <button className="action-btn primary-btn" disabled={!canSubmit} onClick={submit}>
                {busy ? <Loader2 size={16} className="v2-spin" /> : <Upload size={16} />}
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
