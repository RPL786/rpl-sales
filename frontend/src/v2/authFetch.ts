/**
 * Adds the logged-in user's Bearer token to every API request that doesn't set one.
 *
 * Backend endpoints that were previously open (upload, reset, forecast, form options,
 * salesperson insights...) now require login, and several components call them with a
 * bare fetch(). Installing this once in main.tsx keeps all of them working.
 * Requests to other hosts are never touched, so the token is not leaked.
 */
export function apiBaseUrl(): string {
  return (
    ((import.meta as any)?.env?.VITE_API_BASE_URL as string) ||
    (window.location.port === "5173" ? "http://127.0.0.1:8000" : "")
  );
}

function isApiRequest(url: string): boolean {
  const base = apiBaseUrl();
  if (base && url.startsWith(base)) return true;
  if (url.startsWith("/")) return !url.startsWith("//");
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

let installed = false;

export function installAuthFetch(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const token = localStorage.getItem("auth_token");
    if (!token || !isApiRequest(url)) return original(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    return original(input, { ...init, headers }).then((res) => {
      if (res.status === 401 && localStorage.getItem("auth_token") === token && !url.includes("/login")) {
        // Expired/invalid session: clear and return to login once.
        localStorage.removeItem("auth_token");
        localStorage.removeItem("auth_user");
        window.location.href = "/";
      }
      return res;
    });
  };
}

export async function apiJson<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { detail: text };
  }
  if (!res.ok) {
    const detail = body?.detail;
    throw new Error(typeof detail === "string" ? detail : `Request failed (${res.status})`);
  }
  return body as T;
}
