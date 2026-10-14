import { HttpError } from '@/lib/fetch';

/**
 * describeSaveFailure turns a refused write into the sentence an operator can act on.
 *
 * Every admin panel POSTs a whole list to a Go endpoint that answers a refusal with a `detail`
 * sentence — the field that is wrong, the row whose name is taken, the store that is not
 * configured. The panel's job is to SHOW that sentence. "HTTP 400" tells an operator nothing
 * they can act on, and a panel that rewrites the api's words drifts from the code that refused.
 *
 * `conflict` is the one status whose fix is not in the field the message names: a 409 on
 * `scheduled_jobs` means the NAME belongs to another panel, so the hint says what to do instead
 * of letting the message read like a crash. A panel whose endpoint has no 409 passes no hint
 * and gets the plain sentence — the mechanism is shared, the wording stays with the panel that
 * knows what its refusals mean.
 */
export function describeSaveFailure(err: unknown, conflict?: { detail: string; hint: string }): string {
  if (err instanceof HttpError) {
    if (err.status === 409 && conflict !== undefined) {
      const detail = err.detail === '' ? conflict.detail : err.detail;
      return `refused: ${detail} — ${conflict.hint}`;
    }
    return err.detail === '' ? `refused (HTTP ${err.status})` : `refused: ${err.detail}`;
  }
  return err instanceof Error ? err.message : 'save failed';
}
