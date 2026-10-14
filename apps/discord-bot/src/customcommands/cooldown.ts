// Cooldown state for custom commands — the ephemeral per-(command, member)
// throttle. Its surface is tiny and injectable so the service is fully testable
// against an in-memory store, and a Valkey-backed adapter drops in behind the
// same interface later (exactly the shape automod/state.ts uses).
//
// Nothing here is authoritative config; it is a short-lived timer, which is
// precisely the workload Valkey is meant for once a second process ever needs
// to share it.

export interface CooldownStore {
  /** Remaining ms until the key is free; 0 when the key is free. */
  remainingMs(key: string, now: number): Promise<number>;
  /** Start (or restart) a cooldown window for the key. */
  mark(key: string, seconds: number, now: number): Promise<void>;
}

/**
 * InMemoryCooldownStore — the default store. State is per-process and lost on
 * restart, which is correct for a throttle: a restart merely lets the next
 * invocation through instead of leaving a member locked out.
 */
export class InMemoryCooldownStore implements CooldownStore {
  private readonly until = new Map<string, number>();

  async remainingMs(key: string, now: number): Promise<number> {
    const exp = this.until.get(key);
    if (exp === undefined) return 0;
    if (exp <= now) {
      this.until.delete(key);
      return 0;
    }
    return exp - now;
  }

  async mark(key: string, seconds: number, now: number): Promise<void> {
    if (seconds <= 0) return;
    this.until.set(key, now + seconds * 1000);
  }
}
