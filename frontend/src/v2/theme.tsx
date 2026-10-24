import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { apiJson } from "./authFetch";
import { applyAccent, isAccent, type Accent } from "./accent";

export type Theme = "night" | "day";

function currentUsername(): string {
  try {
    return JSON.parse(localStorage.getItem("auth_user") || "{}")?.username || "";
  } catch {
    return "";
  }
}

// Per-user keys so two people sharing one browser don't inherit each other's look.
const themeKey = (username: string) => `rpl-theme:${username || "_guest"}`;
const accentKey = (username: string) => `rpl-accent:${username || "_guest"}`;

// Last look used on this browser: the login screen (no user yet) opens in it.
const LAST_THEME = "rpl-theme:_last";
const LAST_ACCENT = "rpl-accent:_last";

function readLocal(username: string): Theme | null {
  try {
    const v = localStorage.getItem(username ? themeKey(username) : LAST_THEME);
    return v === "day" || v === "night" ? v : null;
  } catch {
    return null;
  }
}

function readLocalAccent(username: string): Accent | null {
  try {
    const v = localStorage.getItem(username ? accentKey(username) : LAST_ACCENT);
    return isAccent(v) ? v : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: still applies for this session */
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "day" : "night";
  } catch {
    return "night";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "day" ? "light" : "dark";
}

/** Apply the stored theme + accent before React renders, to avoid a flash. */
export function bootTheme(): void {
  const u = currentUsername();
  applyTheme(readLocal(u) ?? "night");
  applyAccent(readLocalAccent(u) ?? "orange");
}

function savePrefs(body: { theme?: Theme; accent?: Accent }) {
  if (!localStorage.getItem("auth_token")) return;
  apiJson("/api/v2/me/preferences", { method: "PUT", body: JSON.stringify(body) }).catch(() => undefined);
}

export function useTheme() {
  const username = currentUsername();
  const [theme, setThemeState] = useState<Theme>(() => readLocal(username) ?? "night");
  const [accent, setAccentState] = useState<Accent>(() => readLocalAccent(username) ?? "orange");

  useEffect(() => {
    applyTheme(theme);
    if (username) writeLocal(LAST_THEME, theme);
  }, [theme, username]);
  useEffect(() => {
    applyAccent(accent);
    if (username) writeLocal(LAST_ACCENT, accent);
  }, [accent, username]);

  // Server profile preference wins when no local explicit choice exists yet (new device).
  useEffect(() => {
    if (!localStorage.getItem("auth_token")) return;
    let cancelled = false;
    apiJson<{ preferences?: { theme?: Theme; accent?: string } }>("/api/v2/me")
      .then((me) => {
        if (cancelled) return;
        const serverTheme = me?.preferences?.theme;
        if (serverTheme && !readLocal(username)) {
          setThemeState(serverTheme);
          writeLocal(themeKey(username), serverTheme);
        }
        const serverAccent = me?.preferences?.accent;
        if (isAccent(serverAccent) && !readLocalAccent(username)) {
          setAccentState(serverAccent);
          writeLocal(accentKey(username), serverAccent);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [username]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      writeLocal(themeKey(username), next);
      writeLocal(LAST_THEME, next);
      savePrefs({ theme: next });
    },
    [username]
  );

  const setAccent = useCallback(
    (next: Accent) => {
      setAccentState(next);
      writeLocal(accentKey(username), next);
      writeLocal(LAST_ACCENT, next);
      savePrefs({ accent: next });
    },
    [username]
  );

  const toggle = useCallback(() => setTheme(theme === "night" ? "day" : "night"), [theme, setTheme]);
  return { theme, setTheme, toggle, accent, setAccent, systemTheme };
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isNight = theme === "night";
  return (
    <button
      type="button"
      className="action-btn theme-toggle"
      onClick={onToggle}
      aria-label={isNight ? "Switch to Day mode" : "Switch to Night mode"}
      title={isNight ? "Day mode" : "Night mode"}
    >
      {isNight ? <Sun size={16} /> : <Moon size={16} />}
      <span>{isNight ? "Day" : "Night"}</span>
    </button>
  );
}
