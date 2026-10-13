import { DEFAULT_LOCALE, type Locale } from './index';
import { en, type DictKey } from './en';
import { id as idDict } from './id';
import { zh as zhDict } from './zh';

/**
 * The PURE translation core — no JSX, no context, no `'use client'`. Both the
 * server components (`tServer` in ./server, route shells) and the client hook
 * (`useT` in ./t) call this one function, so a rendered string has exactly one
 * fallback rule wherever it is produced.
 */

/** The dictionaries, keyed by locale. en is the fallback for every locale. */
const DICTS: Record<Locale, Partial<Record<DictKey, string>>> = { en, id: idDict, zh: zhDict };

const warned = new Set<string>();

export type Vars = Record<string, string | number>;

function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );
}

/** Translate one key. Falls back to en, then to the raw key (never empty). */
export function t(locale: Locale, key: DictKey, vars?: Vars): string {
  const dict = DICTS[locale];
  const v = dict[key];
  if (v !== undefined) return interpolate(v, vars);
  if (locale !== DEFAULT_LOCALE && process.env.NODE_ENV !== 'production' && !warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] key "${key}" missing in locale "${locale}" — serving en`);
  }
  return interpolate(en[key], vars);
}
