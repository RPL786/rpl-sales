import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";
import { apiBaseUrl } from "./authFetch";

const RELOAD_KEY = "rpl-chunk-reload-at";
const CHUNK_RE = /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|Failed to fetch dynamically/i;

let lastReport = 0;

/** Send a front-end crash to the server log, so it shows up in Portainer next to the API lines. */
export function reportClientError(kind: string, message: string, stack = "", where = "") {
  const now = Date.now();
  if (now - lastReport < 3000) return; // avoid floods
  lastReport = now;
  try {
    const user = JSON.parse(localStorage.getItem("auth_user") || "{}")?.username || "";
    fetch(`${apiBaseUrl()}/api/v2/client-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        message: String(message || "").slice(0, 500),
        stack: String(stack || "").slice(0, 2000),
        where,
        url: window.location.pathname,
        user,
        agent: navigator.userAgent.slice(0, 200),
      }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* never let reporting break the page */
  }
}

/** After a new release the open tab may ask for old file names: reload once instead of a white screen. */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  window.location.reload();
  return true;
}

export function installGlobalErrorReporting() {
  window.addEventListener("vite:preloadError", (e) => {
    e.preventDefault();
    reportClientError("chunk", "New version: reloading", "", "preload");
    reloadForNewVersion();
  });
  window.addEventListener("error", (e) => {
    if (!e.message) return;
    reportClientError("window", e.message, e.error?.stack || `${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r: any = e.reason;
    const msg = r?.message || String(r);
    if (/Failed to fetch|NetworkError|Load failed|aborted/i.test(msg)) return; // offline / server restarting
    reportClientError("promise", msg, r?.stack || "");
  });
}

type Props = { children: ReactNode; where?: string; onHome?: () => void };
type State = { error: Error | null };

/** Shows a friendly message (and reports the error) instead of a blank white page. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (CHUNK_RE.test(error?.message || "") && reloadForNewVersion()) return;
    reportClientError("render", error?.message || String(error), `${error?.stack || ""}\n${info.componentStack || ""}`, this.props.where || "");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const isChunk = CHUNK_RE.test(error.message || "");
    return (
      <div className="card v2-crash" role="alert">
        <AlertTriangle size={30} />
        <h2>{isChunk ? "A new version of the app is available" : "Something went wrong on this screen"}</h2>
        <p className="org-muted">
          {isChunk
            ? "Please reload to continue."
            : "Your data is safe. Reload the page, or go back to Home. The error has been sent to the system log."}
        </p>
        {!isChunk && <code className="v2-crash-msg">{error.message}</code>}
        <div className="org-form-row" style={{ justifyContent: "center" }}>
          <button className="action-btn primary-btn" onClick={() => window.location.reload()}>
            <RotateCcw size={16} /> Reload
          </button>
          {this.props.onHome && (
            <button
              className="action-btn"
              onClick={() => {
                this.setState({ error: null });
                this.props.onHome?.();
              }}
            >
              <Home size={16} /> Home
            </button>
          )}
        </div>
      </div>
    );
  }
}
