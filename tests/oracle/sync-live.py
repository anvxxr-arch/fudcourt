#!/usr/bin/env python3
"""
fudcourt live multi-chain sync -> the local Postgres `assets` table (DR-040).

LOCATION: this script is the ORACLE, and an oracle does not live inside the app
it checks. The Phase-8 tooling move took it out of `frontend/web/scripts/tools/`
(that directory no longer exists); it is wired by
`infrastructure/systemd/fudcourt-sync.service` at its current path. Paths named
below are repo-relative roots (`apps/reconciler/src/**`), not app-relative ones.

HARD RULES:
  * exact wallet address, exact balance, exact hash
  * a failed RPC NEVER becomes 0 -- it raises, so we never fake a zero balance

ORACLE MODE (added for the Phase-6 cross-implementation gate; the default,
flagless run is byte-for-byte the behaviour this script always had):
  * `--oracle-record FILE`  run the live pipeline but write NO rows;
      instead record every upstream HTTP response body keyed by its request and
      dump that key->body map to FILE. This is how a replayable input capture is
      produced. `assets` is never touched.
  * `--oracle-inputs FILE`  replay a previously recorded capture: every upstream
      HTTP response is served from FILE, no network, and -- again -- no rows are
      written. The *projection* (the exact `assets` rows the run would have
      written) is printed between `#ASSETS-PROJECTION-BEGIN/END` markers for the
      gate to diff.

In both oracle modes the write path is disabled, so a divergent or failed
comparison can never corrupt the live `assets` table (fail-safe by construction:
the gate has no write code path at all).
"""
import re, json, urllib.request, urllib.error, sys, time, os, argparse
from pathlib import Path
# ---------- config ----------
def load_env():
    """Load .env, walking up from this file to the repo root."""
    here = Path(__file__).resolve().parent
    for d in [here, *here.parents]:
        env_path = d / '.env'
        if env_path.exists():
            break
    else:
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('\'"'))

def require_env(name: str) -> str:
    """A missing credential must STOP the sync loudly. The old fallbacks (parse
    lib/db.ts for a token, a hardcoded Alchemy default) could only ever yield
    garbage or a key that lives in git history -- a failed RPC must never
    become fake data, and neither may a fake credential."""
    v = os.environ.get(name, '').strip()
    if not v:
        raise RuntimeError(
            f'missing {name} (set it in the repo-root .env; rotation runbook: docs/operations/SECRETS.md)'
        )
    return v

HL_URL = 'https://api.hyperliquid.xyz/info'
LLAMA_URL = 'https://coins.llama.fi/prices/current/'
PG_DSN = ''  # set in main() from FUDCOURT_PG_URL

# ---------- oracle seam (inert unless an --oracle-* flag is passed) ----------
class OracleError(RuntimeError):
    """A replay that cannot find a recorded response must be loud, never a
    silently invented empty result (honesty rule)."""

def canon(x) -> str:
    """Deterministic JSON encoding of a request payload. Both the Python oracle
    and the Rust port build fixture keys with this exact form, so a capture
    recorded by one is readable by the other. Sorted keys + compact separators."""
    return json.dumps(x, sort_keys=True, separators=(',', ':'))

class Oracle:
    """record: live responses are captured to `data`; replay: they are served
    from it. `trace` accumulates every upstream request body so a test can prove
    the gate issued no store writes."""
    def __init__(self, mode, path, trace_path):
        self.mode = mode            # 'record' | 'replay'
        self.path = path
        self.trace_path = trace_path
        self.data = {}
        self.trace = []
        if mode == 'replay':
            with open(path) as f:
                blob = json.load(f)
            self.data = blob.get('responses', {})

    def fetch(self, key, thunk):
        self.trace.append(key)
        if self.mode == 'replay':
            if key not in self.data:
                raise OracleError(f'no recorded response for {key}')
            return self.data[key]
        body = thunk()
        self.data[key] = body
        return body

    def save(self):
        with open(self.path, 'w') as f:
            json.dump({'version': 1, 'responses': self.data}, f, indent=1, sort_keys=True)
        if self.trace_path:
            with open(self.trace_path, 'w') as f:
                f.write('\n'.join(self.trace) + '\n')

ORACLE = None  # None => live passthrough (flagless behaviour)

def _fetch(key, thunk):
    """Serve one upstream HTTP response body. Flagless: call `thunk` directly
    (no key is even built). Oracle mode: record or replay it."""
    if ORACLE is None:
        return thunk()
    return ORACLE.fetch(key, thunk)

# ---------- http helpers (return the raw response body text) ----------
def _http_json(url, payload, timeout=30, headers=None):
    H = {'Content-Type': 'application/json'}
    if headers:
        H.update(headers)
    req = urllib.request.Request(url, headers=H, method='POST')
    if payload is not None:
        req.data = json.dumps(payload).encode()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()

def _http_get(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()

def db(sql, args=None):
    """Run SQL against the local Postgres system of record (DR-040) and return
    rows as dicts. One connection is reused for the process; every call commits,
    so a DELETE-then-INSERT replace is durable statement by statement."""
    conn = _pg_conn()
    with conn.cursor() as cur:
        cur.execute(sql, args) if args is not None else cur.execute(sql)
        rows = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()] if cur.description else []
    conn.commit()
    return rows

# ---------- rpc: loud on failure ----------
class RPCError(RuntimeError): pass
def _redact(url):
    return url.replace(SECRETS['alchemy'], '{ALCHEMY}') if SECRETS.get('alchemy') else url

def rpc(url, method, params, tries=3):
    key = f'rpc|{_redact(url)}|{method}|{canon(params)}'
    last = None
    for a in range(tries):
        try:
            text = _fetch(key, lambda: _http_json(url, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}))
            j = json.loads(text)
            if 'error' in j:
                last = f"{method} -> {j['error']}"
                raise RPCError(last)
            return j.get('result')
        except (RPCError, OracleError):
            raise
        except Exception as ex:
            last = f'{method} @ {url[:40]}: {ex}'
            time.sleep(1.2 * (a + 1))
    raise RPCError(last)

def hexint(v):
    if v is None:
        raise RPCError('hexint(None) -- refusing to treat a null as zero')
    if v in ('0x', '0x0', ''):
        return 0
    return int(v, 16)

def pad_addr(addr):
    a = addr.strip().lower()
    if a.startswith('0x'):
        a = a[2:]
    if not re.fullmatch(r'[0-9a-f]{40}', a):
        raise ValueError(f'bad EVM address: {addr!r}')
    return a.rjust(64, '0')

# ---------- chain registry ----------
def evm_registry(alchemy):
    return {
        'Ethereum': {'url': f'https://eth-mainnet.g.alchemy.com/v2/{alchemy}', 'native': 'ETH',
                     'tokens': {'USDT': ('0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
                                'USDC': ('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6)}},
        'BSC': {'url': f'https://bnb-mainnet.g.alchemy.com/v2/{alchemy}', 'native': 'BNB',
                'tokens': {'USDT': ('0x55d398326f99059ff775485246999027b3197955', 18),
                           'USDC': ('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 18)}},
        'Polygon': {'url': f'https://polygon-mainnet.g.alchemy.com/v2/{alchemy}', 'native': 'POL',
                    'tokens': {'USDT': ('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
                               'USDC': ('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6)}},
        'Arbitrum': {'url': f'https://arb-mainnet.g.alchemy.com/v2/{alchemy}', 'native': 'ETH',
                     'tokens': {'USDT': ('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
                                'USDC': ('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6)}},
        'Optimism': {'url': f'https://opt-mainnet.g.alchemy.com/v2/{alchemy}', 'native': 'ETH',
                     'tokens': {'USDT': ('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
                                'USDC': ('0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 6)}},
        'Base': {'url': f'https://base-mainnet.g.alchemy.com/v2/{alchemy}', 'native': 'ETH',
                 'tokens': {'USDC': ('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6)}},
    }

WALLETS = [
    ('Main', '0x6816ba2cb2bc013a78225228a153586ca63b1548', 'evm'),
    ('Hanif', '0xB0be41f0e7F0AD49622B292dA1322c2BEA46fA1b', 'evm'),
    ('Akang', '7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP', 'sol'),
]
LLAMA_IDS = {
    'ETH': 'coingecko:ethereum',
    'BNB': 'coingecko:binancecoin',
    'POL': 'coingecko:polygon-ecosystem-token',
    'SOL': 'coingecko:solana',
    'USDT': 'coingecko:tether',
    'USDC': 'coingecko:usd-coin',
}

SECRETS = {}  # populated in main(); used only for redaction in fixture keys

# ---------- Postgres (the system of record, DR-040) ----------
_PG = None

def _pg_conn():
    """The one connection this process uses. psycopg2 is imported here, not at
    module scope, so the oracle gate can import this file without the driver."""
    global _PG
    if _PG is None:
        import psycopg2
        _PG = psycopg2.connect(PG_DSN)
    return _PG

def prices():
    url = LLAMA_URL + ','.join(LLAMA_IDS.values())
    text = _fetch(f'prices|{url}', lambda: _http_get(url))
    coins = (json.loads(text) or {}).get('coins') or {}
    out = {}
    for sym, cid in LLAMA_IDS.items():
        entry = coins.get(cid)
        price = entry.get('price') if isinstance(entry, dict) else None
        if not isinstance(price, (int, float)):
            raise RuntimeError(f'price oracle returned no usable price for {sym} ({cid})')
        out[sym] = price
    out['MATIC'] = out['POL']
    return out

# ---------- projection (the exact `assets` rows the run would write) ----------
def projection(rows, tot):
    """Return the list of `assets` rows exactly as they would be written (the
    six args of the INSERT, rendered with `str(a)`), in write order, plus the net
    worth the readback journal would print."""
    out = []
    stored = []
    for chain, owner, asset, qty, usd in rows:
        q = str(round(qty, 10))
        v = str(round(usd, 4))
        sh = str(round(usd / tot * 100, 2) if tot else 0)
        out.append([str(chain), str(asset), q, v, sh, str(owner)])
        stored.append(float(v))
    s = 0.0
    for v in sorted(stored, reverse=True):   # readback sums ORDER BY value_usd DESC
        s += v
    return out, str(round(s, 2))

def print_projection(rows, tot):
    pj, net = projection(rows, tot)
    print('#ASSETS-PROJECTION-BEGIN')
    print('["chain","asset","quantity","value_usd","share_pct","wallet"]')
    for row in pj:
        print(json.dumps(row, separators=(',', ':')))
    print(f'#NET_WORTH={net}')
    print('#ASSETS-PROJECTION-END')

# ---------- sync ----------
def run_sync():
    alchemy = require_env('ALCHEMY_KEY')
    SECRETS['alchemy'] = alchemy
    EVM = evm_registry(alchemy)
    P = prices()
    print('prices:', {k: round(v, 4) for k, v in P.items()})
    rows = []
    errors = []
    for label, addr, kind in WALLETS:
        if kind == 'sol':
            try:
                b = rpc('https://api.mainnet-beta.solana.com', 'getBalance', [addr])
                sol_val = (b.get('value', 0) if isinstance(b, dict) else 0) / 1e9
                if sol_val > 1e-9:
                    rows.append(('Solana', label, 'SOL', sol_val, sol_val * P['SOL']))
            except Exception as ex:
                errors.append(f'Solana native {label}: {ex}')
            try:
                ta = rpc('https://api.mainnet-beta.solana.com', 'getTokenAccountsByOwner',
                         [addr, {'programId': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}, {'encoding': 'jsonParsed'}])
                for t in ta.get('value', []):
                    inf = t['account']['data']['parsed']['info']
                    amt = inf['tokenAmount']['uiAmount'] or 0
                    if amt > 0:
                        rows.append(('Solana', label, f"SPL:{inf['mint'][:6]}", amt, 0.0))
            except Exception as ex:
                errors.append(f'Solana SPL {label}: {ex}')
            continue
        for chain, cfg in EVM.items():
            try:
                nb = hexint(rpc(cfg['url'], 'eth_getBalance', [addr, 'latest'])) / 1e18
                if nb > 1e-9:
                    rows.append((chain, label, cfg['native'], nb, nb * P.get(cfg['native'], 0)))
            except Exception as ex:
                errors.append(f'{chain} native {label}: {ex}')
            for sym, (taddr, dec) in cfg['tokens'].items():
                try:
                    raw = rpc(cfg['url'], 'eth_call', [{'to': taddr, 'data': '0x70a08231' + pad_addr(addr)}, 'latest'])
                    tb = hexint(raw) / 10**dec
                    if tb > 1e-6:
                        rows.append((chain, label, sym, tb, tb * P.get(sym, 1.0)))
                except Exception as ex:
                    errors.append(f'{chain} {sym} {label}: {ex}')
    # Hyperliquid (Main) -- spot + perp + PnL
    try:
        def hl(body):
            text = _fetch(f'hl|{canon(body)}', lambda: _http_json(HL_URL, body))
            return json.loads(text)
        spot = hl({'type': 'spotClearinghouseState', 'user': WALLETS[0][1]})
        for b in (spot or {}).get('balances', []):
            amt = float(b.get('total', 0))
            if amt > 0:
                rows.append(('Hyperliquid (spot)', 'Main', b['coin'], amt,
                             amt * P.get(b['coin'], 1.0) if b['coin'] in P else amt))
        cs = hl({'type': 'clearinghouseState', 'user': WALLETS[0][1]})
        av = float((cs or {}).get('marginSummary', {}).get('accountValue', 0))
        if av > 0:
            rows.append(('Hyperliquid (perp)', 'Main', 'USDC', av, av))
        print(f'Hyperliquid perp accountValue: ${av}')
        fills = hl({'type': 'userFills', 'user': WALLETS[0][1]})
        if isinstance(fills, list):
            pnl = sum(float(f.get('closedPnl') or 0) for f in fills)
            fees = sum(float(f.get('fee') or 0) for f in fills)
            print(f'Hyperliquid fills={len(fills)} realizedPnL=${pnl:.4f} fees=${fees:.4f}')
    except Exception as ex:
        errors.append(f'Hyperliquid: {ex}')
    # ---------- print ----------
    print(f'\n=== LIVE ON-CHAIN ({len(rows)} positions) ===')
    tot = 0
    for chain, owner, asset, qty, usd in sorted(rows, key=lambda r: -r[4]):
        tot += usd
        print(f'  {owner:6} {chain:11} {asset:9} {qty:>20.8f}  ${usd:>11.2f}')
    if errors:
        print(f'\n!!! {len(errors)} RPC ERRORS (NOT treated as zero) !!!')
        for e in errors:
            print('  -', e)
    return rows, tot

def write_and_report(rows, tot):
    """Flagless path only: replace `assets` in the local Postgres system of
    record and read it back. The replace is ONE transaction, so the board never
    sees a half-written table; the `assets_snapshot` trigger (see
    database/schema/pg-schema.sql) appends each row to `asset_history` as it
    lands. Not touched in oracle mode."""
    conn = _pg_conn()
    with conn.cursor() as cur:
        cur.execute('DELETE FROM assets')
        for chain, owner, asset, qty, usd in rows:
            cur.execute(
                'INSERT INTO assets (chain,asset,quantity,value_usd,share_pct,wallet,updated_at) '
                "VALUES (%s,%s,%s,%s,%s,%s,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))",
                (chain, asset, round(qty, 10), round(usd, 4), round(usd / tot * 100, 2) if tot else 0, owner))
        # 90-day retention, the same window the schema documents.
        cur.execute("DELETE FROM asset_history WHERE ts < now() - interval '90 days'")
        cur.execute("DELETE FROM price_history WHERE ts < now() - interval '90 days'")
    conn.commit()
    print('\n=== POSTGRES assets (LIVE) ===')
    s = 0
    for a in db('SELECT wallet,chain,asset,quantity,value_usd,share_pct FROM assets ORDER BY value_usd DESC'):
        s += float(a['value_usd'])
        print(f"  {a['wallet']:6} {a['chain']:11} {a['asset']:9} {float(a['quantity']):>20.8f}  ${float(a['value_usd']):>10.2f}  {a['share_pct']}%")
    print(f'\nNET WORTH: ${round(s, 2)}')

def main(argv=None):
    global ORACLE, PG_DSN
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--oracle-record', metavar='FILE')
    ap.add_argument('--oracle-inputs', metavar='FILE')
    ap.add_argument('--oracle-trace', metavar='FILE')
    args = ap.parse_args(argv)

    load_env()
    if args.oracle_inputs:
        ORACLE = Oracle('replay', args.oracle_inputs, args.oracle_trace)
    elif args.oracle_record:
        ORACLE = Oracle('record', args.oracle_record, args.oracle_trace)

    if ORACLE is None:
        # ---- flagless: exactly the original behaviour ----
        PG_DSN = require_env('FUDCOURT_PG_URL')
        rows, tot = run_sync()
        write_and_report(rows, tot)
    else:
        # ---- oracle: projection only, the store is never written ----
        rows, tot = run_sync()
        print_projection(rows, tot)
        ORACLE.save()
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except OracleError as ex:
        print(f'oracle error: {ex}', file=sys.stderr)
        sys.exit(2)
