export type Accent = "orange" | "blue" | "emerald" | "purple" | "rose";

export const ACCENTS: Record<Accent, { label: string; main: string; light: string; deep: string; rgb: string }> = {
  orange: { label: "Orange", main: "#ff6b35", light: "#ff9255", deep: "#d9481a", rgb: "255, 107, 53" },
  blue: { label: "Blue", main: "#3b82f6", light: "#60a5fa", deep: "#1d4ed8", rgb: "59, 130, 246" },
  emerald: { label: "Emerald", main: "#10b981", light: "#34d399", deep: "#047857", rgb: "16, 185, 129" },
  purple: { label: "Purple", main: "#8b5cf6", light: "#a78bfa", deep: "#6d28d9", rgb: "139, 92, 246" },
  rose: { label: "Rose", main: "#f43f5e", light: "#fb7185", deep: "#be123c", rgb: "244, 63, 94" },
};

export const ACCENT_KEYS = Object.keys(ACCENTS) as Accent[];

export function isAccent(v: unknown): v is Accent {
  return typeof v === "string" && v in ACCENTS;
}

export function applyAccent(accent: Accent): void {
  const a = ACCENTS[accent] ?? ACCENTS.orange;
  const root = document.documentElement;
  root.dataset.accent = accent;
  root.style.setProperty("--accent", a.main);
  root.style.setProperty("--accent-2", a.light);
  root.style.setProperty("--accent-3", a.deep);
  root.style.setProperty("--accent-rgb", a.rgb);
}

/** Colors for Recharts (SVG attributes need real values, not CSS variables). */
export function chartColors(accent: Accent, theme: "night" | "day") {
  const a = ACCENTS[accent] ?? ACCENTS.orange;
  const night = theme === "night";
  const others = ACCENT_KEYS.filter((k) => k !== accent).map((k) => ACCENTS[k].main);
  return {
    accent: a.main,
    accentLight: a.light,
    muted: night ? "#8b8b94" : "#9ca3af",
    grid: night ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.07)",
    tick: night ? "#a1a1aa" : "#6b7280",
    tooltipBg: night ? "rgba(30,30,34,0.92)" : "rgba(255,255,255,0.96)",
    tooltipBorder: night ? "rgba(255,255,255,0.10)" : "rgba(15,23,42,0.10)",
    tooltipText: night ? "#f4f4f5" : "#111827",
    cursor: `rgba(${a.rgb}, 0.08)`,
    series: [a.main, "#f5b041", ...others.filter((c) => c !== "#f5b041")].slice(0, 5),
  };
}
