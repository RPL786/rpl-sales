import { useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { apiJson } from "./authFetch";

/** Clear Database lives here (Admin tab), behind a typed confirmation that the backend also checks. */
export default function DangerZone() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const clear = async () => {
    if (text !== "DELETE") return;
    setBusy(true);
    setError("");
    try {
      await apiJson("/admin/clear-database", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) });
      alert("Database clear ho gaya.");
      window.location.reload();
    } catch (e: any) {
      setError(e.message || "Clear failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card v2-danger">
      <div className="section-head">
        <div>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={20} /> Danger zone
          </h2>
          <p className="section-subtext">
            Clear Database saara sales data, teams, clients aur products mita deta hai. Yeh wapas nahi hota — pehle
            "Download Backup" zaroor lein.
          </p>
        </div>
      </div>
      <div className="org-form-row">
        <input
          className="filter-select"
          style={{ maxWidth: 260 }}
          placeholder='Confirm ke liye "DELETE" likhein'
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="action-btn v2-btn-danger" disabled={text !== "DELETE" || busy} onClick={clear}>
          {busy ? <Loader2 size={16} className="v2-spin" /> : <Trash2 size={16} />} Clear Database
        </button>
      </div>
      {error && <div className="status error" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}
