/**
 * Boot-time warm (Next.js instrumentation, Node runtime only).
 *
 * The economy boards read keyless upstreams (FRED / World Bank / BIS) through
 * per-process memos. Those memos are cold after every deploy, so the FIRST
 * calendar read after a restart pays the entire fan-out over the ~900
 * market-moving series -- seconds when the upstreams are healthy, minutes when
 * one degrades mid-fetch (measured: >120s on a cold process during a World Bank
 * outage, 0.45s once warm).
 *
 * Firing the calendar's default window once, detached, primes the exact payload
 * a default request asks for (`_lib/calendar.ts` memoises the response on the
 * same key), turning that first user read into a memo hit. Best-effort by
 * construction: detached, one log line, and any failure leaves the cold-miss
 * inline path as the fallback. Deliberately NOT a readiness dependency -- an
 * upstream outage must never gate the listener.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Detached: never delay server start.
  void warm();
}

async function warm(): Promise<void> {
  try {
    const { warmCalendar } = await import('@/app/(frontend)/api/economy/_lib/calendar');
    const total = await warmCalendar();
    console.log(JSON.stringify({ msg: 'economy prewarm ok', events: total }));
  } catch (e) {
    console.log(JSON.stringify({ msg: 'economy prewarm skipped', reason: e instanceof Error ? e.message : String(e) }));
  }
}
