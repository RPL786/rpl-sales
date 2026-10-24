/**
 * Subtle 3D tilt for dashboard cards (one delegated listener for the whole app).
 * Disabled for touch screens and for users who prefer reduced motion.
 */
const TILT_SELECTOR = ".metric-card, .scorecard, .insight-card, .mini-card, .v2-tilt";
const MAX_DEG = 6;

let installed = false;

export function installTilt(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const fine = window.matchMedia?.("(pointer: fine)");
  let current: HTMLElement | null = null;
  let frame = 0;

  const reset = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.removeProperty("--tilt-x");
    el.style.removeProperty("--tilt-y");
    el.style.removeProperty("--glare-x");
    el.style.removeProperty("--glare-y");
    el.classList.remove("is-tilting");
  };

  document.addEventListener(
    "pointermove",
    (e) => {
      if (reduce?.matches || (fine && !fine.matches)) return;
      const target = (e.target as Element | null)?.closest?.(TILT_SELECTOR) as HTMLElement | null;
      if (target !== current) {
        reset(current);
        current = target;
      }
      if (!target) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = target.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        target.style.setProperty("--tilt-x", `${((0.5 - py) * MAX_DEG).toFixed(2)}deg`);
        target.style.setProperty("--tilt-y", `${((px - 0.5) * MAX_DEG).toFixed(2)}deg`);
        target.style.setProperty("--glare-x", `${(px * 100).toFixed(1)}%`);
        target.style.setProperty("--glare-y", `${(py * 100).toFixed(1)}%`);
        target.classList.add("is-tilting");
      });
    },
    { passive: true }
  );

  document.addEventListener("pointerleave", () => {
    reset(current);
    current = null;
  });
  window.addEventListener("blur", () => {
    reset(current);
    current = null;
  });
}
