import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlarmClock, Bell, BellRing, CalendarClock, Gauge, TrendingDown, UserRoundX } from "lucide-react";
import { apiJson } from "./authFetch";
import { systemNotify } from "./pwa";

type Item = { kind: string; level: "high" | "medium" | "low"; tab: string; title: string; detail: string };
type Resp = { count: number; items: Item[]; today: string };

const ICONS: Record<string, ReactNode> = {
  overdue: <AlarmClock size={16} />,
  today: <CalendarClock size={16} />,
  behind: <TrendingDown size={16} />,
  pace: <Gauge size={16} />,
  risk: <UserRoundX size={16} />,
};

function currentUserKey() {
  try {
    const u = JSON.parse(localStorage.getItem("auth_user") || "{}");
    return String(u?.id ?? u?.username ?? "_");
  } catch {
    return "_";
  }
}

/** Header bell: reminders for follow-ups, target pace and customers at risk (refreshes every 5 minutes). */
export default function NotificationBell({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [data, setData] = useState<Resp | null>(null);
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<string>(() => ("Notification" in window ? Notification.permission : "unsupported"));
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiJson<Resp>("/api/v2/notifications")
        .then((r) => {
          if (!alive) return;
          setData(r);
          // one system notification per user per day, only if there is something to act on
          const key = `rpl-notified:${currentUserKey()}`;
          if (r.count > 0 && localStorage.getItem(key) !== r.today) {
            const urgent = r.items.filter((i) => i.level !== "low").map((i) => i.title);
            systemNotify("RPL Sales — today", urgent.slice(0, 3).join(" · ")).then(() => {
              if (Notification?.permission === "granted") localStorage.setItem(key, r.today);
            });
          }
        })
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const enable = async () => {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    setPerm(p);
    if (p === "granted" && data?.count) {
      systemNotify("RPL Sales", "Reminders are on. You will get a daily summary of follow-ups.");
    }
  };

  const count = data?.count ?? 0;
  return (
    <div className="v2-menu v2-bell" ref={ref}>
      <button
        type="button"
        className={`action-btn v2-bell-btn ${count ? "has" : ""}`}
        aria-label={`Reminders${count ? `: ${count}` : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        {count ? <BellRing size={17} /> : <Bell size={17} />}
        {count > 0 && <span className="v2-badge">{count}</span>}
      </button>
      {open && (
        <div className="v2-menu-panel v2-bell-panel" role="menu">
          <div className="v2-bell-head">
            <strong>Reminders</strong>
            <small className="org-muted">Updated every 5 minutes</small>
          </div>
          {(data?.items ?? []).length === 0 && <p className="org-muted" style={{ padding: "8px 10px" }}>Nothing pending. 🎉</p>}
          {(data?.items ?? []).map((it, i) => (
            <button
              key={`${it.kind}-${i}`}
              type="button"
              role="menuitem"
              className={`v2-bell-item lvl-${it.level}`}
              onClick={() => {
                setOpen(false);
                onNavigate(it.tab);
              }}
            >
              <span className="v2-menu-icon">{ICONS[it.kind] ?? <Bell size={16} />}</span>
              <span>
                {it.title}
                {it.detail && <small>{it.detail}</small>}
              </span>
            </button>
          ))}
          {perm === "default" && (
            <button type="button" className="v2-bell-enable" onClick={enable}>
              <BellRing size={15} /> Turn on phone / desktop reminders
            </button>
          )}
          {perm === "denied" && (
            <p className="org-muted v2-bell-note">System notifications are blocked in this browser's site settings.</p>
          )}
        </div>
      )}
    </div>
  );
}
