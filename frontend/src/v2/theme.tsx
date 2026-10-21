import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { apiJson } from "./authFetch";

export type Theme = "night" | "day";

function currentUsername(): string {
  try {
    return JSON.parse(localStorage.getItem("auth_user") || "{}")?.username || "";
  } catch {
    return "";
  }
}

// Per-user key so two people sharing one browser don't inherit each other's theme.
const storageKey = (username: string) => `rpl-theme:${username || "_guest"}`;

function readLocal(username: string): Theme | null {
  try {
    const v = localStorage.getItem(storageKey(username));
    return v === "day" || v === "night" ? v : null;
  } catch {
    return null;
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

/** Apply the stored theme before React renders, to avoid a flash. Explicit choice wins over system. */
export function bootTheme(): void {
  applyTheme(readLocal(currentUsername()) ?? "night");
}

export function useTheme() {
  const username = currentUsername();
  const [theme, setThemeState] = useState<Theme>(() => readLocal(username) ?? "night");

  useEffect(() => applyTheme(theme), [theme]);

  // Server profile preference wins when no local explicit choice exists yet (new device).
  useEffect(() => {
    if (!localStorage.getItem("auth_token")) return;
    let cancelled = false;
    apiJson<{ preferences?: { theme?: Theme } }>("/api/v2/me")
      .then((me) => {
        const serverTheme = me?.preferences?.theme;
        if (!cancelled && serverTheme && !readLocal(username)) {
          setThemeState(serverTheme);
          localStorage.setItem(storageKey(username), serverTheme);
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
      try {
        localStorage.setItem(storageKey(username), next);
      } catch {
        /* storage blocked: theme still applies for this session */
      }
      if (localStorage.getItem("auth_token")) {
        apiJson("/api/v2/me/preferences", { method: "PUT", body: JSON.stringify({ theme: next }) }).catch(
          () => undefined
        );
      }
    },
    [username]
  );

  const toggle = useCallback(() => setTheme(theme === "night" ? "day" : "night"), [theme, setTheme]);
  return { theme, setTheme, toggle, systemTheme };
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
