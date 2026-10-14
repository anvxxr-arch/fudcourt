// Discord snowflakes are 64-bit ids that also encode a creation timestamp:
//   ms_since_epoch = (id >> 22) + 1420070400000
// Kept as a string end-to-end (never a JS number) so precision never leaks; this
// helper is the ONE place the epoch arithmetic lives.

const DISCORD_EPOCH = 1420070400000n;

/** snowflakeToMs returns the ms-since-Unix-epoch the id was created, or null. */
export function snowflakeToMs(id: string): number | null {
  if (!/^\d{5,20}$/.test(id)) return null;
  try {
    const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** accountAgeHours returns how many hours ago an account id was created, or null. */
export function accountAgeHours(id: string, now: number): number | null {
  const created = snowflakeToMs(id);
  if (created === null) return null;
  return (now - created) / 3_600_000;
}
