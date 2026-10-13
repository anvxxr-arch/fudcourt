// Service probes for /status — the same loopback tiers the Telegram bot checks.
// DR-002: FUDCourt is loopback-only, so the bot reaches the services on 127.0.0.1
// and reports what it actually measured — never a fabricated OK.

export interface Service {
  label: string;
  url: string;
}

/** The loopback tiers. `dataUrl` is configurable; the rest are the fixed ports. */
export function fudServices(dataUrl: string): Service[] {
  return [
    { label: "web", url: "http://127.0.0.1:3100/" },
    { label: "data", url: `${dataUrl}/healthz` },
    { label: "reconciled", url: "http://127.0.0.1:3102/healthz" },
    { label: "api", url: "http://127.0.0.1:3103/healthz" },
  ];
}

export interface ProbeResult {
  label: string;
  ok: boolean;
  /** HTTP status when a response arrived, else undefined. */
  status?: number;
  /** Short honest detail: "down", "timeout", "http 500", "bad url". */
  detail: string;
}

/**
 * probe performs one GET with a hard timeout. A non-2xx or a transport error is
 * reported honestly — never a fake OK.
 */
export async function probe(svc: Service, fetchImpl: typeof fetch = fetch, timeoutMs = 4000): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(svc.url, { method: "GET", signal: ctrl.signal });
    // Drain so the socket returns to the pool.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    if (res.status >= 200 && res.status < 300) {
      return { label: svc.label, ok: true, status: res.status, detail: "ok" };
    }
    return { label: svc.label, ok: false, status: res.status, detail: `http ${res.status}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const detail = name === "AbortError" ? "timeout" : "down";
    return { label: svc.label, ok: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

/** probeAll runs every service probe in parallel. */
export async function probeAll(services: Service[], fetchImpl: typeof fetch = fetch): Promise<ProbeResult[]> {
  return Promise.all(services.map((s) => probe(s, fetchImpl)));
}
