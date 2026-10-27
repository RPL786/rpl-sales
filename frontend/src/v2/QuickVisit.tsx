import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarPlus,
  Check,
  CloudOff,
  Loader2,
  MapPin,
  Package,
  RotateCcw,
  Search,
  StickyNote,
  UserRound,
} from "lucide-react";
import { apiJson } from "./authFetch";
import { OfflineError, enqueueVisit, flushQueue, postVisit, readQueue } from "./offlineQueue";
import NameHint from "./NameHint";
import VoiceButton from "./VoiceButton";

type Props = {
  canChooseOwner: boolean;
  onSaved?: () => void;
};

const MEETING_TYPES = ["Initial Visit", "Follow-up", "Closing", "Future Scheduled"];
const STATUSES = ["Interested", "Thinking", "Need Follow-up", "No Response", "Order Received", "Rejected", "Closed"];
const CATEGORIES = [
  "Retail",
  "Industrial",
  "Distributor",
  "Dealer",
  "Applicator/Contractor",
  "Architect/Consultant",
  "Home / Project Owner",
  "Other",
];
const CLOSED = new Set(["Order Received", "Rejected", "Closed"]);

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDate(d);
};
const nextMonday = () => {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return localDate(d);
};

type Form = {
  team: string;
  sales_person: string;
  client_name: string;
  client_category: string;
  product: string;
  meeting_date: string;
  meeting_time: string;
  meeting_type: string;
  meeting_status: string;
  client_response: string;
  quantity: string;
  order_amount: string;
  next_meeting_date: string;
  notes: string;
};

const fresh = (keep?: Partial<Form>): Form => ({
  team: keep?.team || "",
  sales_person: keep?.sales_person || "",
  client_name: "",
  client_category: "",
  product: keep?.product || "",
  meeting_date: localDate(),
  meeting_time: localTime(),
  meeting_type: "Initial Visit",
  meeting_status: "",
  client_response: "",
  quantity: "",
  order_amount: "",
  next_meeting_date: "",
  notes: "",
});

/** One visit at a time, big touch targets, works offline. */
export default function QuickVisit({ canChooseOwner, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => fresh());
  const [products, setProducts] = useState<string[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [hits, setHits] = useState<{ name: string; has_sales: boolean }[]>([]);
  const [showHits, setShowHits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<"" | "saved" | "queued">("");
  const [queued, setQueued] = useState(readQueue().length);
  const [online, setOnline] = useState(navigator.onLine);
  const timer = useRef<number | undefined>(undefined);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    // product list is cached so the form still works without signal
    apiJson<{ products: { name: string }[] }>("/api/products")
      .then((r) => {
        const list = r.products.map((p) => p.name).filter(Boolean);
        setProducts(list);
        try {
          localStorage.setItem("rpl-products-cache", JSON.stringify(list));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        try {
          setProducts(JSON.parse(localStorage.getItem("rpl-products-cache") || "[]"));
        } catch {
          /* ignore */
        }
      });
    if (canChooseOwner) {
      apiJson<{ teams: { name: string }[] }>("/api/teams")
        .then((r) => setTeams(r.teams.map((t) => t.name)))
        .catch(() => undefined);
    }
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    const q = (e: Event) => setQueued(Number((e as CustomEvent).detail ?? readQueue().length));
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("rpl-queue-changed", q);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("rpl-queue-changed", q);
    };
  }, [canChooseOwner]);

  // customer suggestions
  useEffect(() => {
    window.clearTimeout(timer.current);
    const q = form.client_name.trim();
    if (q.length < 2 || !online) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(() => {
      apiJson<{ customers: { name: string; has_sales: boolean }[] }>(`/api/v2/customers/search?q=${encodeURIComponent(q)}&limit=8`)
        .then((r) => setHits(r.customers.filter((c) => c.name.toLowerCase() !== q.toLowerCase())))
        .catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [form.client_name, online]);

  const needsFollowUp = form.meeting_status && !CLOSED.has(form.meeting_status);
  const missing = useMemo(() => {
    const m: string[] = [];
    if (!form.client_name.trim()) m.push("customer");
    if (!form.product) m.push("product");
    if (!form.meeting_status) m.push("outcome");
    if (canChooseOwner && !form.team) m.push("team");
    if (canChooseOwner && !form.sales_person.trim()) m.push("salesperson");
    return m;
  }, [form, canChooseOwner]);

  const save = async () => {
    if (missing.length || busy) return;
    setBusy(true);
    setError("");
    const payload = {
      team: form.team,
      sales_person: form.sales_person.trim(),
      client_name: form.client_name.trim(),
      client_category: form.client_category,
      product: form.product,
      meeting_date: form.meeting_date,
      meeting_time: form.meeting_time,
      meeting_type: form.meeting_type,
      meeting_status: form.meeting_status,
      client_response: form.client_response.trim(),
      order_amount: Number(form.order_amount || 0),
      quantity: Number(form.quantity || 0),
      future_potential: 0,
      next_meeting_date: needsFollowUp ? form.next_meeting_date : "",
      next_meeting_time: "",
      notes: form.notes.trim(),
    };
    try {
      await postVisit(payload);
      setDone("saved");
      onSaved?.();
      flushQueue();
    } catch (e) {
      if (e instanceof OfflineError) {
        setQueued(enqueueVisit(payload));
        setDone("queued");
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const another = () => {
    setForm((f) => fresh({ team: f.team, sales_person: f.sales_person }));
    setDone("");
  };

  if (done) {
    return (
      <div className="card v2-qv-done">
        {done === "saved" ? <Check size={46} /> : <CloudOff size={46} />}
        <h2>{done === "saved" ? "Visit saved" : "Saved on this device"}</h2>
        <p className="org-muted">
          {done === "saved"
            ? `${form.client_name} · ${form.meeting_status}${form.next_meeting_date && needsFollowUp ? ` · follow-up ${form.next_meeting_date}` : ""}`
            : "No connection right now. It will be sent automatically when you are back online."}
        </p>
        <button className="action-btn primary-btn v2-qv-big" onClick={another}>
          <RotateCcw size={18} /> Log another visit
        </button>
      </div>
    );
  }

  return (
    <div className="v2-qv">
      {(!online || queued > 0) && (
        <div className={`v2-qv-banner ${online ? "" : "offline"}`}>
          <CloudOff size={16} />
          {online
            ? `${queued} visit${queued === 1 ? "" : "s"} waiting to sync…`
            : `You are offline. Visits will be saved on this device${queued ? ` (${queued} waiting)` : ""}.`}
        </div>
      )}

      {canChooseOwner && (
        <div className="card v2-qv-section">
          <h3>
            <UserRound size={16} /> For whom
          </h3>
          <div className="v2-qv-row">
            <select className="filter-select" value={form.team} onChange={(e) => set("team", e.target.value)}>
              <option value="">Team…</option>
              {teams.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <input
              className="filter-select"
              placeholder="Salesperson"
              value={form.sales_person}
              onChange={(e) => set("sales_person", e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="card v2-qv-section">
        <h3>
          <MapPin size={16} /> Customer
        </h3>
        <div className="v2-search v2-qv-search">
          <Search size={18} />
          <input
            placeholder="Customer name"
            value={form.client_name}
            onChange={(e) => {
              set("client_name", e.target.value);
              setShowHits(true);
            }}
            onFocus={() => setShowHits(true)}
            onBlur={() => window.setTimeout(() => setShowHits(false), 150)}
            autoComplete="off"
          />
          {showHits && hits.length > 0 && (
            <div className="v2-search-results">
              {hits.map((h) => (
                <button
                  key={h.name}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    set("client_name", h.name);
                    setShowHits(false);
                  }}
                >
                  <strong>{h.name}</strong>
                  <small>{h.has_sales ? "Existing customer" : "Visited before"}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <NameHint kind="client" name={form.client_name} enabled={online && !showHits} onUse={(n) => set("client_name", n)} />
        <div className="v2-chips-scroll">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className={`v2-pick ${form.client_category === c ? "active" : ""}`}
              onClick={() => set("client_category", form.client_category === c ? "" : c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="card v2-qv-section">
        <h3>
          <Package size={16} /> Visit
        </h3>
        <select className="filter-select v2-qv-input" value={form.product} onChange={(e) => set("product", e.target.value)}>
          <option value="">Product discussed…</option>
          {products.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <div className="v2-qv-row">
          <input className="filter-select v2-qv-input" type="date" value={form.meeting_date} onChange={(e) => set("meeting_date", e.target.value)} />
          <input className="filter-select v2-qv-input" type="time" value={form.meeting_time} onChange={(e) => set("meeting_time", e.target.value)} />
        </div>
        <div className="v2-seg v2-qv-seg">
          {MEETING_TYPES.map((t) => (
            <button key={t} className={form.meeting_type === t ? "active" : ""} onClick={() => set("meeting_type", t)}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="card v2-qv-section">
        <h3>Outcome</h3>
        <div className="v2-outcomes">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={`v2-outcome ${form.meeting_status === s ? "active" : ""} ${
                s === "Order Received" ? "good" : s === "Rejected" ? "bad" : ""
              }`}
              onClick={() => set("meeting_status", s)}
            >
              {s}
            </button>
          ))}
        </div>
        {form.meeting_status === "Order Received" && (
          <div className="v2-qv-row">
            <input className="filter-select v2-qv-input" inputMode="decimal" placeholder="Quantity" value={form.quantity} onChange={(e) => set("quantity", e.target.value.replace(/[^\d.]/g, ""))} />
            <input className="filter-select v2-qv-input" inputMode="decimal" placeholder="Order amount (Rs)" value={form.order_amount} onChange={(e) => set("order_amount", e.target.value.replace(/[^\d.]/g, ""))} />
          </div>
        )}
        <input
          className="filter-select v2-qv-input"
          placeholder="Customer response (optional)"
          value={form.client_response}
          onChange={(e) => set("client_response", e.target.value)}
        />
      </div>

      {needsFollowUp && (
        <div className="card v2-qv-section">
          <h3>
            <CalendarPlus size={16} /> Next follow-up
          </h3>
          <div className="v2-chips-scroll">
            {[
              { label: "Tomorrow", v: plusDays(1) },
              { label: "In 3 days", v: plusDays(3) },
              { label: "Next week", v: nextMonday() },
              { label: "In 2 weeks", v: plusDays(14) },
            ].map((o) => (
              <button key={o.label} className={`v2-pick ${form.next_meeting_date === o.v ? "active" : ""}`} onClick={() => set("next_meeting_date", o.v)}>
                {o.label}
              </button>
            ))}
            <input className="filter-select v2-qv-date" type="date" value={form.next_meeting_date} onChange={(e) => set("next_meeting_date", e.target.value)} />
          </div>
        </div>
      )}

      <div className="card v2-qv-section">
        <h3>
          <StickyNote size={16} /> Notes
        </h3>
        <textarea
          className="filter-select v2-qv-notes"
          placeholder="Anything to remember (optional)"
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          rows={3}
        />
        <VoiceButton value={form.notes} onChange={(v) => set("notes", v)} />
      </div>

      {error && <div className="status error">{error}</div>}

      <div className="v2-qv-savebar">
        <span className="org-muted">{missing.length ? `Still needed: ${missing.join(", ")}` : "Ready to save"}</span>
        <button className="action-btn primary-btn v2-qv-big" disabled={!!missing.length || busy} onClick={save}>
          {busy ? <Loader2 size={18} className="v2-spin" /> : <Check size={18} />} Save visit
        </button>
      </div>
    </div>
  );
}
