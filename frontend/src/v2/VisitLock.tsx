import { useEffect, useState } from "react";
import { Loader2, Lock, Send, Unlock } from "lucide-react";
import { apiJson } from "./authFetch";

export type LockStatus = {
  today: string;
  exempt: boolean;
  allowed_dates: string[];
  earliest_allowed: string;
  unlock_hours: number;
  open_unlocks: string[];
  my_requests: { id: number; unlock_date: string; status: string; reason: string; active: boolean }[];
};

let cache: { at: number; data: LockStatus } | null = null;

export async function loadLockStatus(force = false): Promise<LockStatus | null> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.data;
  try {
    const data = await apiJson<LockStatus>("/api/v2/visit-lock");
    cache = { at: Date.now(), data };
    return data;
  } catch {
    return null; // offline: the server still checks when the visit is sent
  }
}

export function isLocked(st: LockStatus | null, date: string, meetingType = ""): boolean {
  if (!st || st.exempt || !date) return false;
  if (date > st.today) return false; // future plans are not locked (server rejects non-plan future dates)
  if (meetingType.toLowerCase().startsWith("future")) return false;
  return date < st.earliest_allowed && !st.open_unlocks.includes(date);
}

/**
 * Shown under a visit date: tells the user the date is locked and lets them ask
 * a City Coordinator / Super Admin to unlock it.
 */
export default function DateLockNotice({ date, meetingType = "" }: { date: string; meetingType?: string }) {
  const [st, setSt] = useState<LockStatus | null>(cache?.data ?? null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadLockStatus().then(setSt);
  }, []);
  useEffect(() => {
    setMsg("");
    setError("");
  }, [date]);

  if (!isLocked(st, date, meetingType)) return null;
  const pending = st!.my_requests.find((r) => r.unlock_date === date && r.status === "pending");

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await apiJson("/api/v2/visit-unlock/requests", { method: "POST", body: JSON.stringify({ date, reason }) });
      setMsg("Request sent. You will be able to enter visits for this date once it is approved.");
      setReason("");
      setSt(await loadLockStatus(true));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v2-lock">
      <div className="v2-lock-head">
        <Lock size={16} />
        <div>
          <strong>{date} is locked</strong>
          <small>
            Visits can be entered for today and the previous 2 working days (from {st!.earliest_allowed}). Sundays are not
            counted. An approved unlock opens a date for {st!.unlock_hours} hours.
          </small>
        </div>
      </div>
      {pending ? (
        <p className="org-muted">
          <Unlock size={13} /> Unlock request sent — waiting for approval.
        </p>
      ) : msg ? (
        <p className="org-muted">{msg}</p>
      ) : (
        <div className="v2-lock-form">
          <input
            className="filter-select"
            placeholder="Reason, e.g. no signal at the site"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button className="action-btn primary-btn" disabled={busy || reason.trim().length < 5} onClick={send}>
            {busy ? <Loader2 size={15} className="v2-spin" /> : <Send size={15} />} Request unlock
          </button>
        </div>
      )}
      {error && <div className="status error">{error}</div>}
    </div>
  );
}
