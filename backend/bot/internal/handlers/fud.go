package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// service is one local fudcourt endpoint the /status probe reads.
type service struct {
	label string
	url   string
}

// services are the loopback FUDCourt tiers (DR-002: loopback-only). Every Go and
// Bun service answers /healthz; the web tier answers / directly.
var services = []service{
	{"web", "http://127.0.0.1:3100/"},
	{"data", "http://127.0.0.1:3101/healthz"},
	{"reconciled", "http://127.0.0.1:3102/healthz"},
	{"api", "http://127.0.0.1:3103/healthz"},
	{"bot", "self"},
}

// registerFud wires the FUD-ecosystem commands.
func registerFud(r *Registry) {
	r.Add(Handler{
		Name:        "status",
		Description: "fudcourt service health",
		Run:         cmdStatus,
	})
	r.Add(Handler{
		Name:        "wallets",
		Description: "List the configured FUD wallets",
		Run:         cmdWallets,
	})
	r.Add(Handler{
		Name:        "balance",
		Description: "Native balance of the configured wallets",
		Run:         cmdBalance,
	})
}

func cmdStatus(c *Ctx) error {
	var b strings.Builder
	b.WriteString("<b>fudcourt status</b>")
	for _, s := range services {
		if s.url == "self" {
			fmt.Fprintf(&b, "\n✅ %s", Esc(s.label))
			continue
		}
		fmt.Fprintf(&b, "\n%s", probeLine(c, s))
	}
	return c.Reply(b.String())
}

// probeLine performs one GET and renders a status glyph. A non-2xx or a
// transport error is reported honestly — never a fake OK.
func probeLine(c *Ctx, s service) string {
	req, err := http.NewRequestWithContext(c.Ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return fmt.Sprintf("⚠️ %s — bad url", Esc(s.label))
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 4 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Sprintf("❌ %s — down", Esc(s.label))
	}
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close() }()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return fmt.Sprintf("✅ %s", Esc(s.label))
	}
	return fmt.Sprintf("⚠️ %s — http %d", Esc(s.label), resp.StatusCode)
}

func cmdWallets(c *Ctx) error {
	if len(c.Config.Wallets) == 0 {
		return c.Reply("No wallets configured. Set <code>FUD_WALLETS=label:0xaddr,label:0xaddr</code>.")
	}
	var b strings.Builder
	b.WriteString("<b>FUD wallets</b>")
	for _, w := range c.Config.Wallets {
		fmt.Fprintf(&b, "\n• <b>%s</b> — <code>%s</code>", Esc(w.Label), Esc(w.Address))
	}
	return c.Reply(b.String())
}

func cmdBalance(c *Ctx) error {
	if c.Config.EVMRPC == "" {
		return c.Reply("No RPC configured. Set <code>EVM_RPC_URL</code> to enable /balance.")
	}
	if len(c.Config.Wallets) == 0 {
		return c.Reply("No wallets configured (set <code>FUD_WALLETS</code>).")
	}
	var b strings.Builder
	b.WriteString("<b>Balances</b>")
	for _, w := range c.Config.Wallets {
		wei, err := ethGetBalance(c, w.Address)
		if err != nil {
			fmt.Fprintf(&b, "\n• <b>%s</b> — ⚠️ %s", Esc(w.Label), Esc(err.Error()))
			continue
		}
		fmt.Fprintf(&b, "\n• <b>%s</b> — <code>%.6f</code>", Esc(w.Label), weiToEther(wei))
	}
	return c.Reply(b.String())
}

// rpcRequest is a minimal JSON-RPC 2.0 call body.
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResponse struct {
	Result string `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// ethGetBalance calls eth_getBalance and returns the balance as a big-endian
// hex string (as the RPC sends it). The conversion to a number happens in
// weiToEther so a huge balance cannot overflow an int64 here.
func ethGetBalance(c *Ctx, address string) (string, error) {
	body, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "eth_getBalance",
		Params:  []any{address, "latest"},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(c.Ctx, http.MethodPost, c.Config.EVMRPC, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	var decoded rpcResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return "", fmt.Errorf("decode rpc (http %d)", resp.StatusCode)
	}
	if decoded.Error != nil {
		return "", fmt.Errorf("%s", decoded.Error.Message)
	}
	return decoded.Result, nil
}

// weiToEther converts a hex wei quantity to ether. math/big carries the integer
// part so 18 decimals of precision survive the division (a float64 wei value
// would lose the low digits immediately).
func weiToEther(hexWei string) float64 {
	s := strings.TrimPrefix(strings.TrimSpace(hexWei), "0x")
	if s == "" {
		return 0
	}
	n, ok := new(big.Int).SetString(s, 16)
	if !ok {
		return 0
	}
	f := new(big.Float).SetInt(n)
	f.Quo(f, big.NewFloat(1e18))
	out, _ := f.Float64()
	return out
}
