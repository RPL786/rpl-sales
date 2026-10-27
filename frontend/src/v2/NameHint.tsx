import { useEffect, useState } from "react";
import { CheckCircle2, Sparkles } from "lucide-react";
import { apiJson } from "./authFetch";

type Match = { name: string; saved_as: string; is_new: boolean; changed: boolean };

/**
 * Shows which spelling will be saved for a typed product / customer name.
 * "abc traders." -> "Will be saved as ABC Traders" (the server does the same, so no new name variants).
 */
export default function NameHint({
  kind,
  name,
  onUse,
  enabled = true,
}: {
  kind: "client" | "product";
  name: string;
  onUse?: (existing: string) => void;
  enabled?: boolean;
}) {
  const [match, setMatch] = useState<Match | null>(null);

  useEffect(() => {
    const q = name.trim();
    if (!enabled || q.length < 2) {
      setMatch(null);
      return;
    }
    const t = window.setTimeout(() => {
      apiJson<Match>(`/api/v2/names/match?kind=${kind}&name=${encodeURIComponent(q)}`)
        .then((m) => setMatch(m.name === q ? m : null))
        .catch(() => setMatch(null));
    }, 350);
    return () => window.clearTimeout(t);
  }, [kind, name, enabled]);

  if (!match) return null;
  const label = kind === "client" ? "customer" : "product";
  if (match.changed) {
    return (
      <div className="v2-name-hint existing">
        <CheckCircle2 size={14} />
        <span>
          Existing {label}: will be saved as <b>{match.saved_as}</b>
        </span>
        {onUse && (
          <button type="button" className="ghost-btn" onClick={() => onUse(match.saved_as)}>
            Use this
          </button>
        )}
      </div>
    );
  }
  if (match.is_new) {
    return (
      <div className="v2-name-hint new">
        <Sparkles size={14} />
        <span>New {label} — check the spelling</span>
      </div>
    );
  }
  return null;
}
