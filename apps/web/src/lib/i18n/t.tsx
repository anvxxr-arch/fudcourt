'use client';

/**
 * The client side of the locale layer: LocaleContext, its provider, and the
 * `useT()` hook that binds `t()` to the ambient locale so a locale switch
 * re-renders every translated surface.
 *
 * The PURE translation core lives in `./translate` (no JSX, no context, no
 * `'use client'`) so server components can call `t(locale, key)` directly — a
 * function exported from a `'use client'` module cannot be invoked from the
 * server graph (Next renders it as a client reference instead; calling it from
 * not-found/loading 500s at runtime, not at build). This module re-exports `t`
 * so existing client imports keep one path.
 *
 * The locale is CLIENT-SIDE STATE, owned once by `LocaleProvider`. The root
 * layout is synchronous (it must stay synchronous — an async layout reading
 * `cookies()` marks every child dynamic and 500s any page that still declares
 * ISR, measured 2026-10-13). The server renders `lang="en"` + a provider seeded
 * with the default; on mount the provider reads the `fc-locale` cookie and
 * switches, and the switcher writes the cookie + updates the SAME state. The
 * first paint is always en — the same trade the theme toggle already makes
 * (its inline script mutates the DOM before hydration and React never sees a
 * conflicting render), and the tree stays static/ISR so the public HTML keeps
 * its `s-maxage=300` cacheability.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './index';
import { t, type Vars } from './translate';
import type { DictKey } from './en';

export { t };
export type { Vars };

export const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);
const LocaleSetContext = createContext<(next: Locale) => void>(() => {});

function readCookieLocale(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const m = document.cookie.match(/(?:^|;)\s*fc-locale=([^;]+)/);
  return m && isLocale(m[1]) ? (m[1] as Locale) : DEFAULT_LOCALE;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => setLocale(readCookieLocale()), []);
  return (
    <LocaleContext.Provider value={locale}>
      <LocaleSetContext.Provider value={setLocale}>{children}</LocaleSetContext.Provider>
    </LocaleContext.Provider>
  );
}

/** Client hook: a t() bound to the ambient locale. */
export function useT(): (key: DictKey, vars?: Vars) => string {
  const locale = useContext(LocaleContext);
  return (key: DictKey, vars?: Vars) => t(locale, key, vars);
}

/** Client hook: the current locale and a setter that also persists the cookie. */
export function useLocale(): [Locale, (next: Locale) => void] {
  const locale = useContext(LocaleContext);
  const set = useContext(LocaleSetContext);
  const wrap = (next: Locale) => {
    if (!isLocale(next)) return;
    if (typeof document !== 'undefined') {
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    }
    set(next);
  };
  return [locale, wrap];
}