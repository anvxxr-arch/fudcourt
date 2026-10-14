// Anti-spam scoring — deterministic and explainable. No ML: a moderator must be
// able to read *why* a score was what it was, so every contribution is a named,
// bounded term and the total is their sum (clamped to 0..100).
//
// The scale the brief specifies:
//   0–30 normal · 31–60 suspicious · 61–80 spam · 81–100 severe

export interface SpamSignals {
  /** Messages the user sent in the window, INCLUDING the current one. */
  messagesInWindow: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Identical (normalized) messages in the window, including this one. */
  duplicates: number;
  /** Distinct channels the user posted in during the window. */
  channels: number;
  /** Mentions in the current message. */
  mentions: number;
  /** Messages in the shortest burst sub-window (e.g. the last 5s). */
  burst: number;
}

export type Severity = "normal" | "suspicious" | "spam" | "severe";

export interface SpamBreakdown {
  /** Per-term contribution, each already clamped to its own ceiling. */
  rate: number;
  duplicates: number;
  crossChannel: number;
  mentions: number;
  burst: number;
}

export interface SpamScore {
  score: number;
  severity: Severity;
  breakdown: SpamBreakdown;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** scoreSpam turns raw signals into a 0–100 score plus its per-term breakdown. */
export function scoreSpam(s: SpamSignals): SpamScore {
  const rate = clamp((s.messagesInWindow / Math.max(1, s.windowSeconds)) * 20, 0, 40);
  const duplicates = clamp((s.duplicates - 1) * 10, 0, 25);
  const crossChannel = clamp((s.channels - 1) * 8, 0, 15);
  const mentions = clamp(s.mentions * 3, 0, 15);
  const burst = clamp((s.burst - 3) * 5, 0, 20);

  const breakdown: SpamBreakdown = { rate, duplicates, crossChannel, mentions, burst };
  const score = Math.round(clamp(rate + duplicates + crossChannel + mentions + burst, 0, 100));
  return { score, severity: severityOf(score), breakdown };
}

/** severityOf maps a score to its band (the brief's thresholds, inclusive). */
export function severityOf(score: number): Severity {
  if (score <= 30) return "normal";
  if (score <= 60) return "suspicious";
  if (score <= 80) return "spam";
  return "severe";
}

/** explain renders a one-line, human-readable account of a score. */
export function explain(s: SpamScore): string {
  const b = s.breakdown;
  return (
    `spam score ${s.score} (${s.severity}) — ` +
    `rate ${b.rate.toFixed(0)} + dup ${b.duplicates.toFixed(0)} + ` +
    `xchan ${b.crossChannel.toFixed(0)} + mentions ${b.mentions.toFixed(0)} + ` +
    `burst ${b.burst.toFixed(0)}`
  );
}
