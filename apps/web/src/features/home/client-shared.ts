/** Shared transport + house constants for the home feature (single-sourced). */
import { getJSON } from '@/lib/fetch';

/** The placeholder for an absent value — the house `—` (see `features/executor/shapers.ts`). */
export const DASH = '—';

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v); // internal helper; imported by sibling domain modules, not re-exported by the barrel.

/**
 * Transport behind the home page's `useJson` hook. URL constants live here;
 * the hook (guards, loading/error state) stays in `ui.tsx`.
 */
export function fetchJson<T>(url: string): Promise<T> {
  return getJSON<T>(url, { cache: 'no-store' });
}
