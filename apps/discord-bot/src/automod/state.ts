// Anti-spam short-lived state — the Valkey-backed windows the tracker reads.
//
// The store surface is tiny and injectable, so the tracker's logic is fully
// testable against an in-memory store and the production Valkey store is a thin
// adapter. Nothing here is authoritative config; it is all ephemeral counters,
// exactly the workload Valkey is for.

import { normalize } from "./matchers.ts";
import type { SpamSignals } from "./score.ts";

export interface WindowStore {
  /** Increment a counter and return the number of hits in the trailing window. */
  hit(key: string, windowSeconds: number, now: number): Promise<number>;
  /** Add a distinct member and return the distinct cardinality in the window. */
  distinct(key: string, member: string, windowSeconds: number, now: number): Promise<number>;
  /** Append to a bounded recent list (newest last) and return the list's values. */
  recent(key: string, value: string, maxLen: number, windowSeconds: number, now: number): Promise<string[]>;
  /** True when the key exists within its TTL. */
  exists(key: string, now: number): Promise<boolean>;
  /** Set a key with a TTL. */
  setWithTtl(key: string, ttlSeconds: number, now: number): Promise<void>;
}

export interface TrackerConfig {
  windowSeconds: number;
  burstSeconds: number;
  duplicateWindowSeconds: number;
}

export const DEFAULT_TRACKER: TrackerConfig = {
  windowSeconds: 30,
  burstSeconds: 5,
  duplicateWindowSeconds: 30,
};

export interface MessageObservation {
  guildId: string;
  userId: string;
  channelId: string;
  content: string;
  mentions: number;
  now: number;
}

export interface ObservedMessage {
  signals: SpamSignals;
  /** The user's recent normalized messages, INCLUDING this one (for duplicate). */
  recentContents: string[];
}

/**
 * SpamTracker turns a stream of events into the signals the scorer consumes. It
 * owns the key layout so callers never build one by hand.
 */
export class SpamTracker {
  constructor(
    private readonly store: WindowStore,
    private readonly cfg: TrackerConfig = DEFAULT_TRACKER,
  ) {}

  private base(guildId: string, userId: string): string {
    return `am:${guildId}:${userId}`;
  }

  async observeMessage(i: MessageObservation): Promise<ObservedMessage> {
    const base = this.base(i.guildId, i.userId);
    const messagesInWindow = await this.store.hit(`${base}:msg`, this.cfg.windowSeconds, i.now);
    const burst = await this.store.hit(`${base}:burst`, this.cfg.burstSeconds, i.now);
    const channels = await this.store.distinct(`${base}:chan`, i.channelId, this.cfg.windowSeconds, i.now);
    const recent = await this.store.recent(
      `${base}:recent`,
      i.content,
      20,
      this.cfg.duplicateWindowSeconds,
      i.now,
    );
    const norm = normalize(i.content);
    const duplicates = norm.length === 0 ? 0 : recent.filter((c) => normalize(c) === norm).length;
    return {
      signals: {
        messagesInWindow,
        windowSeconds: this.cfg.windowSeconds,
        duplicates,
        channels,
        mentions: i.mentions,
        burst,
      },
      recentContents: recent,
    };
  }

  /** observeJoin returns joins in the window, including this one. */
  async observeJoin(guildId: string, now: number): Promise<number> {
    return this.store.hit(`am:${guildId}:joins`, this.cfg.windowSeconds, now);
  }

  /** isCoolingDown reports whether this (rule, user) is inside its cooldown. Pure. */
  async isCoolingDown(guildId: string, ruleId: number, userId: string, now: number): Promise<boolean> {
    return this.store.exists(`am:cd:${guildId}:${ruleId}:${userId}`, now);
  }

  /** markFired starts the cooldown window for this (rule, user). */
  async markFired(
    guildId: string,
    ruleId: number,
    userId: string,
    cooldownSeconds: number,
    now: number,
  ): Promise<void> {
    if (cooldownSeconds <= 0) return;
    await this.store.setWithTtl(`am:cd:${guildId}:${ruleId}:${userId}`, cooldownSeconds, now);
  }
}

/**
 * InMemoryWindowStore — the test/dev store. Sliding windows are real (entries carry
 * timestamps and are pruned on read), so it behaves like the Valkey store without a
 * server. Not for production: state is per-process and lost on restart, which is
 * fine for the ephemeral signals it holds.
 */
export class InMemoryWindowStore implements WindowStore {
  private counters = new Map<string, number[]>();
  private sets = new Map<string, Map<string, number>>();
  private lists = new Map<string, Array<{ v: string; ts: number }>>();
  private ttl = new Map<string, number>();

  private prune(arr: number[], windowSeconds: number, now: number): number[] {
    const cutoff = now - windowSeconds * 1000;
    return arr.filter((ts) => ts >= cutoff);
  }

  async hit(key: string, windowSeconds: number, now: number): Promise<number> {
    const arr = this.prune(this.counters.get(key) ?? [], windowSeconds, now);
    arr.push(now);
    this.counters.set(key, arr);
    return arr.length;
  }

  async distinct(key: string, member: string, windowSeconds: number, now: number): Promise<number> {
    const m = this.sets.get(key) ?? new Map<string, number>();
    const cutoff = now - windowSeconds * 1000;
    for (const [k, ts] of m) if (ts < cutoff) m.delete(k);
    m.set(member, now);
    this.sets.set(key, m);
    return m.size;
  }

  async recent(key: string, value: string, maxLen: number, windowSeconds: number, now: number): Promise<string[]> {
    const cutoff = now - windowSeconds * 1000;
    const arr = (this.lists.get(key) ?? []).filter((e) => e.ts >= cutoff);
    arr.push({ v: value, ts: now });
    while (arr.length > maxLen) arr.shift();
    this.lists.set(key, arr);
    return arr.map((e) => e.v);
  }

  async exists(key: string, now: number): Promise<boolean> {
    const exp = this.ttl.get(key);
    if (exp === undefined) return false;
    if (exp <= now) {
      this.ttl.delete(key);
      return false;
    }
    return true;
  }

  async setWithTtl(key: string, ttlSeconds: number, now: number): Promise<void> {
    this.ttl.set(key, now + ttlSeconds * 1000);
  }
}
