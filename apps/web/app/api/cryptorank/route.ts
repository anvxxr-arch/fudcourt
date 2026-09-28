import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  CR_BASE,
  CR_DISABLED,
  CR_DISABLED_REASON,
  CR_DEFAULT_EXCHANGE,
  CR_DEFAULT_KEYS,
  CR_DEFAULT_LP,
  CR_DEFAULT_ND,
  CR_EXCHANGE_LISTS,
  CR_KEY_RE,
  CR_KEYED_PATHS,
  CR_LP_LISTS,
  CR_ND_LISTS,
  CR_RWA_KEY_RE,
  CR_MODES,
  CR_MODE_ARGS,
  CR_MODE_UPSTREAM,
  type CrAiOverview,
  type CrCategoryInfo,
  type CrConverterRow,
  type CrChainInfo,
  type CrChainRow,
  type CrCoin,
  type CrCoinDetail,
  type CrEcosystemInfo,
  type CrEcosystemRow,
  type CrEnvelope,
  type CrExchangeRow,
  type CrGlobal,
  type CrLaunchpoolRow,
  type CrLiveMode,
  type CrMediaRow,
  type CrMode,
  type CrFundingRound,
  type CrNewsRow,
  type CrNodeSaleRow,
  type CrPredictionAgg,
  type CrPredictionRow,
  type CrQuarterlyYear,
  type CrQuarterQ,
  type CrRwaAsset,
  type CrRwaRow,
  type CrTagInfo,
  type CrTagRow,
  type CrTrendingRow,
  type CrUpcomingIco,
} from '../../../lib/cryptorank';
import { envelope, type HelperOut } from '../../../lib/shapers';

/**
 * CryptoRank read proxy. Mode-only input (never a raw path); the fetch itself
 * happens in scripts/cr_fetch.py under a dedicated curl_cffi venv, because
 * cryptorank.io's API host challenges every non-browser TLS client while its
 * market pages serve their SSR payload through curl_cffi (see lib header).
 *
 * Failure policy (house rule): upstream wall -> 502 with the real upstream
 * status and the helper's own error string. Nothing is ever substituted.
 *
 * Data-integrity policy: modes listed in CR_DISABLED are REFUSED with 503 +
 * the measured reason -- upstream's /_next/data class serves synthetic decoy
 * (nonexistent slugs -> 200 fabricated payloads, prices off ground truth by
 * 30%, measured 2026-09-27). We never forward a payload we cannot trust.
 */

export const dynamic = 'force-dynamic';

const PYTHON = process.env.CR_PYTHON ?? '/home/dwizzy/.venvs/crfetch/bin/python';
const HELPER = path.join(process.cwd(), 'scripts', 'cr_fetch.py');


function runHelperOnce(flag: '--path' | '--data-route', value: string, fresh = false): Promise<HelperOut> {
  return new Promise((resolve) => {
    const args = fresh ? [HELPER, flag, value, '--ttl', '0'] : [HELPER, flag, value];
    execFile(/*turbopackIgnore: true*/
      PYTHON,
      args,
      { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(stdout) as HelperOut;
          resolve(parsed);
        } catch {
          resolve({
            ok: false,
            error: `helper produced no JSON: ${err ? String(err.message) : ''} ${String(stderr).slice(-300)}`.trim(),
          });
        }
      },
    );
  });
}

/**
 * Transient-wall aware wrapper: a page mount fires every mode at once, which
 * can trip cryptorank's CF burst limiter (upstream 429). Back off and retry
 * the SAME fetch — responses may only fail on real data, never on a hiccup.
 * Measured 2026-09-27: cold-cache mount -> 429 on 3-5 of ~20 modes.
 */
async function runHelper(flag: '--path' | '--data-route', value: string, fresh = false): Promise<HelperOut> {
  let last: HelperOut = { ok: false, error: 'runHelper: no attempt' };
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await runHelperOnce(flag, value, fresh);
    if (last.ok || last.status !== 429) return last;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  return last;
}

/* -------------------------------- handler ------------------------------- */

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') as CrMode | null;
  if (!mode || !CR_MODES.includes(mode)) {
    return NextResponse.json(
      { error: 'unknown mode', modes: CR_MODES, got: mode },
      { status: 400 },
    );
  }

  const fresh = req.nextUrl.searchParams.get('fresh') === '1';

  // Data-integrity refusal: these modes' upstream class serves synthetic
  // decoy (see CR_DISABLED_REASON). Loud 503, never a forwarded payload.
  if (mode === 'funding' || mode === 'unlocks') {
    return NextResponse.json(
      {
        error: CR_DISABLED_REASON,
        kind: mode,
        disabled: true,
        upstream: CR_MODE_UPSTREAM[mode],
        reverify: 'scripts/verify-cryptorank.py (nonexistent-slug must 404 + independent ground-truth match)',
      },
      { status: 503 },
    );
  }

  // Keyed live modes (categories/coin): ?key=<slug> -- validated, NEVER
  // clamped (bad format = 400; an honest upstream miss forwards its real 404
  // instead of fabricating a row).
  let flag: '--path' | '--data-route' = CR_MODE_ARGS[mode][0];
  let value: string = CR_MODE_ARGS[mode][1];
  let key: string | undefined;
  let upstream = CR_MODE_UPSTREAM[mode];
  if (mode in CR_KEYED_PATHS) {
    const keyed = mode as keyof typeof CR_KEYED_PATHS;
    const raw = req.nextUrl.searchParams.get('key');
    key = raw === null || raw === '' ? CR_DEFAULT_KEYS[keyed] : raw;
    const keyRe = keyed === 'rwaasset' ? CR_RWA_KEY_RE : CR_KEY_RE;
    if (!keyRe.test(key)) {
      return NextResponse.json(
        {
          error: 'invalid key',
          detail: keyed === 'rwaasset'
            ? `key must be <plural-type>/<slug>, plural-type in bonds|commodities|etfs|stocks (never clamped)`
            : `key must match ${CR_KEY_RE} (lowercase alnum + dashes, 1-64)`,
          mode,
          key,
        },
        { status: 400 },
      );
    }
    value = CR_KEYED_PATHS[keyed](key);
    upstream = `${CR_BASE}${value}`;
  } else if (mode === 'exchanges') {
    const raw = req.nextUrl.searchParams.get('key');
    key = raw === null || raw === '' ? CR_DEFAULT_EXCHANGE : raw;
    if (!(CR_EXCHANGE_LISTS as readonly string[]).includes(key)) {
      return NextResponse.json(
        {
          error: 'invalid exchange list',
          detail: 'key must be one of the whitelisted venue lists (never clamped)',
          allowed: CR_EXCHANGE_LISTS,
          mode,
          key,
        },
        { status: 400 },
      );
    }
    value = `/exchanges/${key}`;
    upstream = `${CR_BASE}${value}`;
  } else if (mode === 'launchpool') {
    const raw = req.nextUrl.searchParams.get('key');
    key = raw === null || raw === '' ? CR_DEFAULT_LP : raw;
    if (!(CR_LP_LISTS as readonly string[]).includes(key)) {
      return NextResponse.json(
        {
          error: 'invalid launchpool list',
          detail: 'key must be one of the whitelisted event lists (never clamped)',
          allowed: CR_LP_LISTS,
          mode,
          key,
        },
        { status: 400 },
      );
    }
    value =
      key === 'upcoming'
        ? '/upcoming-launchpool'
        : key === 'active'
          ? '/active-launchpool'
          : '/past-launchpool';
    upstream = `${CR_BASE}${value}`;
  } else if (mode === 'nodesale') {
    const raw = req.nextUrl.searchParams.get('key');
    key = raw === null || raw === '' ? CR_DEFAULT_ND : raw;
    if (!(CR_ND_LISTS as readonly string[]).includes(key)) {
      return NextResponse.json(
        {
          error: 'invalid nodesale list',
          detail: 'key must be one of the whitelisted node sale lists (never clamped)',
          allowed: CR_ND_LISTS,
          mode,
          key,
        },
        { status: 400 },
      );
    }
    value =
      key === 'upcoming'
        ? '/upcoming-nodesale'
        : key === 'active'
          ? '/active-nodesale'
          : '/past-nodesale';
    upstream = `${CR_BASE}${value}`;
  }

  const h = await runHelper(flag, value, fresh);
  if (!h.ok) {
    if (h.status === 404) {
      // Honest upstream miss (e.g. /price/zzznoexist) -> real 404.
      return NextResponse.json(
        {
          error: 'upstream 404: no such resource',
          mode,
          key: key ?? null,
          upstreamStatus: 404,
        },
        { status: 404 },
      );
    }
    // Real failure, real detail: upstream wall status or helper crash text.
    return NextResponse.json(
      {
        error: h.error ?? 'cryptorank helper failed',
        upstreamStatus: h.status ?? null,
        upstream,
        kind: mode,
      },
      { status: 502 },
    );
  }

  // newstag soft-404 derivation: /news/tag/<unknown> answers HTTP 200 with
  // tag:null (measured) — convert that honest marker into a real 404 so a
  // slug we don't know never ships the unfiltered feed under a tag label.
  if (mode === 'newstag') {
    const tg = (h.pageProps as Record<string, unknown> | undefined)?.tag;
    if (!tg) {
      return NextResponse.json(
        {
          error: "upstream ships tag:null for this slug (soft-404) -> no such tag",
          mode,
          key: key ?? null,
          upstreamStatus: 200,
        },
        { status: 404 },
      );
    }
  }

  const body = envelope(mode, h, { key, upstream });
  return NextResponse.json(body, {
    headers: {
      'X-CR-Upstream': body.upstream,
      'X-CR-Cache': body.cache,
      'Cache-Control': 'public, max-age=30',
    },
  });
}
