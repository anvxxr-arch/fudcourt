// Package config reads the bot's configuration from the process environment.
//
// Every key is optional at the type level; FromEnv decides what is fatal. The
// bot token is the ONE required key — without it the process cannot talk to
// Telegram, so startup fails visibly (objective §34, the same fail-visible rule
// apps/api follows). Everything else degrades: an empty admin list means no
// one is admin, an empty wallet list means /wallets and /balance say so.
//
// The token key is FUDCOURT_TELEGRAM_BOT_TOKEN, shared with the executor's
// notify package (apps/executor/internal/notify) so one bot
// (@fudbase_bot) is configured once. The notify package only SENDS; this
// service is the receiving half (getUpdates long-poll), so the two do not
// contend for the same Telegram method.
package config

import (
	"fmt"
	"strconv"
	"strings"
)

// Env keys. Token and chat id are the pair notify already documents; the rest
// are bot-local.
const (
	// EnvBotToken is the @fudbase_bot token from @BotFather. REQUIRED.
	EnvBotToken = "FUDCOURT_TELEGRAM_BOT_TOKEN"
	// EnvAdminIDs is a comma-separated allowlist of numeric Telegram user ids.
	EnvAdminIDs = "FUDCOURT_BOT_ADMIN_IDS"
	// EnvDataURL is the fudcourt data sidecar base (default loopback :3101).
	EnvDataURL = "FUDCOURT_DATA_URL"
	// EnvWallets is a comma-separated list of `label:0xaddress` pairs.
	EnvWallets = "FUD_WALLETS"
	// EnvEVM RPC is an optional JSON-RPC endpoint for /balance.
	EnvEVMRPC = "EVM_RPC_URL"
	// EnvAPIBase overrides the Telegram Bot API root. Empty keeps the real
	// api.telegram.org; set it to point the bot at a stub for an offline
	// end-to-end run (the same additive seam FUDCOURT_DISCORD_API gives the api
	// service).
	EnvAPIBase = "FUDCOURT_BOT_API"
)

// DefaultDataURL is the loopback data sidecar every FUDCourt service reaches.
const DefaultDataURL = "http://127.0.0.1:3101"

// Wallet is one labelled address from EnvWallets.
type Wallet struct {
	Label   string
	Address string
}

// Config is the resolved runtime configuration.
type Config struct {
	// BotToken authenticates every Bot API call. Required.
	BotToken string
	// AdminIDs is the set of user ids allowed to run admin commands.
	AdminIDs map[int64]bool
	// DataURL is the data sidecar base URL (no trailing slash).
	DataURL string
	// Wallets are the configured FUD addresses.
	Wallets []Wallet
	// EVMRPC is an optional JSON-RPC URL for /balance (empty disables it).
	EVMRPC string
	// APIBase overrides the Bot API root (empty = real api.telegram.org).
	APIBase string
}

// IsAdmin reports whether a user id is on the allowlist.
func (c Config) IsAdmin(id int64) bool { return c.AdminIDs[id] }

// FromEnv builds the configuration. It returns an error only when the bot token
// is missing — a deliberately narrow fatal set, so a bot that can talk to
// Telegram still starts with no admins and no wallets.
func FromEnv(getenv func(string) string) (Config, error) {
	token := strings.TrimSpace(getenv(EnvBotToken))
	if token == "" {
		return Config{}, fmt.Errorf("config: %s is required", EnvBotToken)
	}

	dataURL := strings.TrimSpace(getenv(EnvDataURL))
	if dataURL == "" {
		dataURL = DefaultDataURL
	}
	dataURL = strings.TrimRight(dataURL, "/")

	return Config{
		BotToken: token,
		AdminIDs: parseIDs(getenv(EnvAdminIDs)),
		DataURL:  dataURL,
		Wallets:  parseWallets(getenv(EnvWallets)),
		EVMRPC:   strings.TrimSpace(getenv(EnvEVMRPC)),
		APIBase:  strings.TrimSpace(getenv(EnvAPIBase)),
	}, nil
}

// parseIDs turns "1, 2;3" into a set. Unparseable tokens are skipped rather
// than fatal: a typo in the allowlist should not stop the bot from serving.
func parseIDs(raw string) map[int64]bool {
	out := map[int64]bool{}
	for _, chunk := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == ' '
	}) {
		if id, err := strconv.ParseInt(strings.TrimSpace(chunk), 10, 64); err == nil {
			out[id] = true
		}
	}
	return out
}

// parseWallets turns "main:0xabc,trading:0xdef" into wallets. A pair without an
// address is skipped (a label alone names nothing to query).
func parseWallets(raw string) []Wallet {
	var out []Wallet
	for _, item := range strings.Split(raw, ",") {
		label, addr, ok := strings.Cut(strings.TrimSpace(item), ":")
		if !ok {
			continue
		}
		label, addr = strings.TrimSpace(label), strings.TrimSpace(addr)
		if label == "" || addr == "" {
			continue
		}
		out = append(out, Wallet{Label: label, Address: addr})
	}
	return out
}
