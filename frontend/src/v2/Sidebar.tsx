import type { ReactNode } from "react";
import { LogOut, Moon, Sun } from "lucide-react";
import type { Theme } from "./theme";
import { ACCENTS, ACCENT_KEYS, type Accent } from "./accent";

export const APP_VERSION = "2.0";

export type SidebarItem = { key: string; label: string; icon: ReactNode };
export type SidebarGroup = { key: string; label: string; items: SidebarItem[] };

type Props = {
  groups: SidebarGroup[];
  activeKey: string;
  onSelect: (key: string) => void;
  username: string;
  roleLabel: string;
  theme: Theme;
  onToggleTheme: () => void;
  accent: Accent;
  onAccent: (a: Accent) => void;
  onLogout: () => void;
};

function initials(name: string) {
  const parts = name.replace(/[_.-]+/g, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || parts[0]?.[1] || "")).toUpperCase() || "U";
}

export default function Sidebar({
  groups,
  activeKey,
  onSelect,
  username,
  roleLabel,
  theme,
  onToggleTheme,
  accent,
  onAccent,
  onLogout,
}: Props) {
  const isNight = theme === "night";
  return (
    <aside className="v2-sidebar" aria-label="Main navigation">
      <div className="v2-brand">
        <div className="v2-brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="v2-brand-text">
          <strong>RPL Sales</strong>
          <small>Ressichem</small>
        </div>
        <span className="v2-version" title={`RPL Sales version ${APP_VERSION}`}>
          v{APP_VERSION}
        </span>
      </div>

      <nav className="v2-side-nav">
        {groups.map((g) => (
          <div className="v2-side-group" key={g.key}>
            <p className="v2-side-group-label">{g.label}</p>
            {g.items.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`v2-side-item ${activeKey === item.key ? "active" : ""}`}
                aria-current={activeKey === item.key ? "page" : undefined}
                onClick={() => onSelect(item.key)}
              >
                <span className="v2-side-icon">{item.icon}</span>
                <span className="v2-side-label">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="v2-side-bottom">
        <div className="v2-accent-picker" role="radiogroup" aria-label="Accent color">
          <span className="v2-side-group-label">Theme color</span>
          <div className="v2-accent-dots">
            {ACCENT_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={accent === key}
                aria-label={ACCENTS[key].label}
                title={ACCENTS[key].label}
                className={`v2-accent-dot ${accent === key ? "active" : ""}`}
                style={{ background: `linear-gradient(135deg, ${ACCENTS[key].light}, ${ACCENTS[key].main})` }}
                onClick={() => onAccent(key)}
              />
            ))}
          </div>
        </div>
        <button type="button" className="v2-side-item v2-theme-switch" onClick={onToggleTheme}>
          <span className="v2-side-icon">{isNight ? <Sun size={16} /> : <Moon size={16} />}</span>
          <span className="v2-side-label">{isNight ? "Day mode" : "Night mode"}</span>
        </button>
        <button type="button" className="v2-side-item" onClick={onLogout}>
          <span className="v2-side-icon">
            <LogOut size={16} />
          </span>
          <span className="v2-side-label">Logout</span>
        </button>

        <div className="v2-user-card">
          <div className="v2-avatar">{initials(username)}</div>
          <div className="v2-user-meta">
            <strong>{username}</strong>
            <small>{roleLabel}</small>
          </div>
        </div>
      </div>
    </aside>
  );
}
