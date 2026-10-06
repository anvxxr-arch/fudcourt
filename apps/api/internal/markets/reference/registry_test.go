package reference

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// mustBuild fails the test if the seeded registry does not build. Every test
// below starts here: a seed that cannot build is the only failure that would
// make the rest of the file meaningless.
func mustBuild(t *testing.T) *Reference {
	t.Helper()
	ref, err := Build()
	if err != nil {
		t.Fatalf("Build() failed: %v", err)
	}
	if ref == nil {
		t.Fatal("Build() returned a nil registry and no error")
	}
	return ref
}

// TestBuildIsPinnedToKnownIDs pins every id the registry mints.
//
// This is the test that makes the asset key's symbol-derivation SAFE. The
// package doc admits that an asset's natural key is symbol-derived (no issuer
// identity exists in the tree for a native coin), so the day the key rule
// changes - deliberately or by accident - every asset id changes. A pinned table
// turns that into a red test instead of a silent re-identification of every row
// in every store that already holds these ids.
//
// The ids are also asserted to be well-formed (kind prefix + exactly IDHexLen
// hex characters), so a change to the truncation length is caught here too.
func TestBuildIsPinnedToKnownIDs(t *testing.T) {
	ref := mustBuild(t)

	// key -> expected id, pinned from the emitted reference document.
	wantChains := map[string]string{
		"arbitrum":    "chain:ed300c94e8",
		"base":        "chain:2134e1468a",
		"bsc":         "chain:eb00d01a3f",
		"ethereum":    "chain:7904aa7bd5",
		"hyperliquid": "chain:4b722e1587",
		"offchain":    "chain:1f6d776400",
		"optimism":    "chain:aedf3dfecc",
		"polygon":     "chain:e8cd8ec319",
		"solana":      "chain:0f20652e45",
	}
	wantAssets := map[string]string{
		"BNB":  "asset:ac90e8ba70",
		"ETH":  "asset:d40acc5bec",
		"HYPE": "asset:8970196c37",
		"POL":  "asset:315d864f27",
		"SOL":  "asset:86543eb2b9",
		"USDC": "asset:db5d8a6884",
		"USDT": "asset:36fac0c5f6",
		"USD":  "asset:203460b647",
	}
	wantVenues := map[string]string{
		"binance":  "venue:a8792f9e11",
		"bybit":    "venue:31c421de01",
		"mexc":     "venue:2ce0dae260",
		"okx":      "venue:5d802f3da9",
		"bitget":   "venue:3f376f6c01",
		"phemex":   "venue:eff356b2f1",
		"bingx":    "venue:39b88c452c",
		"bitfinex": "venue:0e37eadf88",
		"htx":      "venue:a02f6e023d",
		"coinbase": "venue:4baaeae026",
		"kraken":   "venue:76e00b2757",
		"paper":    "venue:c3099dfa02",
	}

	gotChains := map[string]string{}
	for _, c := range ref.Chains {
		gotChains[c.Name] = c.ChainID
	}
	if err := comparePinned("chain", wantChains, gotChains); err != nil {
		t.Error(err)
	}
	gotAssets := map[string]string{}
	for _, a := range ref.Assets {
		gotAssets[a.Symbol] = a.AssetID
	}
	if err := comparePinned("asset", wantAssets, gotAssets); err != nil {
		t.Error(err)
	}
	// Built from the index's slug map, which is the single source of a venue's
	// tree-side id - iterating it is safe because it is only read by key here,
	// and comparePinned checks the whole set, not the order.
	gotVenues := map[string]string{}
	for id, slug := range ref.index.venueSlug {
		gotVenues[slug] = id
	}
	if err := comparePinned("venue", wantVenues, gotVenues); err != nil {
		t.Error(err)
	}

	// Token ids are pinned by (chain, address) because that is what they key on.
	wantTokens := map[string]string{
		"ethereum/0xdAC17F958D2ee523a2206206994597C13D831ec7": "token:0abccfbce5",
		"ethereum/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "token:9c49f5cc06",
		"bsc/0x55d398326f99059ff775485246999027b3197955":      "token:9903c27ae3",
		"bsc/0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d":      "token:222d15ae54",
		"polygon/0xc2132D05D31c914a87C6611C10748AEb04B58e8F":  "token:5a833fdba2",
		"polygon/0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174":  "token:a1519cb239",
		"arbitrum/0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9": "token:5d19129c11",
		"arbitrum/0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8": "token:b787aaa340",
		"optimism/0x94b008aA00579c1307B0EF2c499aD98a8ce58e58": "token:940fb67013",
		"optimism/0x7F5c764cBc14f9669B88837ca1490cCa17c31607": "token:3a60b22e37",
		"base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913":     "token:b6a8ce7016",
	}
	for _, tok := range ref.Tokens {
		// Resolve the chain name through the registry rather than guessing it.
		c, err := ref.Chain(tok.ChainID)
		if err != nil {
			t.Fatalf("token %s names chain %s which does not resolve: %v", tok.TokenID, tok.ChainID, err)
		}
		key := c.Name + "/" + tok.Address
		want, pinned := wantTokens[key]
		if !pinned {
			continue
		}
		if tok.TokenID != want {
			t.Errorf("token %s: id = %s, want %s (pinned)", key, tok.TokenID, want)
		}
		if err := assertWellFormedID(KindToken, tok.TokenID); err != nil {
			t.Errorf("token %s: %v", key, err)
		}
	}

	for kind, ids := range map[EntityKind]map[string]string{
		KindChain: wantChains, KindAsset: wantAssets, KindVenue: wantVenues,
	} {
		for key, id := range ids {
			if err := assertWellFormedID(kind, id); err != nil {
				t.Errorf("%s %s: %v", kind, key, err)
			}
		}
	}
}

func comparePinned(kind string, want, got map[string]string) error {
	var problems []string
	for key, expected := range want {
		actual, ok := got[key]
		if !ok {
			problems = append(problems, fmt.Sprintf("%s %s missing from the registry", kind, key))
			continue
		}
		if actual != expected {
			problems = append(problems, fmt.Sprintf("%s %s: id = %s, want %s (pinned)", kind, key, actual, expected))
		}
	}
	for key := range got {
		if _, ok := want[key]; !ok {
			problems = append(problems, fmt.Sprintf("%s %s is in the registry but not pinned", kind, key))
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("pinned ids drifted:\n  %s", strings.Join(problems, "\n  "))
	}
	return nil
}

func assertWellFormedID(kind EntityKind, id string) error {
	prefix, hex, ok := strings.Cut(id, ":")
	if !ok {
		return fmt.Errorf("id %q has no kind prefix", id)
	}
	if EntityKind(prefix) != kind {
		return fmt.Errorf("id %q is not a %s id", id, kind)
	}
	if len(hex) != IDHexLen {
		return fmt.Errorf("id %q keeps %d hex digits, want %d", id, len(hex), IDHexLen)
	}
	for _, r := range hex {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return fmt.Errorf("id %q has a non-lowercase-hex character %q", id, r)
		}
	}
	return nil
}

// TestMintIsDeterministicAndSaltSensitive proves the minting function is a pure
// function, and that the salt is load-bearing rather than decorative.
func TestMintIsDeterministicAndSaltSensitive(t *testing.T) {
	first := MintID(KindAsset, AssetKey(AssetNative, "eth"))
	for range 64 {
		if got := MintID(KindAsset, AssetKey("native", "ETH")); got != first {
			t.Fatalf("MintID is not deterministic: %s then %s", first, got)
		}
	}
	if got := MintID(KindAsset, AssetKey(AssetNative, "btc")); got == first {
		t.Errorf("two different natural keys minted the same id %s", got)
	}
	// Kind separation: the same natural key in two namespaces must not collide.
	key := "shared/natural/key"
	if MintID(KindAsset, key) == MintID(KindChain, key) {
		t.Errorf("the same key collides across namespaces: kind is not part of the hash input")
	}
	// A different salt must produce a different id, or the salt is not used.
	if MintIDWithSalt(KindAsset, AssetKey(AssetNative, "eth"), "other-salt") == first {
		t.Errorf("changing the salt did not change the id, so the salt is not hashed")
	}
}

// TestAddressKindMatchesTheRepoClassifier pins the three address families the
// tree classifies (frontend/web/src/features/dex/client.ts addressKind) and
// proves an unrecognizable string is REFUSED rather than guessed at.
func TestAddressKindMatchesTheRepoClassifier(t *testing.T) {
	ok := []struct {
		address string
		want    string
	}{
		{"0xdAC17F958D2ee523a2206206994597C13D831ec7", "hex"},
		{"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "hex"},
		{"7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP", "base58"},
		{"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "base58"},
		{"alice.near", "name"},
	}
	for _, tc := range ok {
		got, err := AddressKind(tc.address)
		if err != nil {
			t.Errorf("AddressKind(%q) refused a valid address: %v", tc.address, err)
			continue
		}
		if got != tc.want {
			t.Errorf("AddressKind(%q) = %q, want %q", tc.address, got, tc.want)
		}
	}
	// A truncated Solana label is not an address: this is the `SPL:<mint6>` case
	// the audit found, and it must be REFUSED, not silently classified.
	for _, bad := range []string{"", "0x1234", "SPL:7KMhEB", "not an address", "0xZZZ"} {
		if got, err := AddressKind(bad); err == nil {
			t.Errorf("AddressKind(%q) = %q with no error; a non-address must be refused", bad, got)
		}
	}
}

// TestResolveEverySeededProviderIdentifier walks the whole mapping table and
// proves every row resolves, from both directions: the id is findable via
// Resolve, and the entity it names exists under that id.
func TestResolveEverySeededProviderIdentifier(t *testing.T) {
	ref := mustBuild(t)
	if len(ref.Mappings) == 0 {
		t.Fatal("no mappings at all; the resolution table is empty")
	}
	for _, m := range ref.Mappings {
		got, err := ref.Resolve(m.Provider, m.ProviderID)
		if err != nil {
			t.Errorf("Resolve(%s, %q) failed for a seeded mapping: %v", m.Provider, m.ProviderID, err)
			continue
		}
		if got != m.CanonicalID {
			t.Errorf("Resolve(%s, %q) = %s, want %s", m.Provider, m.ProviderID, got, m.CanonicalID)
		}
		if _, err := ref.ByID(m.CanonicalID); err != nil {
			t.Errorf("mapping %s/%s names %s, which does not resolve: %v", m.Provider, m.ProviderID, m.CanonicalID, err)
		}
	}
}

// TestSchemaLegalProviderSpellingsResolve is the end-to-end test of the six
// provider identifiers that the tree itself states, expressed in the form a
// caller would actually use. Each row names where it comes from.
func TestSchemaLegalProviderSpellingsResolve(t *testing.T) {
	ref := mustBuild(t)
	cases := []struct {
		provider Provider
		id       string
		wantSym  string
		source   string
	}{
		{ProviderDefiLlama, "coingecko:ethereum", "ETH", "apps/reconciler/src/chains.rs LLAMA_IDS"},
		{ProviderDefiLlama, "coingecko:binancecoin", "BNB", "apps/reconciler/src/chains.rs LLAMA_IDS"},
		{ProviderDefiLlama, "coingecko:polygon-ecosystem-token", "POL", "apps/reconciler/src/chains.rs LLAMA_IDS"},
		{ProviderDefiLlama, "coingecko:solana", "SOL", "apps/reconciler/src/chains.rs LLAMA_IDS"},
		{ProviderDefiLlama, "coingecko:tether", "USDT", "apps/reconciler/src/chains.rs LLAMA_IDS"},
		{ProviderDefiLlama, "coingecko:usd-coin", "USDC", "apps/reconciler/src/chains.rs LLAMA_IDS"},
		{ProviderCryptoRank, "bitcoin", "BTC", "tests/fixtures/coins.json.gz (moved from frontend/web/scripts/fixtures/ by fd17dc6; row exists; asset not seeded - see the miss list)"},
	}
	for _, tc := range cases {
		id, err := ref.Resolve(tc.provider, tc.id)
		if tc.wantSym == "BTC" {
			// The coin row exists in the fixture but BTC is not a registry
			// member: the refusal is the correct outcome and is asserted below
			// by TestRefusesUnknownIdentifiers. Skip rather than pretend.
			continue
		}
		if err != nil {
			t.Errorf("Resolve(%s, %q) [%s] failed: %v", tc.provider, tc.id, tc.source, err)
			continue
		}
		a, err := ref.Asset(id)
		if err != nil {
			t.Errorf("Resolve(%s, %q) returned %s, which is not an asset: %v", tc.provider, tc.id, id, err)
			continue
		}
		if a.Symbol != tc.wantSym {
			t.Errorf("Resolve(%s, %q) = asset %s, want %s", tc.provider, tc.id, a.Symbol, tc.wantSym)
		}
	}
}

// TestMaticResolvesToThePolAsset is the audit's leak (a): the sync labels the
// Polygon native balance MATIC while the registry says POL. One canonical asset,
// two spellings - never two assets.
func TestMaticResolvesToThePolAsset(t *testing.T) {
	ref := mustBuild(t)

	pol, err := ref.Resolve(ProviderInternal, "MATIC")
	if err != nil {
		t.Fatalf("the sync's MATIC label does not resolve: %v", err)
	}
	bySlug, err := ref.Resolve(ProviderCoinGecko, "polygon-ecosystem-token")
	if err != nil {
		t.Fatalf("the POL price id does not resolve: %v", err)
	}
	if pol != bySlug {
		t.Fatalf("MATIC and the POL price id resolve to different assets: %s vs %s", pol, bySlug)
	}
	asset, err := ref.Asset(pol)
	if err != nil {
		t.Fatal(err)
	}
	if asset.Symbol != "POL" {
		t.Errorf("the shared asset is %s, want POL", asset.Symbol)
	}
	// There is exactly ONE seeded asset whose symbol is POL or MATIC: a second
	// one would be the duplicate the audit warned about.
	var matches []string
	for _, a := range ref.Assets {
		if a.Symbol == "POL" || a.Symbol == "MATIC" {
			matches = append(matches, a.Symbol)
		}
	}
	if len(matches) != 1 {
		t.Errorf("seeded assets with symbol POL/MATIC = %v, want exactly one", matches)
	}
	// And the chain's native asset is that same asset.
	chain, err := ref.ChainByName("polygon")
	if err != nil {
		t.Fatal(err)
	}
	if chain.NativeAssetID == nil || *chain.NativeAssetID != pol {
		t.Errorf("polygon's native asset = %v, want %s", chain.NativeAssetID, pol)
	}
	// The label itself is a spelling, not an entity: asking for MATIC as a
	// SYMBOL must not resolve, because nothing is keyed by it.
	if _, err := ref.Asset(MintID(KindAsset, AssetKey(AssetNative, "MATIC"))); err == nil {
		t.Error("a MATIC-keyed asset exists; the label was allowed to become an entity")
	}
}

// TestSplTruncationCannotBecomeATokenID is the audit's leak (b): the sync prints
// `SPL:<first six characters of the mint>`. That is a DISPLAY label, so it must
// fail to resolve as a token rather than silently naming the wrong one.
func TestSplTruncationCannotBecomeATokenID(t *testing.T) {
	ref := mustBuild(t)

	const mint = "7KMhEBFjmhhC1B2HqaJC7zvkyx9pJ9ryCXqUnGBThgFP"
	truncated := "SPL:" + mint[:6]

	// The truncated label is not an address at all.
	if got, err := AddressKind(mint[:6]); err == nil {
		t.Errorf("the 6-character prefix %q was classified as %q; it is not an address", mint[:6], got)
	}
	// And it is not a token on solana (nor a chain).
	if tok, err := ref.TokenByAddress("solana", truncated); err == nil {
		t.Errorf("the truncated label resolved to token %s", tok.TokenID)
	}
	// The FULL mint is a well-formed address: this is what a correct producer
	// must send, so the refusal above is about truncation, not about Solana.
	if got, err := AddressKind(mint); err != nil || got != "base58" {
		t.Errorf("the full mint classified as (%q, %v), want (base58, nil)", got, err)
	}
	// A well-formed full mint is still unknown here, because the sync discarded
	// it before any durable write - and that is a REFUSAL, not an empty answer.
	if _, err := ref.TokenByAddress("solana", mint); err == nil {
		t.Error("a full mint resolved; no Solana token is seeded, so it must be refused")
	} else if !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("unseeded mint gave %v, want ErrUnknownEntity", err)
	}
	// The miss list must say so, so a consumer is not left guessing.
	var found bool
	for _, m := range ref.Misses {
		if m.Provider == ProviderOnchain && strings.Contains(m.ReportedAs, "SPL:") {
			found = true
			if !m.KnownAbsence {
				t.Error("the SPL miss is not marked as a known absence")
			}
		}
	}
	if !found {
		t.Error("the SPL truncation is not recorded in the miss list")
	}
}

// TestFullMintSurvivesWhenTheTreeHasIt proves the (chain, address) rule on the
// deployments the tree DOES carry: the eleven EVM tokens, addressed verbatim.
func TestFullMintSurvivesWhenTheTreeHasIt(t *testing.T) {
	ref := mustBuild(t)
	if len(ref.Tokens) == 0 {
		t.Fatal("no tokens seeded")
	}
	for _, tok := range ref.Tokens {
		chain, err := ref.Chain(tok.ChainID)
		if err != nil {
			t.Fatalf("token %s: %v", tok.TokenID, err)
		}
		// Look up by the FULL address and the chain's canonical name.
		got, err := ref.TokenByAddress(chain.Name, tok.Address)
		if err != nil {
			t.Errorf("TokenByAddress(%s, %s) failed for a seeded token: %v", chain.Name, tok.Address, err)
			continue
		}
		if got.TokenID != tok.TokenID {
			t.Errorf("TokenByAddress(%s, %s) = %s, want %s", chain.Name, tok.Address, got.TokenID, tok.TokenID)
		}
		// The address is stored verbatim: a case-folded copy must not resolve,
		// because the stored form is the identity.
		if lowered := strings.ToLower(tok.Address); lowered != tok.Address {
			if folded, err := ref.TokenByAddress(chain.Name, lowered); err == nil && folded.TokenID == tok.TokenID {
				t.Errorf("TokenByAddress matched %s by case-folding the seeded %s", lowered, tok.Address)
			}
		}
		if tok.AssetID == nil {
			t.Errorf("token %s has no asset link", tok.TokenID)
		} else if _, err := ref.Asset(*tok.AssetID); err != nil {
			t.Errorf("token %s links asset %s which does not resolve: %v", tok.TokenID, *tok.AssetID, err)
		}
	}
}

// TestUniqueness proves no two distinct entities share an id and no id resolves
// to two entities - the property the whole registry rests on.
func TestUniqueness(t *testing.T) {
	ref := mustBuild(t)

	seen := map[string]string{} // id -> what minted it
	add := func(id, who string) {
		t.Helper()
		if prev, dup := seen[id]; dup {
			t.Errorf("id %s is shared by %s and %s", id, prev, who)
			return
		}
		seen[id] = who
	}
	for _, c := range ref.Chains {
		add(c.ChainID, "chain "+c.Name)
	}
	for _, a := range ref.Assets {
		add(a.AssetID, "asset "+a.Symbol)
	}
	for _, tk := range ref.Tokens {
		add(tk.TokenID, "token "+tk.Address)
	}
	for _, v := range ref.Venues {
		add(v.VenueID, "venue "+v.VenueID)
	}

	// An id must resolve to exactly one entity, through every entry point.
	for id := range seen {
		first, err := ref.ByID(id)
		if err != nil {
			t.Errorf("ByID(%s) failed for a registered id: %v", id, err)
			continue
		}
		second, err := ref.ByID(id)
		if err != nil {
			t.Errorf("ByID(%s) failed on the second call: %v", id, err)
			continue
		}
		if fmt.Sprintf("%v", first) != fmt.Sprintf("%v", second) {
			t.Errorf("ByID(%s) is not stable", id)
		}
	}

	// Distinct assets must not share a symbol, and distinct chains a name.
	bySymbol := map[string]string{}
	for _, a := range ref.Assets {
		if prev, dup := bySymbol[a.Symbol]; dup {
			t.Errorf("symbol %s is used by both %s and %s", a.Symbol, prev, a.AssetID)
		}
		bySymbol[a.Symbol] = a.AssetID
	}
	byName := map[string]string{}
	for _, c := range ref.Chains {
		if prev, dup := byName[c.Name]; dup {
			t.Errorf("chain name %s is used by both %s and %s", c.Name, prev, c.ChainID)
		}
		byName[c.Name] = c.ChainID
	}
}

// TestRefusesUnknownIdentifiers is the anti-guessing property, spelled out. A
// registry that resolves a typo is worse than one that refuses, because the typo
// silently attributes data to the wrong asset.
func TestRefusesUnknownIdentifiers(t *testing.T) {
	ref := mustBuild(t)

	unknownIdentifiers := []struct {
		p  Provider
		id string
	}{
		{ProviderCryptoRank, "bitcoin"},  // real coin, real provider, not a registry member
		{ProviderCryptoRank, "dogecoin"}, // ditto
		{ProviderCoinGecko, "ethereum-2"},
		{ProviderDefiLlama, "coingecko:not-a-coin"},
		{ProviderInternal, "MATIC "},   // trailing space: trimming must not invent an id
		{ProviderInternal, "matic"},    // the label is uppercase in the tree
		{ProviderCoinGecko, "ETH"},     // a symbol is not a provider identifier
		{ProviderCoinGecko, "bitcoin"}, // CoinGecko's slug is the value we store, not the CryptoRank key
	}
	for _, tc := range unknownIdentifiers {
		got, err := ref.Resolve(tc.p, tc.id)
		if err == nil {
			t.Errorf("Resolve(%s, %q) = %s with no error; an unknown identifier must be refused", tc.p, tc.id, got)
			continue
		}
		if !errors.Is(err, ErrUnknownIdentifier) {
			t.Errorf("Resolve(%s, %q) = %v, want ErrUnknownIdentifier", tc.p, tc.id, err)
		}
		if got != "" {
			t.Errorf("Resolve(%s, %q) returned a non-empty id %q alongside an error", tc.p, tc.id, got)
		}
	}

	// An unknown PROVIDER is a different refusal.
	for _, p := range []Provider{"", "binance", "coingeko", "CRYPTORANK"} {
		if _, err := ref.Resolve(p, "ethereum"); !errors.Is(err, ErrUnknownProvider) {
			t.Errorf("Resolve(%q, ...) = %v, want ErrUnknownProvider", p, err)
		}
	}

	// Unknown ids, names and addresses.
	if _, err := ref.Asset("asset:ffffffffffff"); !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("Asset(unknown) = %v, want ErrUnknownEntity", err)
	}
	if _, err := ref.Chain("5a5a1a8f36"); !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("Chain(prefix-less id) = %v, want ErrUnknownEntity", err)
	}
	if _, err := ref.ChainByName("Ethereum"); err != nil {
		t.Errorf("ChainByName(Ethereum) = %v; the lookup deliberately normalizes case so a caller holding a display name is not punished", err)
	} else if c, _ := ref.ChainByName("Ethereum"); c.Name != "ethereum" {
		t.Errorf("ChainByName(Ethereum) returned name %q, want the canonical lowercase %q", c.Name, "ethereum")
	}
	if _, err := ref.ChainByName("not-a-chain"); !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("ChainByName(not-a-chain) = %v, want ErrUnknownEntity", err)
	}
	if _, err := ref.Venue("venue:0000000000"); !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("Venue(unknown) = %v, want ErrUnknownEntity", err)
	}
	if _, err := ref.TokenByAddress("ethereum", "0x0000000000000000000000000000000000000000"); !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("TokenByAddress(zero address) = %v, want ErrUnknownEntity", err)
	}
	if _, err := ref.TokenByAddress("not-a-chain", "0x00"); !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("TokenByAddress(unknown chain) = %v, want ErrUnknownEntity", err)
	}
	// A kind prefix that no namespace owns.
	if _, err := ref.ByID("coin:deadbeef"); !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("ByID(coin:...) = %v, want ErrUnknownEntity", err)
	}
	if _, err := ref.ByID("noprefix"); !errors.Is(err, ErrUnknownEntity) {
		t.Errorf("ByID(noprefix) = %v, want ErrUnknownEntity", err)
	}
}

// TestNilRegistryRefuses proves the zero value is safe: a nil or empty registry
// refuses everything rather than panicking or returning an empty id.
func TestNilRegistryRefuses(t *testing.T) {
	var ref *Reference
	if _, err := ref.Resolve(ProviderCoinGecko, "ethereum"); err == nil {
		t.Error("a nil registry resolved an identifier")
	}
	if _, err := ref.Asset("asset:x"); err == nil {
		t.Error("a nil registry returned an asset")
	}
	if _, err := ref.Token("token:x"); err == nil {
		t.Error("a nil registry returned a token")
	}
	if _, err := ref.Chain("chain:x"); err == nil {
		t.Error("a nil registry returned a chain")
	}
	if _, err := ref.Venue("venue:x"); err == nil {
		t.Error("a nil registry returned a venue")
	}
	if _, err := ref.ChainByName("ethereum"); err == nil {
		t.Error("a nil registry returned a chain by name")
	}
	if _, err := ref.TokenByAddress("ethereum", "0x0"); err == nil {
		t.Error("a nil registry returned a token by address")
	}
	if _, err := ref.ByID("asset:x"); err == nil {
		t.Error("a nil registry resolved an id")
	}
	if err := ref.Emit(&strings.Builder{}); err == nil {
		t.Error("a nil registry emitted a document")
	}
}
