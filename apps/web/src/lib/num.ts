/**
 * num.ts — text-from-a-form to number, the one spelling of the empty-field rule.
 *
 * Inputs hand numbers over as strings. An empty or whitespace-only field is
 * ABSENT (`undefined`), never a silent `0`; a field that is present but not a
 * finite number is absent too. Pure, no React, no state — importable from the
 * trade composer and the executor panels alike, so the two cannot drift.
 */
export function num(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * An already-decoded value (query param, parsed JSON field, upstream payload
 * key) into a finite number, or `null` when it is absent, non-numeric, or
 * non-finite. The `unknown`-in counterpart to `num` above: same honesty about
 * absent values, different input shape — `null` rather than `undefined` so it
 * composes with the `T | null` payload shapes the API routes and providers
 * already carry.
 */
export function numParam(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
