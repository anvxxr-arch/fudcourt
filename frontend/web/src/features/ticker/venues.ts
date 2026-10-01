/**
 * CCXT venue loader.
 *
 * CCXT publishes a single `exports` map exposing only the package root. That
 * root barrel eagerly imports every one of its ~100 exchange classes, two of
 * which (dYdX v4) pull in `protobufjs` files Next's bundler cannot resolve —
 * so importing the barrel breaks the production build outright.
 *
 * Loading only the venues we actually read, from ccxt's own per-exchange
 * modules, avoids that. Two upstream packaging constraints stack up here:
 *
 *   1. The export map blocks a subpath for both `import` and `require`, so the
 *      package is located on disk and venue files are addressed by path.
 *   2. The bundler will not leave a literal `require()` of a computed path
 *      alone — it tries to resolve it at build time and fails — so the load
 *      goes through createRequire, which the bundler treats as a runtime call.
 *
 * The trade-off is worth stating: adding a venue means adding it to
 * TICKER_EXCHANGES and confirming the matching module exists, so a typo
 * surfaces as a failed venue on the board rather than a row that silently
 * never fills in.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Exchange as CcxtExchange } from 'ccxt';
import { TICKER_EXCHANGES, type TickerExchange } from '@/features/ticker/client';

/**
 * Locate ccxt by walking up until its `node_modules` entry appears.
 *
 * The anchor is `process.cwd()` rather than `__dirname` on purpose: this is a
 * bundled server module, and the bundler replaces `__dirname` with a build-time
 * placeholder ("/ROOT/lib") that does not exist on disk, so a directory-based
 * search silently finds nothing. The server is started from the app root, so
 * walking up from there finds the real package. If it is ever missing, venues
 * report as failed and the board says so rather than going quiet.
 */
function findCcxtRoot(start: string): string | null {
  let dir = start;
  for (let hop = 0; hop < 10; hop++) {
    const candidate = join(dir, 'node_modules', 'ccxt');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const ccxtRoot = findCcxtRoot(process.cwd());

// `require` does not exist in ES module scope, so it cannot be referenced
// directly. createRequire only needs a real path to anchor resolution; the
// bundle's own location is useless for that (see above), so the app root is
// used, and an unresolved ccxt simply yields no venues.
const loadModule = createRequire(join(ccxtRoot ?? process.cwd(), 'noop.cjs'));

type VenueConstructor = new (config?: object) => CcxtExchange;

/** The per-exchange module is ESM, so it arrives as `{ __esModule, default }`. */
function loadVenue(id: TickerExchange): VenueConstructor | null {
  if (!ccxtRoot) return null;
  try {
    const mod = loadModule(join(ccxtRoot, 'js', 'src', `${id}.js`)) as
      | VenueConstructor
      | { default: VenueConstructor };
    const Ctor = 'default' in mod ? mod.default : mod;
    return typeof Ctor === 'function' ? Ctor : null;
  } catch {
    return null;
  }
}

let clients: Map<TickerExchange, CcxtExchange> | null = null;

/**
 * One client per venue for the process lifetime. CCXT clients are stateless
 * between calls and `enableRateLimit` is per-client, so sharing one is what
 * keeps the venue's published rate limits respected.
 */
export function tickerClients(): Map<TickerExchange, CcxtExchange> {
  if (clients) return clients;
  clients = new Map();
  for (const id of TICKER_EXCHANGES) {
    const Ctor = loadVenue(id);
    // A venue that cannot be constructed is absent from the map, so the sweep
    // reports it in each row's `failed` rather than pretending the pair has
    // only one source.
    if (Ctor) clients.set(id, new Ctor({ enableRateLimit: true, timeout: 12_000 }));
  }
  return clients;
}
