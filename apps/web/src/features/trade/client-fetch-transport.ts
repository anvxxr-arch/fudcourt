/**
 * client-fetch-transport.ts — bounded transport shared by the trade fetchers.
 *
 * Single-sources FETCH_TIMEOUT_MS: every call the trade domain makes is
 * BOUNDED. The cross-venue ticker fans out to ten exchanges and is
 * staged-cached — cold it has been measured at 71–80 s, and a stuck upstream
 * can push it past two minutes. A board that hangs the page is worse than one
 * that says it could not reach the source, so no panel is allowed to wait
 * forever: on timeout the panel renders a named failure and the rest of the
 * page stays usable.
 */
import { getJSON } from '@/lib/fetch';

export const FETCH_TIMEOUT_MS = 30_000;

/** Combine the caller's abort signal with this module's timeout. */
export function bounded(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** POST a JSON payload: the same no-store, bounded call as the reads above. */
export async function postJson<T>(url: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  return getJSON<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: bounded(signal),
    cache: 'no-store',
  });
}

/**
 * The shared catch → message conversion, so no panel calls `String(e)`.
 *
 * A timeout is reported as what it is — the source did not answer inside the
 * module's budget — rather than as a bare "signal timed out", which tells a
 * trader nothing about whether their order or the board was at fault.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `timed out after ${FETCH_TIMEOUT_MS / 1000}s — the source did not answer`;
  }
  return err instanceof Error ? err.message : String(err);
}
