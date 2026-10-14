/**
 * Rendering the api's timestamps.
 *
 * Every timestamp the api returns comes from
 *   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
 * → `2026-10-14 23:10:00`: UTC, with no zone marker. Handing that string to `Date` is
 * implementation-defined, and every engine reads it as LOCAL time, which is a silent seven-hour lie
 * to a reader in WIB and a day-boundary lie around midnight. So this module does the one thing a
 * renderer should not leave to the reader: it states which clock the value is on.
 *
 * Rendering goes through `toISOString` rather than a locale formatter on purpose — the output must be
 * a pure function of the string, identical under every `TZ`, or the same row reads differently
 * depending on where the operator happens to be. Values this module cannot read are returned
 * VERBATIM: an unreadable timestamp is a fact about a bad write, and "Invalid Date" hides it.
 */

/** The api's own shape: `YYYY-MM-DD HH:MM:SS` (space or `T`), no zone. */
const API_FORMAT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/** A value that names its own zone (`Z` or `±hh:mm`) — read as written, never re-interpreted. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** formatWireTime renders an api timestamp on a stated clock. */
export function formatWireTime(value: string): string {
  const ms = wireEpoch(value);
  if (ms === null) {
    return value;
  }
  return renderUTC(ms);
}

/**
 * wireEpoch turns a wire timestamp into an epoch reading, or null when it cannot be read with
 * confidence. Anything carrying no zone and not matching the api's format is refused rather than
 * guessed at: it is not this renderer's place to decide what an unlabelled string meant.
 */
function wireEpoch(value: string): number | null {
  const raw = value.trim();
  if (raw === '') {
    return null;
  }
  if (API_FORMAT.test(raw)) {
    // Read the api's format as UTC explicitly — `Date.parse(raw)` would read it as local time.
    const ms = Date.parse(`${raw.replace(' ', 'T')}Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  if (!ZONED.test(raw)) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** renderUTC formats an epoch as UTC without touching locale or the process timezone. */
function renderUTC(ms: number): string {
  const [date, time] = new Date(ms).toISOString().split('T') as [string, string];
  const [year, month, day] = date.split('-') as [string, string, string];
  return `${day}/${month}/${year}, ${time.slice(0, 8)} UTC`;
}
