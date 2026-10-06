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
