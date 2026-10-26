/**
 * Offline queue for visit entries.
 * When the phone has no signal, visits are kept on the device (per user) and sent
 * automatically when the connection comes back.
 */
import { apiBaseUrl } from "./authFetch";

export type QueuedVisit = { qid: string; queued_at: string; payload: Record<string, unknown> };

function userKey(): string {
  try {
    const u = JSON.parse(localStorage.getItem("auth_user") || "{}");
    return `rpl-visit-queue:${u?.id ?? u?.username ?? "_"}`;
  } catch {
    return "rpl-visit-queue:_";
  }
}

export function readQueue(): QueuedVisit[] {
  try {
    const raw = localStorage.getItem(userKey());
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueuedVisit[]) {
  try {
    localStorage.setItem(userKey(), JSON.stringify(items));
  } catch {
    /* storage full or blocked */
  }
  window.dispatchEvent(new CustomEvent("rpl-queue-changed", { detail: items.length }));
}

export function enqueueVisit(payload: Record<string, unknown>): number {
  const items = readQueue();
  items.push({ qid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, queued_at: new Date().toISOString(), payload });
  writeQueue(items);
  return items.length;
}

/** Thrown when the request never reached the server (no signal, server down). */
export class OfflineError extends Error {}

export async function postVisit(payload: Record<string, unknown>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/api/visit-entry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new OfflineError("No connection");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body?.detail === "string" ? body.detail : `Save failed (${res.status})`);
  }
}

let flushing = false;

/** Send queued visits. Stops at the first connection failure; drops items the server rejects. */
export async function flushQueue(): Promise<{ sent: number; failed: number; left: number }> {
  if (flushing || !navigator.onLine || !localStorage.getItem("auth_token")) {
    return { sent: 0, failed: 0, left: readQueue().length };
  }
  flushing = true;
  let sent = 0;
  let failed = 0;
  try {
    let items = readQueue();
    while (items.length) {
      const [first, ...rest] = items;
      try {
        await postVisit(first.payload);
        sent += 1;
      } catch (e) {
        if (e instanceof OfflineError) break;
        failed += 1; // validation error: keep a copy for the user in the console, don't retry forever
        console.warn("Queued visit rejected by server", first, e);
      }
      items = rest;
      writeQueue(items);
    }
  } finally {
    flushing = false;
  }
  return { sent, failed, left: readQueue().length };
}

let installed = false;

export function installQueueSync(onResult?: (r: { sent: number; failed: number; left: number }) => void) {
  if (installed) return;
  installed = true;
  const run = () =>
    flushQueue().then((r) => {
      if (r.sent || r.failed) onResult?.(r);
    });
  window.addEventListener("online", run);
  window.setInterval(run, 60_000);
  run();
}
