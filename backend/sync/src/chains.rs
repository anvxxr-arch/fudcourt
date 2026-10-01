//! Chain / wallet / price-oracle registry, transcribed from the Python
//! original (`frontend/web/scripts/tools/sync-live.py`).

pub struct EvmChain {
    pub name: &'static str,
    /// `https://<host>/v2/{ALCHEMY}` -- expanded at runtime, never logged.
    pub host: &'static str,
    pub native: &'static str,
    /// (symbol, contract, decimals)
    pub tokens: &'static [(&'static str, &'static str, u32)],
}

pub const EVM: &[EvmChain] = &[
    EvmChain {
        name: "Ethereum",
        host: "eth-mainnet.g.alchemy.com",
        native: "ETH",
        tokens: &[
            ("USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6),
            ("USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6),
        ],
    },
    EvmChain {
        name: "BSC",
        host: "bnb-mainnet.g.alchemy.com",
        native: "BNB",
        tokens: &[
            ("USDT", "0x55d398326f99059ff775485246999027b3197955", 18),
            ("USDC", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 18),
        ],
    },
    EvmChain {
        name: "Polygon",
        host: "polygon-mainnet.g.alchemy.com",
        native: "POL",
        tokens: &[
            ("USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", 6),
            ("USDC", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 6),
        ],
    },
    EvmChain {
        name: "Arbitrum",
        host: "arb-mainnet.g.alchemy.com",
        native: "ETH",
        tokens: &[
            ("USDT", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6),
            ("USDC", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", 6),
        ],
    },
    EvmChain {
        name: "Optimism",
        host: "opt-mainnet.g.alchemy.com",
        native: "ETH",
        tokens: &[
            ("USDT", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", 6),
            ("USDC", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", 6),
        ],
    },
    EvmChain {
        name: "Base",
        host: "base-mainnet.g.alchemy.com",
        native: "ETH",
        tokens: &[("USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6)],
    },
];

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Evm,
    Sol,
}

pub struct Wallet {
    pub label: &'static str,
    pub addr: &'static str,
    pub kind: Kind,
}

pub const WALLETS: &[Wallet] = &[
    Wallet {
        label: "Main",
        addr: "0x6816ba2cb2bc013a78225228a153586ca63b1548",
        kind: Kind::Evm,
    },
    Wallet {
        label: "Hanif",
        addr: "0xB0be41f0e7F0AD49622B292dA1322c2BEA46fA1b",
        kind: Kind::Evm,
    },
    Wallet {
        label: "Akang",
        addr: "7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP",
        kind: Kind::Sol,
    },
];

/// `LLAMA_IDS`, order preserved (the request URL is built from the values).
pub const LLAMA_IDS: &[(&str, &str)] = &[
    ("ETH", "coingecko:ethereum"),
    ("BNB", "coingecko:binancecoin"),
    ("POL", "coingecko:polygon-ecosystem-token"),
    ("SOL", "coingecko:solana"),
    ("USDT", "coingecko:tether"),
    ("USDC", "coingecko:usd-coin"),
];

pub const SOLANA_RPC: &str = "https://api.mainnet-beta.solana.com";
pub const HYPERLIQUID_INFO: &str = "https://api.hyperliquid.xyz/info";
pub const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ERC20_BALANCE_OF: &str = "0x70a08231";

// Polygon's native balance is valued at the POL (polygon-ecosystem-token)
// price and the `assets` row is labelled `MATIC` — the label the oracle and
// the historical table already use. `sync.rs` carries the pairing (see its
// `"MATIC"` row); there is no separate constant to drift from it.
