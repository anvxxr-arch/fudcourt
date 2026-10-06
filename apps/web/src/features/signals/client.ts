import { getJSON } from '@/lib/fetch';

export function fetchSignals<T>(chain: string, mode: string, suffix = ''): Promise<T> {
  return getJSON<T>(`/api/signals?chain=${chain}&type=${mode}${suffix}`, { cache: 'no-store' });
}
