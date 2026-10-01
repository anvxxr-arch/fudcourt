// The mode table is the port of apps/web/lib/cryptorank.ts: the CryptoRank
// mode table, key/allowlist validation and the disabled-mode refusal text.
//
// Everything here is data. The route in cmd/apicalls/main.go is the only place
// that turns a request into one of these modes; the client never passes a raw
// upstream path.
package cryptorank

import (
	"fmt"
	"regexp"
	"strings"
)

// Base is upstream's HTML origin (lib/cryptorank.ts CR_BASE).
const Base = "https://cryptorank.io"

// Modes is CR_MODES, in declaration order -- the array is shipped verbatim in
// the 400 unknown-mode body, so order is part of the contract.
var Modes = []string{
	"home", "coins", "trending", "gainers", "losers",
	"funding", "unlocks", // REFUSED (synthetic data-route class)
	"categories", "exchanges", "coin", // live HTML class, 3-gate verified
	"listings",             // /listings HTML, gate2 majors 0.7%
	"blockchains", "chain", // chain index (278) + keyed ecosystem detail
	"launchpool",  // event lists: /past|/active|/upcoming-launchpool
	"nodesale",    // node sale lists: /past|/active|/upcoming-nodesale
	"news",        // /news aggregator feed (links out to publishers)
	"tags", "tag", // tag taxonomy index (182) + keyed coin detail
	"ecosystems", "ecosystem", // ecosystem index (106) + keyed detail
	"rwa", "rwaasset", // RWA index (209) + keyed type/slug detail
	"quarterly",  // BTC/ETH quarterly returns (GATE2 vs CG daily)
	"prediction", // prediction-market aggregates + markets table
	"converter",  // full price list: /converter (4,975 coins, price only)
	"media",      // /media video aggregator (GATE3 = YT oembed match)
	"newstag",    // /news/tag/<slug> filtered feed (soft-404 -> local 404)
	"aioverview", // /ai-market-overview upstream AI digest (coherence-gated)
}

// ModeCount is the number of modes (healthz "28 modes").
var ModeCount = len(Modes)

var known = func() map[string]bool {
	m := make(map[string]bool, len(Modes))
	for _, x := range Modes {
		m[x] = true
	}
	return m
}()

// Known reports whether mode is one of CR_MODES.
func Known(mode string) bool { return known[mode] }

// KeyedPaths is CR_KEYED_PATHS: keyed live modes -> the upstream path builder.
// Every keyed family passed the 3-gate decoy detector on 2026-09-27
// (nonexistent slug -> 404, prices within 0.002-0.25% of coins.llama.fi,
// cross-surface agreement with the homepage).
var KeyedPaths = map[string]func(key string) string{
	"categories": func(key string) string { return "/categories/" + key },
	"coin":       func(key string) string { return "/price/" + key },
	"chain":      func(key string) string { return "/blockchains/" + key },
	"tag":        func(key string) string { return "/tags/" + key },
	"ecosystem":  func(key string) string { return "/ecosystems/" + key },
	// key = '<plural-type>/<slug>'
	"rwaasset": func(key string) string { return "/rwa/" + key },
	// soft-404: tag=null -> local 404, never unfiltered
	"newstag": func(key string) string { return "/news/tag/" + key },
}

// DefaultKeys is CR_DEFAULT_KEYS.
var DefaultKeys = map[string]string{
	"categories": "chain",
	"coin":       "bitcoin",
	"chain":      "ethereum",
	"tag":        "layer-1",
	"ecosystem":  "ethereum",
	"rwaasset":   "stocks/wendy-s",
	"newstag":    "defi",
}

// IsKeyed reports whether mode is in CR_KEYED_PATHS.
func IsKeyed(mode string) bool { _, ok := KeyedPaths[mode]; return ok }

// ExchangeLists is CR_EXCHANGE_LISTS: a STRICT whitelist key (paths contain
// '/', so the slug regex will not do).
var ExchangeLists = []string{"cex/spot", "dex/spot", "perpetuals", "cex-transparency"}

// DefaultExchange is CR_DEFAULT_EXCHANGE.
const DefaultExchange = "cex/spot"

// LPLists is CR_LP_LISTS: launchpool event lists (paths contain no slug).
var LPLists = []string{"past", "upcoming", "active"}

// DefaultLP is CR_DEFAULT_LP.
const DefaultLP = "past"

// NDLists is CR_ND_LISTS: node sale event lists.
var NDLists = []string{"past", "active", "upcoming"}

// DefaultND is CR_DEFAULT_ND.
const DefaultND = "past"

// KeyRe is CR_KEY_RE.
var KeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// RwaTypes is CR_RWA_TYPES: the plural type segment upstream requires
// (/rwa/<slug> alone 404s).
var RwaTypes = []string{"bonds", "commodities", "etfs", "stocks"}

// RwaKeyRe is CR_RWA_KEY_RE.
var RwaKeyRe = regexp.MustCompile(`^(bonds|commodities|etfs|stocks)/[a-z0-9][a-z0-9-]{0,63}$`)

// CategorySlugs is CR_CATEGORY_SLUGS (28 overview categories).
var CategorySlugs = []string{
	"predictionmarkets", "blockchain-infrastructure", "chain", "blockchain-service",
	"gamefi", "social", "stablecoin", "currency", "defi", "exchange",
	"non-fungible-tokens-nft", "meme", "ce-fi", "payments", "wallet",
	"tokenizedassets", "rwa", "depin", "launchpad", "interoperability",
	"miningandcompute", "compliance", "dataanalytics", "ai", "liquidstaking",
	"brokerage", "treasure", "privacy",
}

// Disabled is CR_DISABLED: modes the route REFUSES (503) because upstream
// serves synthetic decoy.
var Disabled = []string{"funding", "unlocks"}

// DisabledReason is CR_DISABLED_REASON, verbatim (concatenated exactly as the
// TS literal concatenates it).
const DisabledReason = "upstream /_next/data serves synthetic decoy: nonexistent slugs return 200 fabricated payloads, " +
	"prices diverge from ground truth (measured 57k-67k vs real 84.5k BTC), names are template-generated " +
	"(2026-09-27) -- disabled until the slug-404 + independent-source tests pass"

// Reverify is the TS route's reverify hint string.
const Reverify = "scripts/verify-cryptorank.py (nonexistent-slug must 404 + independent ground-truth match)"

// IsDisabled reports whether mode is in CR_DISABLED.
func IsDisabled(mode string) bool {
	for _, d := range Disabled {
		if d == mode {
			return true
		}
	}
	return false
}

// ModeArg is CR_MODE_ARGS[mode]: how the Python helper is driven for a mode.
// Flag is "--path" (HTML page) or "--data-route" (Next.js data route, kept
// ONLY so the decoy detector in scripts/verify-cryptorank.py can still probe
// upstream; the refusals above stay refusals).
type ModeArg struct {
	Flag  string
	Value string
}

// ModeArgs is CR_MODE_ARGS, keyed by mode.
var ModeArgs = map[string]ModeArg{
	"home":        {"--path", "/"},
	"coins":       {"--path", "/all-coins-list"},
	"trending":    {"--path", "/trending"},
	"gainers":     {"--path", "/gainers"},
	"losers":      {"--path", "/losers"},
	"funding":     {"--data-route", "/funding-rounds"},
	"unlocks":     {"--data-route", "/token-unlock"},
	"categories":  {"--path", "/categories/chain"},   // default key; route overrides
	"exchanges":   {"--path", "/exchanges/cex/spot"}, // default key; route overrides
	"coin":        {"--path", "/price/bitcoin"},      // default key; route overrides
	"listings":    {"--path", "/listings"},
	"blockchains": {"--path", "/blockchains"},
	"chain":       {"--path", "/blockchains/ethereum"}, // default key; route overrides
	"launchpool":  {"--path", "/past-launchpool"},      // default variant; route overrides
	"nodesale":    {"--path", "/past-nodesale"},        // default variant; route overrides
	"news":        {"--path", "/news"},
	"tags":        {"--path", "/tags"},
	"tag":         {"--path", "/tags/layer-1"}, // default key; route overrides
	"ecosystems":  {"--path", "/ecosystems"},
	"ecosystem":   {"--path", "/ecosystems/ethereum"}, // default key; route overrides
	"rwa":         {"--path", "/rwa"},
	"rwaasset":    {"--path", "/rwa/stocks/wendy-s"}, // default key; route overrides
	"quarterly":   {"--path", "/charts/quarterly-returns"},
	"prediction":  {"--path", "/prediction-markets"},
	"converter":   {"--path", "/converter"},
	"media":       {"--path", "/media"},
	"newstag":     {"--path", "/news/tag/defi"}, // default key; route overrides
	"aioverview":  {"--path", "/ai-market-overview"},
}

// ModeUpstream is CR_MODE_UPSTREAM: canonical HTML URL of what a mode's data
// represents (for the envelope). Keyed modes carry their DEFAULT key here; the
// route overrides with the requested key.
var ModeUpstream = map[string]string{
	"home":        Base + "/",
	"coins":       Base + "/all-coins-list",
	"trending":    Base + "/trending",
	"gainers":     Base + "/gainers",
	"losers":      Base + "/losers",
	"funding":     Base + "/funding-rounds",
	"unlocks":     Base + "/token-unlock",
	"categories":  Base + "/categories/chain",
	"exchanges":   Base + "/exchanges/cex/spot",
	"coin":        Base + "/price/bitcoin",
	"listings":    Base + "/listings",
	"blockchains": Base + "/blockchains",
	"chain":       Base + "/blockchains/ethereum",
	"launchpool":  Base + "/past-launchpool",
	"nodesale":    Base + "/past-nodesale",
	"news":        Base + "/news",
	"tags":        Base + "/tags",
	"tag":         Base + "/tags/layer-1",
	"ecosystems":  Base + "/ecosystems",
	"ecosystem":   Base + "/ecosystems/ethereum",
	"rwa":         Base + "/rwa",
	"rwaasset":    Base + "/rwa/stocks/wendy-s",
	"quarterly":   Base + "/charts/quarterly-returns",
	"prediction":  Base + "/prediction-markets",
	"converter":   Base + "/converter",
	"media":       Base + "/media",
	"newstag":     Base + "/news/tag/defi",
	"aioverview":  Base + "/ai-market-overview",
}

// Upstream returns CR_MODE_UPSTREAM[mode] (empty for an unknown mode).
func Upstream(mode string) string { return ModeUpstream[mode] }

// ListVariant maps a whitelisted variant key to its upstream path segment for
// the two event-list families. kind is "launchpool" or "nodesale".
func ListVariant(kind, key string) string {
	if key == "" {
		if kind == "launchpool" {
			key = DefaultLP
		} else {
			key = DefaultND
		}
	}
	var suffix string
	switch key {
	case "upcoming":
		suffix = "upcoming"
	case "active":
		suffix = "active"
	default:
		suffix = "past"
	}
	return fmt.Sprintf("/%s-%s", suffix, kind)
}

// KeyedPath resolves a keyed mode's upstream path, mirroring the route's
// `if (mode in CR_KEYED_PATHS)` branch (key=="" already defaulted by the route).
func KeyedPath(mode, key string) string {
	b, ok := KeyedPaths[mode]
	if !ok {
		return ""
	}
	return b(key)
}

// ValidKey validates a keyed-mode key with the right regex for that family.
func ValidKey(mode, key string) bool {
	if mode == "rwaasset" {
		return RwaKeyRe.MatchString(key)
	}
	return KeyRe.MatchString(key)
}

// InList reports membership in a whitelist.
func InList(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// CanonicalPath is the upstream path a mode+key resolves to, after the route's
// defaulting rules. It is used for the cache slug and the helper invocation.
func CanonicalPath(mode, key string) (string, error) {
	if IsKeyed(mode) {
		if key == "" {
			key = DefaultKeys[mode]
		}
		return KeyedPath(mode, key), nil
	}
	if mode == "exchanges" {
		if key == "" {
			key = DefaultExchange
		}
		return "/exchanges/" + key, nil
	}
	if mode == "launchpool" || mode == "nodesale" {
		return ListVariant(mode, key), nil
	}
	a, ok := ModeArgs[mode]
	if !ok {
		return "", fmt.Errorf("unknown mode %q", mode)
	}
	return a.Value, nil
}

// TrimSlash mirrors the Python helper's slug derivation: strip surrounding
// slashes, then turn '/' into '_' ("root" for the homepage).
func TrimSlash(p string) string { return strings.Trim(p, "/") }
