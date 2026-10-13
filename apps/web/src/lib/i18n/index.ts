/**
 * src/i18n — the FUDCOURT locale layer (en / id / zh).
 *
 * DESIGN, STATED ONCE:
 * - Cookie-persisted locale (`fc-locale`), NOT a `[lang]` route segment. This is
 *   a dashboard, not a marketing site: no SEO surface needs per-locale URLs, and
 *   a route segment would double every link in the app for no crawl benefit.
 * - `en` is the completeness anchor. The other locales may lag; a missing key
 *   falls back to `en` and, in dev, logs once so the gap is visible.
 * - Keys are flat, dot-namespaced by surface (`nav.market`, `common.refresh`),
 *   so a grep for a key finds exactly one definition and one family of uses.
 * - Translation happens at RENDER time via `t()`; there is no runtime loading,
 *   no async provider, no hydration mismatch surface: the dictionary is a
 *   module constant and the locale is read from the cookie on the server and
 *   from the same cookie on the client (no divergence).
 */
export const LOCALES = ['en', 'id', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'fc-locale';

export function isLocale(v: string | undefined | null): v is Locale {
  return !!v && (LOCALES as readonly string[]).includes(v);
}
