package evmrpc

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"golang.org/x/crypto/sha3"
)

// This file is the parser layer: raw `eth_getLogs` entries in, canonical AMM
// events out. It has NO RPC knowledge — it is pure and unit-testable without a
// node, which is the point of the transport/parser split in module.go.
//
// The two families plan §20 names are recognised by topic0:
//
//	Uniswap V2 pair events     Swap, Mint, Burn, Sync
//	Uniswap V3 pool events     Swap, Mint, Burn
//
// The event signatures are keccak-256 of the canonical ABI strings, computed
// here at init so the constants are provably the hashes they claim to be (a
// copied-in literal cannot silently drift). V2's Swap carries the RAW uint
// amounts plus the post-swap reserves, so the direction is read from the sign of
// each amount (positive == the pair received that token == the taker's input),
// which mirrors the pool-perspective convention the subgraph adapter uses.

// rawLog is one eth_getLogs entry.
type rawLog struct {
	Address          string   `json:"address"`
	Topics           []string `json:"topics"`
	Data             string   `json:"data"`
	BlockNumber      string   `json:"blockNumber"`
	TransactionHash  string   `json:"transactionHash"`
	TransactionIndex string   `json:"transactionIndex"`
	LogIndex         string   `json:"logIndex"`
	Removed          bool     `json:"removed"`
}

// event is one decoded AMM event before it is mapped to a canonical row.
//
// NOTE: no AMM swap event carries the token ADDRESSES — they live on the pool
// contract, not in the log — so this struct deliberately has no Token0/Token1
// fields. Amount0/Amount1 are the pool-perspective signed deltas: a POSITIVE
// value is what the pool RECEIVED (the taker's input), NEGATIVE what it paid out.
type event struct {
	Kind     string // "swap" | "mint" | "burn" | "sync"
	Family   string // "v2" | "v3"
	Pool     string
	TxHash   string
	LogIndex int
	Block    int64
	// Amount0/Amount1 are the signed pool deltas in RAW token units.
	Amount0 *big.Int
	Amount1 *big.Int
	// Sender/Recipient are the addresses the event indexed. V2's Swap indexes
	// only `to`; V3's indexes `sender` and `recipient`. Their meaning differs by
	// family, so each is labelled where it is set.
	Sender    string
	Recipient string
	// V3-only: the decoded sqrtPriceX96 and liquidity, kept as raw integers so
	// a derived price stays exact and is computed downstream, never here.
	SqrtPriceX96 *big.Int
	Liquidity    *big.Int
}

var (
	// keccak256 of the canonical V2 pair event signatures.
	topicV2Swap = topic("Swap(address,uint256,uint256,uint256,uint256,address)")
	topicV2Mint = topic("Mint(address,uint256,uint256)")
	topicV2Burn = topic("Burn(address,uint256,uint256,address)")
	topicV2Sync = topic("Sync(uint112,uint112)")
	// keccak256 of the canonical V3 pool event signatures.
	topicV3Swap = topic("Swap(address,address,int256,int256,uint160,uint128,int24)")
	topicV3Mint = topic("Mint(address,address,int24,int24,uint128,uint256,uint256)")
	topicV3Burn = topic("Burn(address,int24,int24,uint128,uint256,uint256)")
)

// topic returns the 0x-prefixed keccak-256 of an event signature, lowercased.
func topic(sig string) string {
	h := sha3.NewLegacyKeccak256()
	_, _ = h.Write([]byte(sig))
	return "0x" + hex.EncodeToString(h.Sum(nil))
}

// topic0 returns a log's lowercased 0x topic0, or "".
func topic0(l rawLog) string {
	if len(l.Topics) == 0 {
		return ""
	}
	return strings.ToLower(l.Topics[0])
}

// parseLog decodes one raw log into an event, or (nil, nil) when the topic is a
// log this adapter does not model (a transfer, an approval). A log that CARRIES
// a known topic but whose data is malformed is an error, never silently skipped.
func parseLog(l rawLog) (*event, error) {
	if l.Removed {
		// A removed log is a re-org tombstone, not an event.
		return nil, nil
	}
	blk, err := parseUint64(l.BlockNumber)
	if err != nil {
		return nil, fmt.Errorf("blockNumber %q: %w", l.BlockNumber, err)
	}
	li, err := parseUint64(l.LogIndex)
	if err != nil {
		return nil, fmt.Errorf("logIndex %q: %w", l.LogIndex, err)
	}
	e := &event{
		Pool:     strings.ToLower(l.Address),
		TxHash:   strings.ToLower(l.TransactionHash),
		LogIndex: int(li),
		Block:    int64(blk),
	}
	data, err := hexWords(l.Data)
	if err != nil {
		return nil, fmt.Errorf("data: %w", err)
	}
	switch topic0(l) {
	case topicV2Swap:
		e.Kind, e.Family = "swap", "v2"
		// V2 Swap(address sender, uint amount0In, uint amount1In, uint amount0Out,
		// uint amount1Out, address to): topic1 = sender, data = 4 amount words.
		// The pool's signed delta is IN - OUT, so the fold must use all four —
		// reading only the first two would make a swap indistinguishable from a
		// mint.
		d, err := needWords(data, 4)
		if err != nil {
			return nil, err
		}
		e.Amount0 = new(big.Int).Sub(d[0], d[2])
		e.Amount1 = new(big.Int).Sub(d[1], d[3])
		e.Sender = wordAddress(dataWord(l.Topics, 1))
		e.Recipient = wordAddress(dataWord(l.Topics, 2))
	case topicV2Mint:
		e.Kind, e.Family = "mint", "v2"
		// V2 Mint(address sender, uint amount0, uint amount1): topic1 = sender,
		// data = the two amounts INTO the pool (both positive).
		d, err := needWords(data, 2)
		if err != nil {
			return nil, err
		}
		e.Amount0, e.Amount1 = signedFromUint(d[0]), signedFromUint(d[1])
		e.Sender = wordAddress(dataWord(l.Topics, 1))
	case topicV2Burn:
		e.Kind, e.Family = "burn", "v2"
		// V2 Burn(address sender, uint amount0, uint amount1, address to):
		// topic1 = sender, topic2 = to, data = the two amounts OUT of the pool.
		d, err := needWords(data, 2)
		if err != nil {
			return nil, err
		}
		e.Amount0 = new(big.Int).Neg(signedFromUint(d[0]))
		e.Amount1 = new(big.Int).Neg(signedFromUint(d[1]))
		e.Sender = wordAddress(dataWord(l.Topics, 1))
		e.Recipient = wordAddress(dataWord(l.Topics, 2))
	case topicV2Sync:
		e.Kind, e.Family = "sync", "v2"
		// Sync(uint112 reserve0, uint112 reserve1): the post-swap reserves, a
		// liquidity fact, not a trade. The two decoded values ARE the pool's
		// current reserves (positive), so they are labelled as such.
		d, err := needWords(data, 2)
		if err != nil {
			return nil, err
		}
		// A 0x00 on either side would be a degenerate reserve; keep the values as
		// decoded and let the caller treat a sync as a snapshot, not a swap.
		e.Amount0, e.Amount1 = signedFromUint(d[0]), signedFromUint(d[1])
	case topicV3Swap:
		e.Kind, e.Family = "swap", "v3"
		// V3 Swap(address sender, address recipient, int amount0, int amount1,
		// uint160 sqrtPriceX96, uint128 liquidity, int tick): topic1 = sender,
		// topic2 = recipient, data = amount0, amount1, sqrtPriceX96, liquidity, tick.
		d, err := needWords(data, 5)
		if err != nil {
			return nil, err
		}
		e.Amount0, e.Amount1 = signedFromInt256(d[0]), signedFromInt256(d[1])
		e.SqrtPriceX96 = new(big.Int).Set(d[2])
		e.Liquidity = new(big.Int).Set(d[3])
		e.Sender = wordAddress(dataWord(l.Topics, 1))
		e.Recipient = wordAddress(dataWord(l.Topics, 2))
	case topicV3Mint:
		e.Kind, e.Family = "mint", "v3"
		// V3 Mint(address sender, address owner, int24 tickLower, int24 tickUpper,
		// uint128 amount, uint amount0, uint amount1): data = tickLower,
		// tickUpper, amount, amount0, amount1 (the two token amounts last).
		d, err := needWords(data, 5)
		if err != nil {
			return nil, err
		}
		e.Amount0, e.Amount1 = signedFromUint(d[3]), signedFromUint(d[4])
		e.Sender = wordAddress(dataWord(l.Topics, 1))
		e.Recipient = wordAddress(dataWord(l.Topics, 2))
	case topicV3Burn:
		e.Kind, e.Family = "burn", "v3"
		// V3 Burn(address owner, int24 tickLower, int24 tickUpper, uint128 amount,
		// uint amount0, uint amount1): data = tickLower, tickUpper, amount,
		// amount0, amount1 (the two token amounts last).
		d, err := needWords(data, 5)
		if err != nil {
			return nil, err
		}
		e.Amount0 = new(big.Int).Neg(signedFromUint(d[3]))
		e.Amount1 = new(big.Int).Neg(signedFromUint(d[4]))
		e.Sender = wordAddress(dataWord(l.Topics, 1))
	default:
		return nil, nil
	}
	return e, nil
}

// --- hex/word helpers --------------------------------------------------------

// hexWords decodes 0x-prefixed ABI-encoded data into 32-byte words. An empty
// data field yields no words (a topic-only event); odd-length or non-hex data is
// an error.
func hexWords(s string) ([]*big.Int, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "0x")
	if s == "" {
		return nil, nil
	}
	if len(s)%2 != 0 {
		return nil, fmt.Errorf("odd-length hex")
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(b)%32 != 0 {
		return nil, fmt.Errorf("data length %d is not a multiple of 32", len(b))
	}
	words := make([]*big.Int, 0, len(b)/32)
	for i := 0; i < len(b); i += 32 {
		words = append(words, new(big.Int).SetBytes(b[i:i+32]))
	}
	return words, nil
}

// needWords returns the first n words or an error — a known topic with too
// little data is a malformed event, not a different event.
func needWords(w []*big.Int, n int) ([]*big.Int, error) {
	if len(w) < n {
		return nil, fmt.Errorf("event has %d words, need %d", len(w), n)
	}
	return w[:n], nil
}

// dataWord returns the hex of topics[i], or "" when absent.
func dataWord(topics []string, i int) string {
	if i < 0 || i >= len(topics) {
		return ""
	}
	return topics[i]
}

// signedFromUint reads an unsigned ABI word.
func signedFromUint(w *big.Int) *big.Int {
	if w == nil {
		return big.NewInt(0)
	}
	return new(big.Int).Set(w)
}

// signedFromInt256 reads a two's-complement int256 word.
func signedFromInt256(w *big.Int) *big.Int {
	if w == nil {
		return big.NewInt(0)
	}
	// A word with the high bit (bit 255) set is negative: value - 2^256.
	if w.Bit(255) == 1 {
		return new(big.Int).Sub(w, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	return new(big.Int).Set(w)
}

// wordAddress turns a 32-byte topic into a 0x address (the low 20 bytes).
func wordAddress(t string) string {
	t = strings.TrimPrefix(strings.TrimSpace(t), "0x")
	if len(t) < 40 {
		return ""
	}
	return "0x" + strings.ToLower(t[len(t)-40:])
}

// parseUint64 parses a 0x-hex or decimal uint64.
func parseUint64(s string) (uint64, error) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, fmt.Errorf("empty")
	}
	base := 10
	if strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X") {
		t, base = t[2:], 16
	}
	n, ok := new(big.Int).SetString(t, base)
	if !ok || n.Sign() < 0 || !n.IsUint64() {
		return 0, fmt.Errorf("bad integer %q", s)
	}
	return n.Uint64(), nil
}
