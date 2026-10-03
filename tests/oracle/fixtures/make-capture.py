#!/usr/bin/env python3
"""Generate the replayable sync capture fixture (offline, deterministic).

The gate (`scripts/verify/verify-sync.py`) proves the Rust sync and
the Python oracle produce IDENTICAL `assets` projections from the same inputs.
This script writes those inputs: a recorded `key -> response body` map whose
keys are built exactly the way BOTH implementations build them.

KEY FORMAT (must match byte-for-byte or a replay misses and degrades into a
per-wallet error instead of a row):

    prices|https://coins.llama.fi/prices/current/<ids>
    rpc|<url after redact>|<method>|<canon(params)>
    hl|<canon(body)>

`canon` is `json.dumps(x, sort_keys=True, separators=(',',':'))`. `redact`
replaces the ALCHEMY key with `{ALCHEMY}`; the Rust side cuts the URL at
`/v2/` — the two agree ONLY when the key itself never appears elsewhere in
the URL, which is why `PLACEHOLDER_KEY` below is a full-length hex string (a
short placeholder would substring-mangle the hostname, e.g. "pol<key>gon").

Every request the oracle issues is covered here (both EVM wallets across all
six chains, the Solana pair, the three Hyperliquid calls and the price feed);
a missing key would silently drop that wallet's rows on BOTH sides, so the
gate also pins the expected projection to catch exactly that.

Usage: python3 tests/oracle/fixtures/make-capture.py [--out FILE]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# A real-shaped key: 64 hex chars, not a substring of any URL the sync builds
# (so Python's replace-based redaction and Rust's /v2/-cut agree).
PLACEHOLDER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
ALCHEMY_REDACTED = "{ALCHEMY}"

# --- mirrored verbatim from tests/oracle/sync-live.py --------------------------
WALLETS = [
    ("Main", "0x6816ba2cb2bc013a78225228a153586ca63b1548", "evm"),
    ("Hanif", "0xB0be41f0e7F0AD49622B292dA1322c2BEA46fA1b", "evm"),
    ("Akang", "7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP", "sol"),
]
CHAINS = {
    "Ethereum": ("eth-mainnet.g.alchemy.com", "ETH",
                 {"USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
                  "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"}),
    "BSC": ("bnb-mainnet.g.alchemy.com", "BNB",
            {"USDT": "0x55d398326f99059ff775485246999027b3197955",
             "USDC": "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"}),
    "Polygon": ("polygon-mainnet.g.alchemy.com", "POL",
                {"USDT": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
                 "USDC": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"}),
    "Arbitrum": ("arb-mainnet.g.alchemy.com", "ETH",
                 {"USDT": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
                  "USDC": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"}),
    "Optimism": ("opt-mainnet.g.alchemy.com", "ETH",
                 {"USDT": "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
                  "USDC": "0x7F5c764cBc14f9669B88837ca1490cCa17c31607"}),
    "Base": ("base-mainnet.g.alchemy.com", "ETH",
             {"USDC": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}),
}
LLAMA_IDS = {
    "ETH": "coingecko:ethereum",
    "BNB": "coingecko:binancecoin",
    "POL": "coingecko:polygon-ecosystem-token",
    "SOL": "coingecko:solana",
    "USDT": "coingecko:tether",
    "USDC": "coingecko:usd-coin",
}
SOLANA_RPC = "https://api.mainnet-beta.solana.com"
HL_URL = "https://api.hyperliquid.xyz/info"
SPL_MINT = "Es9vMFrzaCERmJfrF4H2FYsM6CdGmB4HobkBpv7puLwM"


def canon(x) -> str:
    return json.dumps(x, sort_keys=True, separators=(",", ":"))


def redact(url: str) -> str:
    """Python's `_redact`: replace the key token. The placeholder never occurs
    elsewhere in the URL, so this equals the Rust `/v2/` cut."""
    return url.replace(PLACEHOLDER_KEY, ALCHEMY_REDACTED)


def rpc_url(host: str) -> str:
    return redact(f"https://{host}/v2/{PLACEHOLDER_KEY}")


def pad_addr(addr: str) -> str:
    a = addr.strip().lower()
    if a.startswith("0x"):
        a = a[2:]
    return a.rjust(64, "0")


def hex_balance(amount: float) -> str:
    return hex(int(round(amount * 1e18)))


def token_word(amount: float, decimals: int) -> str:
    return "0x" + hex(int(round(amount * 10**decimals)))[2:].rjust(64, "0")


def result(value: str) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": 1, "result": value}, separators=(",", ":"))


def build_responses() -> dict[str, str]:
    r: dict[str, str] = {}

    # ---- DeFiLlama spot prices -------------------------------------------------
    r[f"prices|{LLAMA_URL}"] = json.dumps(
        {"coins": {cid: {"price": price, "symbol": sym, "decimals": dec}
                   for sym, (cid, price, dec) in LLAMA_PRICES.items()}},
        separators=(",", ":"),
    )

    # ---- EVM: every wallet x every chain x (native + each token) ---------------
    for idx, (wallet, addr, kind) in enumerate(WALLETS):
        if kind != "evm":
            continue
        for chain, (host, native, tokens) in CHAINS.items():
            url = rpc_url(host)
            r[f"rpc|{url}|eth_getBalance|{canon([addr, 'latest'])}"] = result(
                hex_balance(NATIVE[(w_idx := idx, chain)]))
            for sym, taddr in tokens.items():
                data = "0x70a08231" + pad_addr(addr)
                r[f"rpc|{url}|eth_call|{canon([{'data': data, 'to': taddr}, 'latest'])}"] = \
                    result(token_word(TOKEN[(w_idx, chain, sym)], TOKEN_DEC[sym]))

    # ---- Solana (Akang) ---------------------------------------------------------
    r[f"rpc|{SOLANA_RPC}|getBalance|{canon([WALLETS[2][1]])}"] = json.dumps(
        {"jsonrpc": "2.0", "id": 1,
         "result": {"context": {"slot": 266000000}, "value": 1_250_000_000}},
        separators=(",", ":"),
    )
    r[f"rpc|{SOLANA_RPC}|getTokenAccountsByOwner|"
      f"{canon([WALLETS[2][1], {'programId': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}, {'encoding': 'jsonParsed'}])}"] = \
        json.dumps(
            {"jsonrpc": "2.0", "id": 1, "result": {"context": {"slot": 266000001}, "value": [
                {"account": {"data": {"parsed": {"info": {
                    "mint": SPL_MINT,
                    "tokenAmount": {"amount": "5000000000", "decimals": 6,
                                    "uiAmount": 5000.0, "uiAmountString": "5000.0"},
                }}, "program": "spl-token", "type": "account"}},
                 "pubkey": "9xQeWvG816bUx9EPaHpiTJTQ4pFfcCdCdCdCdCdCd"},
            ]}},
            separators=(",", ":"),
        )

    # ---- Hyperliquid (Main) ------------------------------------------------------
    hl_user = WALLETS[0][1]
    r[f"hl|{canon({'type': 'spotClearinghouseState', 'user': hl_user})}"] = json.dumps(
        {"balances": [{"coin": "USDC", "total": "15000.25", "hold": "0.0"},
                      {"coin": "HYPE", "total": "250.5", "hold": "12.5"}]},
        separators=(",", ":"),
    )
    r[f"hl|{canon({'type': 'clearinghouseState', 'user': hl_user})}"] = json.dumps(
        {"marginSummary": {"accountValue": "42500.75", "totalNtlPos": "0.0",
                           "totalRawUsd": "42500.75"},
         "assetPositions": []},
        separators=(",", ":"),
    )
    r[f"hl|{canon({'type': 'userFills', 'user': hl_user})}"] = json.dumps(
        [{"closedPnl": "125.5", "fee": "2.25", "coin": "ETH"},
         {"closedPnl": "-40.0", "fee": "1.5", "coin": "SOL"}],
        separators=(",", ":"),
    )
    return r


# --- the price table and the balances the fixture returns --------------------
LLAMA_URL = ("https://coins.llama.fi/prices/current/"
             + ",".join(LLAMA_IDS.values()))
LLAMA_PRICES = {
    "ETH": ("coingecko:ethereum", 3200.5, 18),
    "BNB": ("coingecko:binancecoin", 590.25, 18),
    "POL": ("coingecko:polygon-ecosystem-token", 0.42, 18),
    "SOL": ("coingecko:solana", 180.75, 9),
    "USDT": ("coingecko:tether", 1.0, 6),
    "USDC": ("coingecko:usd-coin", 1.0, 6),
}
TOKEN_DEC = {"USDT": 6, "USDC": 6}
# (wallet-index, chain) -> native amount in the chain's native unit.
NATIVE = {
    (0, "Ethereum"): 1.234567890123456,
    (0, "BSC"): 12.5,
    (0, "Polygon"): 30000.123456789,
    (0, "Arbitrum"): 0.75,
    (0, "Optimism"): 2.5,
    (0, "Base"): 0.125,
    (1, "Ethereum"): 0.5,
    (1, "BSC"): 3.125,
    (1, "Polygon"): 1000.0,
    (1, "Arbitrum"): 0.0625,
    (1, "Optimism"): 1.5,
    (1, "Base"): 0.25,
}
# (wallet-index, chain, symbol) -> token amount.
TOKEN = {
    (0, "Ethereum", "USDT"): 2500.5,
    (0, "Ethereum", "USDC"): 800.25,
    (0, "BSC", "USDT"): 800.0,
    (0, "BSC", "USDC"): 0.0,          # zero -> dropped below the 1e-6 threshold
    (0, "Polygon", "USDT"): 100.0,
    (0, "Polygon", "USDC"): 25.5,
    (0, "Arbitrum", "USDT"): 400.75,
    (0, "Arbitrum", "USDC"): 60.0,
    (0, "Optimism", "USDT"): 90.125,
    (0, "Optimism", "USDC"): 10.0,
    (0, "Base", "USDC"): 5.0,
    (1, "Ethereum", "USDT"): 100.25,
    (1, "Ethereum", "USDC"): 0.0,
    (1, "BSC", "USDT"): 50.0,
    (1, "BSC", "USDC"): 12.5,
    (1, "Polygon", "USDT"): 200.0,
    (1, "Polygon", "USDC"): 0.0,
    (1, "Arbitrum", "USDT"): 40.0,
    (1, "Arbitrum", "USDC"): 2.5,
    (1, "Optimism", "USDT"): 15.0,
    (1, "Optimism", "USDC"): 7.5,
    (1, "Base", "USDC"): 1.25,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).with_name("capture.json")))
    args = ap.parse_args()
    blob = {"version": 1, "responses": build_responses()}
    Path(args.out).write_text(json.dumps(blob, indent=1, sort_keys=True) + "\n")
    print(f"capture: {len(blob['responses'])} recorded responses -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
