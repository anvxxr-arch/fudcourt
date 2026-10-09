/**
 * The public-board staleness channel.
 *
 * The shell renders ONE subtitle for every public board and holds no envelope
 * of its own, so the board that knows its read is a labelled last-good serve
 * publishes it here and the shell's subtitle stops contradicting the board's
 * own `StaleNotice`. `null` = the mounted board is not stale; a board clears it
 * on unmount so the flag can never stick to the next board.
 */
export type BoardStale = { source: string; fetchedAt: number; ageSec: number } | null;
let current: BoardStale = null;
const subscribers = new Set<() => void>();
/** Subscribe to board-staleness changes; returns the unsubscribe. */
export function subscribeBoardStale(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
/** The current snapshot — the SAME reference until a real change (useSyncExternalStore). */
export function getBoardStale(): BoardStale {
  return current;
}
/** Publish the mounted board's staleness. A no-op (no notify) when nothing changed. */
export function setBoardStale(next: BoardStale): void {
  if (current === next) return;
  if (
    current !== null &&
    next !== null &&
    current.source === next.source &&
    current.fetchedAt === next.fetchedAt &&
    current.ageSec === next.ageSec
  ) {
    return;
  }
  current = next;
  for (const fn of subscribers) fn();
}
