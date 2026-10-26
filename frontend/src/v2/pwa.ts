/** Install-as-app support (PWA): service worker registration + "Install app" prompt. */

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let deferred: InstallEvent | null = null;

export function setupPwa(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    window.dispatchEvent(new Event("rpl-install-available"));
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    window.dispatchEvent(new Event("rpl-install-available"));
  });

  // Service workers need HTTPS (or localhost). Skip in the Vite dev server.
  const isDev = window.location.port === "5173";
  if ("serviceWorker" in navigator && window.isSecureContext && !isDev) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("SW registration failed", err));
    });
  }
}

export function canInstall(): boolean {
  return !!deferred;
}

export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const choice = await deferred.userChoice;
  deferred = null;
  window.dispatchEvent(new Event("rpl-install-available"));
  return choice.outcome === "accepted";
}

/** Show a system notification (works on Android too, via the service worker when available). */
export async function systemNotify(title: string, body: string): Promise<void> {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) {
      await reg.showNotification(title, { body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: "rpl-daily" });
      return;
    }
    new Notification(title, { body, icon: "/icons/icon-192.png", tag: "rpl-daily" });
  } catch {
    /* some browsers block notifications from pages */
  }
}
