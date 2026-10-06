import { getJSON } from '@/lib/fetch';

export function fetchScoreboard<T>(): Promise<T> {
  return getJSON<T>('/api/signals?type=scoreboard', { cache: 'no-store' });
}
