import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './index';
import { t } from './translate';
import type { DictKey } from './en';

/** The request locale for server components (the layout and route shells). */
export async function requestLocale(): Promise<Locale> {
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

/** t() bound to the request locale, for server components. */
export async function tServer(key: DictKey, vars?: Record<string, string | number>): Promise<string> {
  return t(await requestLocale(), key, vars);
}
