import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export type MenuItem = { key: string; label: string; icon?: ReactNode; onClick: () => void; hint?: string };

/** Small "More" dropdown so the header keeps only the 2–3 actions people use daily. */
export default function ActionMenu({ items, label = "More" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!items.length) return null;
  return (
    <div className="v2-menu" ref={ref}>
      <button
        type="button"
        className="action-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={16} /> {label}
      </button>
      {open && (
        <div className="v2-menu-panel" role="menu">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <span className="v2-menu-icon">{it.icon}</span>
              <span>
                {it.label}
                {it.hint && <small>{it.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
