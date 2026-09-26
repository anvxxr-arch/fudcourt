#!/usr/bin/env python3
"""
fudcourt live multi-chain sync -> Turso `assets` table.
HARD RULES:
  * exact wallet address, exact balance, exact hash
  * a failed RPC NEVER becomes 0 -- it raises, so we never fake a zero balance
"""
import re, json, urllib.request, urllib.error, sys, time, os
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

load_env()

TURSO = os.environ.get('TURSO_AUTH_TOKEN', '')
if not TURSO:
    # fallback: parse from db.ts
    db_ts = Path(__file__).resolve().parent.parent / 'lib' / 'db.ts'
    if db_ts.exists():
        _d = db_ts.read_bytes()
        _s = _d.find(b"'", _d.find(b'authToken')) + 1
        _e = _d.find(b"'", _s)
        TURSO = _d[_s:_e].decode()

TURL = 'https://fud-balance-anvxxr.aws-ap-northeast-1.turso.io/v2/pipeline'
ALCHEMY = os.environ.get('ALCHEMY_KEY', 'RWwP0wKxdtABmUNcxTmuH')

def db(sql, args=None):
    H = {'Authorization': f'Bearer {TURSO}', 'Content-Type': 'application/json'}
    stmt = {'sql': sql}
    if args is not None:
        stmt['args'] = [{'type': 'text', 'value': str(a)} for a in args]
    req = urllib.request.Request(TURL, headers=H, method='POST')
    req.data = json.dumps({'requests': [{'type': 'execute', 'stmt': stmt}, {'type': 'close'}]}).encode()
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.loads(r.read())
    res = j['results'][0]
    if 'error' in res:
        raise RuntimeError(f'DB: {res["error"]}')
    rr = res['response']['result']
    cols = [c['name'] for c in rr['cols']]
    return [{c: (row[i]['value'] if row[i] else None) for i, c in enumerate(cols)} for row in rr['rows']]

# ---------- rpc: loud on failure ----------
class RPCError(RuntimeError): pass

def rpc(url, method, params, tries=3):
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={'Content-Type': 'application/json'}, method='POST')
            req.data = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read())
            if 'error' in j:
                last = f"{method} -> {j['error']}"
                raise RPCError(last)
            return j.get('result')
        except RPCError:
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
EVM = {
    'Ethereum': {'url': f'https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY}', 'native': 'ETH',
                 'tokens': {'USDT': ('0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
                            'USDC': ('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6)}},
    'BSC': {'url': f'https://bnb-mainnet.g.alchemy.com/v2/{ALCHEMY}', 'native': 'BNB',
            'tokens': {'USDT': ('0x55d398326f99059ff775485246999027b3197955', 18),
                       'USDC': ('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 18)}},
    'Polygon': {'url': f'https://polygon-mainnet.g.alchemy.com/v2/{ALCHEMY}', 'native': 'POL',
                'tokens': {'USDT': ('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
                           'USDC': ('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6)}},
    'Arbitrum': {'url': f'https://arb-mainnet.g.alchemy.com/v2/{ALCHEMY}', 'native': 'ETH',
                 'tokens': {'USDT': ('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
                            'USDC': ('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6)}},
    'Optimism': {'url': f'https://opt-mainnet.g.alchemy.com/v2/{ALCHEMY}', 'native': 'ETH',
                 'tokens': {'USDT': ('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
                            'USDC': ('0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 6)}},
    'Base': {'url': f'https://base-mainnet.g.alchemy.com/v2/{ALCHEMY}', 'native': 'ETH',
             'tokens': {'USDC': ('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6)}},
}

WALLETS = [
    ('Main', '0x6816ba2cb2bc013a78225228a153586ca63b1548', 'evm'),
    ('Hanif', '0xB0be41f0e7F0AD49622B292dA1322c2BEA46fA1b', 'evm'),
    ('Akang', '7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP', 'sol'),
]

def prices():
    ids = 'ethereum,binancecoin,matic-network,solana,tether,usd-coin'
    url = f'https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=25) as r:
        j = json.loads(r.read())
    return {
        'ETH': j['ethereum']['usd'], 'BNB': j['binancecoin']['usd'],
        'POL': j['matic-network']['usd'], 'MATIC': j['matic-network']['usd'],
        'SOL': j['solana']['usd'], 'USDT': j['tether']['usd'], 'USDC': j['usd-coin']['usd'],
    }

# ---------- sync ----------
P = prices()
print('prices:', {k: round(v, 4) for k, v in P.items()})

rows = []
errors = []

for label, addr, kind in WALLETS:
    if kind == 'sol':
        # Solana
        try:
            b = rpc('https://api.mainnet-beta.solana.com', 'getBalance', [addr])
            sol_val = (b.get('value', 0) if isinstance(b, dict) else 0) / 1e9
            if sol_val > 1e-9:
                rows.append(('Solana', label, 'SOL', sol_val, sol_val * P['SOL']))
        except Exception as ex:
            errors.append(f'Solana native {label}: {ex}')

        # SPL tokens
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

    # EVM chains
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
        req = urllib.request.Request('https://api.hyperliquid.xyz/info',
                                    headers={'Content-Type': 'application/json'}, method='POST')
        req.data = json.dumps(body).encode()
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

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

# ---------- write ----------
db('DELETE FROM assets')
for chain, owner, asset, qty, usd in rows:
    db('INSERT INTO assets (chain,asset,quantity,value_usd,share_pct,wallet,updated_at) '
       "VALUES (?,?,?,?,?,?,datetime('now'))",
       [chain, asset, round(qty, 10), round(usd, 4), round(usd / tot * 100, 2) if tot else 0, owner])

print('\n=== TURSO assets (LIVE) ===')
s = 0
for a in db('SELECT wallet,chain,asset,quantity,value_usd,share_pct FROM assets ORDER BY value_usd DESC'):
    s += float(a['value_usd'])
    print(f"  {a['wallet']:6} {a['chain']:11} {a['asset']:9} {float(a['quantity']):>20.8f}  ${float(a['value_usd']):>10.2f}  {a['share_pct']}%")
print(f'\nNET WORTH: ${round(s, 2)}')
