package evmrpc

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
)

// The four event topics the adapter recognises. All four are pinned to values
// observed on Ethereum mainnet rather than computed at init: a topic0 is
// keccak256 of the event signature, and a typo in a signature string would
// silently produce a topic that matches nothing. Verified live against
// 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 (Uniswap V3 USDC/WETH 0.05%),
// 0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc (Uniswap V2 USDC/WETH),
// 0x1F98431c8aD98523631AE4a59f267346ea31F984 (Uniswap V3 factory) and
// 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f (Uniswap V2 factory).
const (
	// TopicV2Swap is Swap(address,address,uint256,uint256,uint256,uint256,address)
	// on a Uniswap-V2-family pair. Topics: [topic0, sender, to]; data: four
	// uint256 - amount0In, amount1In, amount0Out, amount1Out.
	TopicV2Swap = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
	// TopicV3Swap is Swap(address,address,int256,int256,uint160,uint128) on a
	// concentrated-liquidity pool. Topics: [topic0, sender, recipient]; data:
	// amount0, amount1 (SIGNED), sqrtPriceX96, liquidity, tick.
	TopicV3Swap = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
	// TopicV2PairCreated is PairCreated(address,address,address,uint256).
	// Topics: [topic0, token0, token1, pair]; data: uint256 pair index.
	TopicV2PairCreated = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9"
	// TopicV3PoolCreated is PoolCreated(address,address,uint24,int24,address).
	// Topics: [topic0, token0, token1, fee]; data: int24 tickSpacing, address pool.
	TopicV3PoolCreated = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"
)

// blockHeader is the subset of eth_getBlockByNumber's result the adapter reads.
// Unmodelled fields are dropped on decode rather than kept as an opaque map, so
// a node's extra fields cannot leak into canonical storage.
type blockHeader struct {
	Number        string `json:"number"`
	Hash          string `json:"hash"`
	ParentHash    string `json:"parentHash"`
	Timestamp     string `json:"timestamp"`
	GasUsed       string `json:"gasUsed"`
	GasLimit      string `json:"gasLimit"`
	BaseFeePerGas string `json:"baseFeePerGas"` // absent before EIP-1559 -> ""
	Miner         string `json:"miner"`
}

// logEntry is one eth_getLogs result row.
type logEntry struct {
	Address          string   `json:"address"`
	Topics           []string `json:"topics"`
	Data             string   `json:"data"`
	BlockNumber      string   `json:"blockNumber"`
	BlockHash        string   `json:"blockHash"`
	TransactionHash  string   `json:"transactionHash"`
	TransactionIndex string   `json:"transactionIndex"`
	LogIndex         string   `json:"logIndex"`
	// Removed marks a log orphaned by a reorg. A removed log is NOT dropped
	// silently: the caller must decide whether to invalidate or rescan, and
	// storing it as if canonical is how a reorg becomes a permanent wrong row.
	Removed bool `json:"removed"`
}

// V2Swap is a decoded Uniswap-V2-family Swap event. The four amounts are
// uint256 (unsigned) because a V2 pair reports in/out legs, not a signed delta.
type V2Swap struct {
	Sender     string
	To         string
	Amount0In  *big.Int
	Amount1In  *big.Int
	Amount0Out *big.Int
	Amount1Out *big.Int
}

// V3Swap is a decoded concentrated-liquidity Swap event. Amount0/Amount1 are
// SIGNED: a negative amount means the pool paid that token out. Tick is signed
// too, and sqrtPriceX96 is kept as an integer because re-parsing it into
// binary64 loses the digits the contract published.
type V3Swap struct {
	Sender       string
	Recipient    string
	Amount0      *big.Int
	Amount1      *big.Int
	SqrtPriceX96 *big.Int
	Liquidity    *big.Int
	Tick         *big.Int
}

// PoolCreated is a decoded pool/pair creation event, the discovery signal the
// plan's §27 pipeline consumes.
type PoolCreated struct {
	Token0 string
	Token1 string
	Pool   string
	// FeeUnits is the V3 fee in hundredths of a bip - 500 is 0.05%, which is
	// 5 bps, NOT 500. Nil on V2, which encodes its fee implicitly (30 bps) and
	// emits no field at all. Use FeeBps to convert; do not compare this to
	// data.pool.fee_tier_bps without it.
	FeeUnits *int
	// TickSpacing is the V3 pool's tick spacing; nil on V2.
	TickSpacing *int
	// PairIndex is the V2 pair's creation index; nil on V3.
	PairIndex *big.Int
}

// FeeBps converts FeeUnits to basis points, the unit data.pool.fee_tier_bps
// uses. ok is false on a V2 pool, where the event carries no fee: V2's fee is a
// property of the pair implementation (30 bps), not of the event, so inventing
// one here would be a guess.
func (p PoolCreated) FeeBps() (int, bool) {
	if p.FeeUnits == nil {
		return 0, false
	}
	return *p.FeeUnits / 100, true
}

// decodeV3Swap decodes a concentrated-liquidity Swap log. The shape is
// validated before any arithmetic: a log whose topic count or data length does
// not match is a shape error, never a partially populated struct.
func decodeV3Swap(l logEntry) (*V3Swap, error) {
	if len(l.Topics) != 3 {
		return nil, fmt.Errorf("v3 swap: want 3 topics, got %d", len(l.Topics))
	}
	// Five 32-byte words: amount0, amount1, sqrtPriceX96, liquidity, tick.
	words, err := dataWords(l.Data, 5)
	if err != nil {
		return nil, fmt.Errorf("v3 swap: %w", err)
	}
	return &V3Swap{
		Sender:       topicAddress(l.Topics[1]),
		Recipient:    topicAddress(l.Topics[2]),
		Amount0:      twosComplement(words[0]),
		Amount1:      twosComplement(words[1]),
		SqrtPriceX96: new(big.Int).SetBytes(words[2]),
		Liquidity:    new(big.Int).SetBytes(words[3]),
		Tick:         twosComplement(words[4]),
	}, nil
}

// decodeV2Swap decodes a V2-family Swap log. All four amounts are unsigned, so
// no sign handling applies - treating them as signed is how a large reserve
// amount silently becomes a negative.
func decodeV2Swap(l logEntry) (*V2Swap, error) {
	if len(l.Topics) != 3 {
		return nil, fmt.Errorf("v2 swap: want 3 topics, got %d", len(l.Topics))
	}
	words, err := dataWords(l.Data, 4)
	if err != nil {
		return nil, fmt.Errorf("v2 swap: %w", err)
	}
	return &V2Swap{
		Sender:     topicAddress(l.Topics[1]),
		To:         topicAddress(l.Topics[2]),
		Amount0In:  new(big.Int).SetBytes(words[0]),
		Amount1In:  new(big.Int).SetBytes(words[1]),
		Amount0Out: new(big.Int).SetBytes(words[2]),
		Amount1Out: new(big.Int).SetBytes(words[3]),
	}, nil
}

// decodeV2PairCreated decodes PairCreated. The pair address is the third
// indexed topic, not a data word.
func decodeV2PairCreated(l logEntry) (*PoolCreated, error) {
	if len(l.Topics) != 4 {
		return nil, fmt.Errorf("v2 pair created: want 4 topics, got %d", len(l.Topics))
	}
	words, err := dataWords(l.Data, 1)
	if err != nil {
		return nil, fmt.Errorf("v2 pair created: %w", err)
	}
	return &PoolCreated{
		Token0:    topicAddress(l.Topics[1]),
		Token1:    topicAddress(l.Topics[2]),
		Pool:      topicAddress(l.Topics[3]),
		PairIndex: new(big.Int).SetBytes(words[0]),
	}, nil
}

// decodeV3PoolCreated decodes PoolCreated. fee is indexed; the two data words
// are tickSpacing and the pool address, in that order - the pool address is NOT
// an indexed topic on this event, which is the opposite of V2's PairCreated and
// the single easiest way to decode this event into the wrong address.
func decodeV3PoolCreated(l logEntry) (*PoolCreated, error) {
	if len(l.Topics) != 4 {
		return nil, fmt.Errorf("v3 pool created: want 4 topics, got %d", len(l.Topics))
	}
	words, err := dataWords(l.Data, 2)
	if err != nil {
		return nil, fmt.Errorf("v3 pool created: %w", err)
	}
	fee, ok := topicInt(l.Topics[3])
	if !ok {
		return nil, fmt.Errorf("v3 pool created: unparseable fee topic %q", l.Topics[3])
	}
	ts, ok := intFromWord(words[0])
	if !ok {
		return nil, fmt.Errorf("v3 pool created: tickSpacing out of range")
	}
	return &PoolCreated{
		Token0:      topicAddress(l.Topics[1]),
		Token1:      topicAddress(l.Topics[2]),
		Pool:        "0x" + hex.EncodeToString(words[1][12:]),
		FeeUnits:    &fee,
		TickSpacing: &ts,
	}, nil
}

// dataWords splits a log's data blob into n 32-byte words, enforcing the exact
// length. A short blob is rejected rather than zero-padded: a zero-padded
// amount is a fabricated number, and this is the boundary where a provider's
// truncation would otherwise become canonical data.
func dataWords(data string, n int) ([][]byte, error) {
	raw, err := hexBytes(data)
	if err != nil {
		return nil, err
	}
	want := n * 32
	if len(raw) != want {
		return nil, fmt.Errorf("data: want %d bytes for %d words, got %d", want, n, len(raw))
	}
	words := make([][]byte, n)
	for i := range words {
		words[i] = raw[i*32 : (i+1)*32]
	}
	return words, nil
}

// twosComplement reads a 32-byte word as a signed int256. Values above
// 2^255-1 are negative, which is how a V3 swap reports the token it paid out.
func twosComplement(w []byte) *big.Int {
	v := new(big.Int).SetBytes(w)
	if len(w) == 32 && w[0]&0x80 != 0 {
		// Negative: v - 2^256.
		v.Sub(v, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	return v
}

// topicAddress reads the low 20 bytes of a 32-byte indexed address topic.
func topicAddress(topic string) string {
	raw, err := hexBytes(topic)
	if err != nil || len(raw) != 32 {
		return ""
	}
	return "0x" + hex.EncodeToString(raw[12:])
}

// topicInt reads a 32-byte indexed topic as an int (a uint24 fee fits).
func topicInt(topic string) (int, bool) {
	raw, err := hexBytes(topic)
	if err != nil || len(raw) != 32 {
		return 0, false
	}
	return intFromWord(raw)
}

// intFromWord reads a 32-byte word as an int, refusing values that would not
// fit. A tickSpacing or fee is small; a value that overflows is a shape error,
// not something to truncate.
func intFromWord(w []byte) (int, bool) {
	v := new(big.Int).SetBytes(w)
	if !v.IsInt64() {
		return 0, false
	}
	n := v.Int64()
	if int64(int(n)) != n {
		return 0, false
	}
	return int(n), true
}

// hexBytes decodes a 0x-prefixed hex string.
func hexBytes(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "0x") && !strings.HasPrefix(s, "0X") {
		return nil, fmt.Errorf("not a 0x hex string")
	}
	body := s[2:]
	if len(body)%2 != 0 {
		return nil, fmt.Errorf("odd-length hex string")
	}
	return hex.DecodeString(body)
}
