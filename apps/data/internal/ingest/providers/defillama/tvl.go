package defillama

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// protocolRow is one /protocols entry (trimmed to the fields the adapter
// reads): {"slug":"aave","name":"Aave","tvl":8384213314.3,
// "chainTvls":{"Ethereum":512345678.9,"Arbitrum":123456789.1},
// "category":"Lending"}.
type protocolRow struct {
	Slug      string             `json:"slug"`
	Name      string             `json:"name"`
	TVL       float64            `json:"tvl"`
	ChainTvls map[string]float64 `json:"chainTvls"`
	Category  string             `json:"category"`
}

// chainCmcID decodes /v2/chains' cmcId. The live wire carries it as a STRING
// ("6836") and gecko-only chains omit the key entirely; older snapshots also
// spell it as a bare number. Every spelling lands in one *string (the decimal
// text, verbatim); absence is nil, never 0 (never-fake). A spelling that is
// neither a quoted string nor a bare integer leaves the field nil rather than
// failing the row: the id is metadata, and a broken value is never guessed.
type chainCmcID struct{ v *string }

func (c *chainCmcID) UnmarshalJSON(b []byte) error {
	c.v = nil
	s := string(b)
	if s == "null" {
		return nil
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		inner := s[1 : len(s)-1]
		if inner != "" {
			c.v = &inner
		}
		return nil
	}
	if _, err := strconv.ParseInt(s, 10, 64); err == nil {
		c.v = &s
	}
	return nil
}

// chainRow is one /v2/chains entry (trimmed): {"gecko_id":"ethereum",
// "name":"Ethereum","tokenSymbol":"ETH","cmcId":"1027",
// "tvl":51234567890.1} — cmcId is a quoted string on the live wire and
// missing on gecko-only rows.
type chainRow struct {
	GeckoID     string     `json:"gecko_id"`
	Name        string     `json:"name"`
	TokenSymbol string     `json:"tokenSymbol"`
	CmcID       chainCmcID `json:"cmcId"`
	TVL         float64    `json:"tvl"`
}

// chainNumericID converts the decoded cmcId text to the chain row's numeric
// id. An absent or non-numeric id stays nil (never-fake: NULL, never 0).
func chainNumericID(c chainCmcID) *int {
	if c.v == nil {
		return nil
	}
	n, err := strconv.Atoi(*c.v)
	if err != nil {
		return nil
	}
	return &n
}

// protocolsTVL fetches the protocol universe with current TVL:
// GET /protocols. Every row upserts its protocol entity (ProtocolKey(slug))
// and writes the aggregate tvl_protocol row (ChainID "") plus one row per
// chain under chainTvls. DefiLlama publishes no timestamp on this endpoint,
// so At is the fetch time (the data is "as of now").
func (c *client) protocolsTVL(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	url := Base + "/protocols"
	var raw []protocolRow
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	protocols := make([]canon.Protocol, 0, len(raw))
	var tvl []canon.ProtocolTVL
	rejected := 0
	for _, r := range raw {
		if r.Slug == "" {
			// A nameless slug row is unidentifiable; counted, not fatal —
			// the universe endpoint is large and one broken row must not
			// drop the rest.
			rejected++
			continue
		}
		pid := canon.MintID(canon.KindProtocol, canon.ProtocolKey(r.Slug))
		protocols = append(protocols, canon.Protocol{
			ProtocolID: pid,
			Slug:       lower(r.Slug),
			Name:       strPtr(r.Name),
			Category:   strPtr(r.Category),
		})
		if r.TVL != 0 {
			tvl = append(tvl, canon.ProtocolTVL{
				ProtocolID: pid,
				ChainID:    "",
				TVLUSD:     r.TVL,
				At:         now,
				Source:     "defillama",
			})
		}
		for chain, v := range r.ChainTvls {
			if v == 0 {
				continue
			}
			tvl = append(tvl, canon.ProtocolTVL{
				ProtocolID: pid,
				ChainID:    canon.MintID(canon.KindChain, canon.ChainKey(chain)),
				TVLUSD:     v,
				At:         now,
				Source:     "defillama",
			})
		}
	}
	if len(protocols) == 0 {
		if rejected > 0 {
			return 0, rejected, nil
		}
		return 0, 0, nil
	}
	if _, err := w.UpsertProtocols(ctx, protocols); err != nil {
		return 0, 0, err
	}
	written, rej, err := w.WriteProtocolTVL(ctx, tvl)
	return written, rej + rejected, err
}

// chainTVL fetches the chain universe with current TVL:
// GET /v2/chains. Every row upserts its chain entity (ChainKey(name)) and
// writes one tvl_chain row. As with protocols, At is the fetch time.
func (c *client) chainTVL(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	url := Base + "/v2/chains"
	var raw []chainRow
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	chains := make([]canon.Chain, 0, len(raw))
	tvl := make([]canon.ChainTVL, 0, len(raw))
	rejected := 0
	for _, r := range raw {
		if r.Name == "" {
			rejected++
			continue
		}
		cid := canon.MintID(canon.KindChain, canon.ChainKey(r.Name))
		kind := "evm"
		if r.GeckoID == "solana" {
			kind = "solana"
		}
		chains = append(chains, canon.Chain{
			ChainID:        cid,
			Name:           lower(r.Name),
			DisplayName:    strPtr(r.Name),
			Kind:           kind,
			ChainNumericID: chainNumericID(r.CmcID),
		})
		if r.TVL != 0 {
			tvl = append(tvl, canon.ChainTVL{
				ChainID: cid,
				TVLUSD:  r.TVL,
				At:      now,
				Source:  "defillama",
			})
		}
	}
	if len(chains) == 0 {
		if rejected > 0 {
			return 0, rejected, nil
		}
		return 0, 0, nil
	}
	if _, err := w.UpsertChains(ctx, chains); err != nil {
		return 0, 0, err
	}
	return w.WriteChainTVL(ctx, tvl)
}

// protocolHistory fetches one protocol's TVL history:
// GET /protocol/{slug} -> {"tvl":[{"date":1707163200,"totalLiquidityUSD":
// 8384213314.3},...],"tokens":{...},"tokensInUsd":{...},"chainTvls":{...}}.
// (The /v2/protocol/{slug} spelling 404s on the live API — the versioned
// prefix belongs to /v2/chains only.) The tvl array becomes tvl_protocol
// rows (ChainID "" for the aggregate); chainTvls' per-chain tvl arrays become
// the per-chain rows. The slug comes from the job subject; a 90-day backfill
// window (cursor days, default 90) bounds the write set.
func (c *client) protocolHistory(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	slug := job.Subject
	if s, ok := job.Cursor["slug"].(string); ok && s != "" {
		slug = s
	}
	if slug == "" {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "protocol history job needs a slug (cursor slug or subject)"}
	}
	days := 90
	if n, ok := job.Cursor["days"].(float64); ok && n > 0 {
		days = int(n)
	}
	url := fmt.Sprintf("%s/protocol/%s", Base, slug)
	var res struct {
		TVL []struct {
			Date              float64 `json:"date"`
			TotalLiquidityUSD float64 `json:"totalLiquidityUSD"`
		} `json:"tvl"`
		ChainTvls map[string][]struct {
			Date              float64 `json:"date"`
			TotalLiquidityUSD float64 `json:"totalLiquidityUSD"`
		} `json:"chainTvls"`
	}
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, nil, err
	}
	pid := canon.MintID(canon.KindProtocol, canon.ProtocolKey(slug))
	now := time.Now().UTC()
	cutoff := now.AddDate(0, 0, -days)
	rows := make([]canon.ProtocolTVL, 0, len(res.TVL))
	for _, p := range res.TVL {
		if p.TotalLiquidityUSD == 0 {
			continue
		}
		at := secs(p.Date)
		if at.Before(cutoff) {
			continue
		}
		rows = append(rows, canon.ProtocolTVL{
			ProtocolID: pid,
			ChainID:    "",
			TVLUSD:     p.TotalLiquidityUSD,
			At:         at,
			Source:     "defillama",
		})
	}
	for chain, points := range res.ChainTvls {
		cid := canon.MintID(canon.KindChain, canon.ChainKey(chain))
		for _, p := range points {
			if p.TotalLiquidityUSD == 0 {
				continue
			}
			at := secs(p.Date)
			if at.Before(cutoff) {
				continue
			}
			rows = append(rows, canon.ProtocolTVL{
				ProtocolID: pid,
				ChainID:    cid,
				TVLUSD:     p.TotalLiquidityUSD,
				At:         at,
				Source:     "defillama",
			})
		}
	}
	next := ingest.Cursor{"slug": slug, "days": float64(days)}
	if len(rows) == 0 {
		return 0, 0, next, nil
	}
	written, rejected, err := w.WriteProtocolTVL(ctx, rows)
	return written, rejected, next, err
}

// lower is strings.ToLower local (avoids a strings import per file).
func lower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}
