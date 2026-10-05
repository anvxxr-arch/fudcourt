package reference

import (
	"fmt"
	"sort"
	"strings"
)

// Salt is the domain-separation string every id is minted under. Changing it
// changes every id in the registry, which is why it is exported: a consumer that
// wants to verify an id independently can re-derive it, and a test asserts that
// changing the salt changes the ids (so an accidental edit is caught).
const Salt = "fudcourt/canonical-reference/v1"

// salt is the internal copy the minting function uses.
const salt = Salt

// Reference is the whole reference set: the canonical entities plus the
// provider identifier table that resolves into them.
//
// It is deliberately a plain value with exported read paths and NO setters: the
// only two ways to obtain one are Build (from seeds) and Load (from the emitted
// document), so every instance in existence has been validated.
type Reference struct {
	Chains []Chain
	Assets []Asset
	Tokens []Token
	Venues []Venue
	// Mappings is every (provider, provider_id) -> canonical_id row, sorted.
	Mappings []Mapping
	// Misses is the deterministic set of identifiers this build KNOWS OF but has
	// no canonical entity for, sorted. It exists so an omission is AUDITABLE: a
	// consumer wiring a producer can look at a built document and see exactly
	// which upstream ids it will have to add. A seeded miss is dropped
	// automatically once a mapping for it exists, so the list cannot go stale.
	Misses []Miss
	// index is the derived lookup structure; unexported so it never round-trips.
	index *indexes
}

// Mapping is one resolution row: a provider identifier and the canonical entity
// it denotes.
type Mapping struct {
	Provider   Provider `json:"provider"`
	ProviderID string   `json:"provider_id"`
	// CanonicalID is the entity id this identifier resolves to. Its kind prefix
	// says which slice of Reference holds the entity.
	CanonicalID string `json:"canonical_id"`
}

// Miss is one identifier this build knows of but has no canonical entity for: a
// real upstream id the tree provides (or a documented absence) that will be
// REFUSED by Resolve. A miss is dropped automatically once a mapping for the
// same (provider, provider_id) exists, so the list cannot go stale.
type Miss struct {
	// Kind is the entity namespace the identifier would resolve into
	// ("asset" | "token" | "chain" | "venue").
	Kind       string   `json:"kind"`
	Provider   Provider `json:"provider"`
	ProviderID string   `json:"provider_id"`
	// Reason is why it is unresolved, and ReportedAs is the label a producer
	// would actually present (the truncated `SPL:<mint6>` label, say) so a
	// consumer can recognise it in the wire data.
	Reason     string `json:"reason"`
	ReportedAs string `json:"reported_as"`
	// KnownAbsence marks an identifier nobody can currently supply because the
	// tree itself stores it lossily; the rest are simply not registered yet.
	KnownAbsence bool `json:"known_absence"`
}

// indexes is the derived lookup structure. It is never serialized.
type index = indexes

type indexes struct {
	chains map[string]*Chain // chain_id -> chain
	assets map[string]*Asset // asset_id -> asset
	tokens map[string]*Token // token_id -> token
	venues map[string]*Venue // venue_id -> venue
	byName map[string]*Chain // canonical lowercase chain name -> chain
	// resolve is keyed "provider\x00provider_id".
	resolve map[string]string
	// venueSlug maps a minted venue id back to the venue id the TREE uses, so
	// the mapping table and the document never have to re-derive a label.
	venueSlug map[string]string
}

func mappingKey(p Provider, id string) string {
	return string(p) + "\x00" + id
}

// Build seeds, validates and orders a registry. It is deterministic: the same
// seed order produces byte-identical slices and ids, and so does a shuffled
// insertion order (nothing here depends on map iteration order - every map is
// only ever read by key, and every slice is sorted explicitly at the end).
//
// It refuses rather than repairs:
//   - an unknown enum value, a missing reference, or an address it cannot
//     classify (ErrInvalidSeed);
//   - two entities minting the same id, or two mapping rows claiming the same
//     provider identifier (ErrDuplicateID) - a collision is surfaced, never
//     silently merged;
//   - a provider that the asset/chain contract does not allow inside an embedded
//     provider_ids list, if it appears there (ErrInvalidSeed).
func Build() (*Reference, error) {
	return buildFrom(seedChains, seedAssets, seedTokens, seedVenues, nil)
}

// buildFrom is Build with the seed tables injected, so a test can corrupt one
// table and prove the validation actually fires.
func buildFrom(
	chainsFn func() []seedChain,
	assetsFn func() []seedAsset,
	tokensFn func() []seedToken,
	venuesFn func() []seedVenue,
	extraMappings []Mapping,
) (*Reference, error) {
	ref := &Reference{}
	// seedChainByName is a SEED-TIME lookup (chain name -> chain) used only for
	// validating references while the seeds are being built. It is deliberately
	// separate from the registry index, which is built from the final sorted
	// slices: the seeding pass runs before any sort, so it sees the seed order.
	seedChainByName := map[string]*Chain{}
	assetBySymbol := map[string]*Asset{}
	assetIDBySymbol := map[string]string{}
	// venueSlug/venueCCXT carry each venue's id in the vocabulary the TREE uses,
	// keyed by minted id, so the mapping table never has to re-derive a label.
	venueSlug := map[string]string{}
	venueCCXT := map[string]string{}
	// assetMappingsByID / chainMappingsByID hold the MAPPING-ONLY provider pairs
	// (providers outside the asset/chain schema enum: ccxt, internal), keyed by
	// minted id so they reach the resolution table without entering an entity.
	assetMappingsByID := map[string][]string{}
	chainMappingsByID := map[string][]string{}
	// chainNativeSymbol carries each chain's native asset SYMBOL (from the seed),
	// so the native asset is resolved by symbol rather than by a per-chain claim.
	chainNativeSymbol := map[string]string{}

	// --- chains ------------------------------------------------------------
	seenChainName := map[string]bool{}
	seenChainID := map[string]bool{}
	for _, sc := range chainsFn() {
		name := strings.ToLower(strings.TrimSpace(sc.name))
		if name == "" {
			return nil, fmt.Errorf("%w: chain with empty name", ErrInvalidSeed)
		}
		if seenChainName[name] {
			return nil, fmt.Errorf("%w: chain name %q seeded twice", ErrDuplicateID, name)
		}
		seenChainName[name] = true
		if !sc.kind.Valid() {
			return nil, fmt.Errorf("%w: chain %q has unknown kind %q", ErrInvalidSeed, name, sc.kind)
		}
		c := Chain{
			ChainID:     MintID(KindChain, ChainKey(name)),
			Name:        name,
			Kind:        sc.kind,
			DisplayName: optString(sc.displayName),
		}
		if seenChainID[c.ChainID] {
			return nil, fmt.Errorf("%w: chain id %s minted twice (%s)", ErrDuplicateID, c.ChainID, invalidNodeDump(KindChain, name))
		}
		seenChainID[c.ChainID] = true
		if c.DisplayName == nil || *c.DisplayName == "" {
			// A display name is optional in the schema, but every seeded chain
			// has one; dropping it silently would make the JSON harder to read.
			display := name
			c.DisplayName = &display
		}
		providers, err := parseProviders(sc.providers)
		if err != nil {
			return nil, fmt.Errorf("chain %s: %w", name, err)
		}
		c.ProviderIDs = providers
		chainMappingsByID[c.ChainID] = append([]string(nil), sc.mappings...)
		if sc.nativeSym != "" {
			chainNativeSymbol[c.Name] = strings.ToUpper(strings.TrimSpace(sc.nativeSym))
		}
		ref.Chains = append(ref.Chains, c)
		seedChainByName[c.Name] = &ref.Chains[len(ref.Chains)-1]
	}

	// A native asset id must be resolved AFTER assets exist, so the chains are
	// patched keyed by the native SYMBOL: ETH is the native
	// asset of four chains at once, so one asset id legitimately backs several
	// chains and "first chain to claim it" is not the rule - the symbol is.
	// Keying by chain name would have been wrong here (and the earlier draft did
	// exactly that).

	// --- assets ------------------------------------------------------------
	// An asset that is native on MORE THAN ONE chain spans chains, and the
	// contract says so explicitly: "Null for off-chain assets (USD) and for an
	// asset that spans chains (its Tokens carry the chain)". ETH on
	// ethereum+arbitrum+optimism+base is exactly that case, so its home chain is
	// derived from the native map rather than asserted by the seed, and the seed
	// cannot get it wrong.
	nativeChains := map[string]int{}
	for _, sc := range chainsFn() {
		if sc.nativeSym == "" {
			continue
		}
		nativeChains[strings.ToUpper(strings.TrimSpace(sc.nativeSym))]++
	}
	seenAssetID := map[string]bool{}
	for _, sa := range assetsFn() {
		sym := strings.ToUpper(strings.TrimSpace(sa.symbol))
		if sym == "" {
			return nil, fmt.Errorf("%w: asset with empty symbol", ErrInvalidSeed)
		}
		if !sa.kind.Valid() {
			return nil, fmt.Errorf("%w: asset %q has unknown kind %q", ErrInvalidSeed, sym, sa.kind)
		}
		if _, dup := assetBySymbol[sym]; dup {
			return nil, fmt.Errorf("%w: asset symbol %q seeded twice", ErrDuplicateID, sym)
		}
		a := Asset{
			AssetID: MintID(KindAsset, AssetKey(sa.kind, sym)),
			Symbol:  sym,
			Kind:    sa.kind,
			Name:    optString(sa.name),
		}
		if seenAssetID[a.AssetID] {
			return nil, fmt.Errorf("%w: asset id %s minted twice (%s)", ErrDuplicateID, a.AssetID, invalidNodeDump(KindAsset, sym))
		}
		seenAssetID[a.AssetID] = true
		if strings.ToUpper(strings.TrimSpace(sa.symbol)) == "ETH" && nativeChains["ETH"] > 1 && sa.chainName != "" {
			return nil, fmt.Errorf("%w: asset ETH is native on %d chains and must be seeded with no home chain (the contract's spanning-chain rule)",
				ErrInvalidSeed, nativeChains["ETH"])
		}
		if sa.chainName != "" {
			chain, ok := seedChainByName[strings.ToLower(strings.TrimSpace(sa.chainName))]
			if !ok {
				return nil, fmt.Errorf("%w: asset %s refers to chain %q which is not seeded", ErrInvalidSeed, sym, sa.chainName)
			}
			a.ChainID = optString(chain.ChainID)
		}
		providers, err := parseProviders(sa.providers)
		if err != nil {
			return nil, fmt.Errorf("asset %s: %w", sym, err)
		}
		a.ProviderIDs = providers
		assetMappingsByID[a.AssetID] = append([]string(nil), sa.mappings...)
		assetBySymbol[sym] = &a
		assetIDBySymbol[sym] = a.AssetID
		ref.Assets = append(ref.Assets, a)
	}
	// Patch every chain's native_asset_id from its native SYMBOL, then check the
	// claim is coherent: the asset must exist, and it must really be a native
	// asset of that chain (or a chain-agnostic native asset, which is the case
	// for ETH on four chains).
	for i := range ref.Chains {
		c := &ref.Chains[i]
		sym := chainNativeSymbol[strings.ToLower(c.Name)]
		if sym == "" {
			continue
		}
		a, ok := assetBySymbol[sym]
		if !ok {
			return nil, fmt.Errorf("%w: chain %q names native asset %q which is not seeded", ErrInvalidSeed, c.Name, sym)
		}
		if a.Kind != AssetNative {
			return nil, fmt.Errorf("%w: chain %q native asset %s is seeded as kind %q, not native", ErrInvalidSeed, c.Name, sym, a.Kind)
		}
		if a.ChainID != nil && *a.ChainID != c.ChainID {
			// A native asset may legitimately be attributed to another chain
			// only when it has no home chain at all (the spanning case), which
			// the nil branch above already handled.
			return nil, fmt.Errorf("%w: asset %s belongs to a different chain than %q", ErrInvalidSeed, sym, c.Name)
		}
		c.NativeAssetID = optString(assetIDBySymbol[sym])
	}

	// --- tokens ------------------------------------------------------------
	seenTokenID := map[string]bool{}
	for _, st := range tokensFn() {
		chain, ok := seedChainByName[strings.ToLower(strings.TrimSpace(st.chainName))]
		if !ok {
			return nil, fmt.Errorf("%w: token %s on chain %q which is not seeded", ErrInvalidSeed, st.symbol, st.chainName)
		}
		asset, ok := assetBySymbol[strings.ToUpper(strings.TrimSpace(st.assetSym))]
		if !ok {
			return nil, fmt.Errorf("%w: token %s refers to asset %q which is not seeded", ErrInvalidSeed, st.symbol, st.assetSym)
		}
		kind, err := AddressKind(st.address)
		if err != nil {
			return nil, fmt.Errorf("token %s on %s: %w", st.symbol, chain.Name, err)
		}
		t := Token{
			TokenID:     MintID(KindToken, TokenKey(chain.Name, st.address)),
			ChainID:     chain.ChainID,
			Address:     strings.TrimSpace(st.address),
			AddressKind: kind,
			AssetID:     optString(asset.AssetID),
			Symbol:      strings.ToUpper(strings.TrimSpace(st.symbol)),
			Decimals:    optInt(st.decimals),
		}
		if seenTokenID[t.TokenID] {
			return nil, fmt.Errorf("%w: token id %s minted twice (%s)", ErrDuplicateID, t.TokenID, invalidNodeDump(KindToken, st.address))
		}
		seenTokenID[t.TokenID] = true
		ref.Tokens = append(ref.Tokens, t)
	}

	// --- venues ------------------------------------------------------------
	seenVenueID := map[string]bool{}
	for _, sv := range venuesFn() {
		id := strings.ToLower(strings.TrimSpace(sv.id))
		if id == "" {
			return nil, fmt.Errorf("%w: venue with empty id", ErrInvalidSeed)
		}
		if !sv.kind.Valid() {
			return nil, fmt.Errorf("%w: venue %q has unknown kind %q", ErrInvalidSeed, id, sv.kind)
		}
		for _, mt := range sv.marketTypes {
			if !mt.Valid() {
				return nil, fmt.Errorf("%w: venue %q has unknown market type %q", ErrInvalidSeed, id, mt)
			}
		}
		v := Venue{
			VenueID:     MintID(KindVenue, VenueKey(id)),
			Name:        optString(sv.name),
			Kind:        sv.kind,
			Known:       sv.known,
			MarketTypes: append([]MarketType(nil), sv.marketTypes...),
		}
		if seenVenueID[v.VenueID] {
			return nil, fmt.Errorf("%w: venue id %s minted twice (%s)", ErrDuplicateID, v.VenueID, invalidNodeDump(KindVenue, id))
		}
		seenVenueID[v.VenueID] = true
		venueSlug[v.VenueID] = id
		venueCCXT[v.VenueID] = sv.ccxtID
		ref.Venues = append(ref.Venues, v)
	}

	// --- ordering and mapping table ----------------------------------------
	// Every slice is sorted by its natural key so the emitted document is stable
	// regardless of the order the seed writers happened to concatenate tables.
	sort.Slice(ref.Chains, func(i, j int) bool { return ref.Chains[i].Name < ref.Chains[j].Name })
	sort.Slice(ref.Assets, func(i, j int) bool { return ref.Assets[i].Symbol < ref.Assets[j].Symbol })
	sort.Slice(ref.Tokens, func(i, j int) bool {
		if ref.Tokens[i].ChainID != ref.Tokens[j].ChainID {
			return ref.Tokens[i].ChainID < ref.Tokens[j].ChainID
		}
		return ref.Tokens[i].Address < ref.Tokens[j].Address
	})
	sort.Slice(ref.Venues, func(i, j int) bool { return ref.Venues[i].VenueID < ref.Venues[j].VenueID })

	idx := &indexes{
		chains:    map[string]*Chain{},
		assets:    map[string]*Asset{},
		tokens:    map[string]*Token{},
		venues:    map[string]*Venue{},
		byName:    map[string]*Chain{},
		resolve:   map[string]string{},
		venueSlug: venueSlug,
	}
	// Every index pointer is taken from the FINAL, sorted slices. This is not
	// cosmetic: sort.Slice permutes the backing array in place, so a pointer
	// captured before the sort keeps its INDEX and silently starts describing
	// whichever entity ended up there - a bug that produced a chain with the
	// wrong ChainID and made token lookups by chain name fail.
	for i := range ref.Chains {
		idx.chains[ref.Chains[i].ChainID] = &ref.Chains[i]
		idx.byName[ref.Chains[i].Name] = &ref.Chains[i]
	}
	for i := range ref.Assets {
		idx.assets[ref.Assets[i].AssetID] = &ref.Assets[i]
	}
	for i := range ref.Tokens {
		idx.tokens[ref.Tokens[i].TokenID] = &ref.Tokens[i]
	}
	for i := range ref.Venues {
		idx.venues[ref.Venues[i].VenueID] = &ref.Venues[i]
	}

	add := func(p Provider, id, canonical string) error {
		if p == "" || id == "" {
			return fmt.Errorf("%w: mapping with an empty provider or identifier", ErrInvalidSeed)
		}
		key := mappingKey(p, id)
		if prev, dup := idx.resolve[key]; dup && prev != canonical {
			return fmt.Errorf("%w: provider %s id %q maps to both %s and %s", ErrDuplicateID, p, id, prev, canonical)
		}
		idx.resolve[key] = canonical
		return nil
	}

	for i := range ref.Assets {
		for _, pid := range ref.Assets[i].ProviderIDs {
			if err := add(pid.Provider, pid.ProviderID, ref.Assets[i].AssetID); err != nil {
				return nil, err
			}
		}
		// Mapping-only pairs (provider outside the schema enum).
		for _, raw := range assetMappingsByID[ref.Assets[i].AssetID] {
			p, value, err := providerValue(raw)
			if err != nil {
				return nil, err
			}
			if err := add(p, value, ref.Assets[i].AssetID); err != nil {
				return nil, err
			}
		}
	}
	for i := range ref.Chains {
		for _, pid := range ref.Chains[i].ProviderIDs {
			if err := add(pid.Provider, pid.ProviderID, ref.Chains[i].ChainID); err != nil {
				return nil, err
			}
		}
		for _, raw := range chainMappingsByID[ref.Chains[i].ChainID] {
			p, value, err := providerValue(raw)
			if err != nil {
				return nil, err
			}
			if err := add(p, value, ref.Chains[i].ChainID); err != nil {
				return nil, err
			}
		}
	}
	// Venues carry no provider_ids in the contract, so their ccxt/internal ids
	// live only in the mapping table. The slug is captured during seeding so the
	// mapping key is the venue id the TREE uses, not a re-derivation from the
	// minted id.
	for i := range ref.Venues {
		v := &ref.Venues[i]
		slug, ok := venueSlug[v.VenueID]
		if !ok {
			return nil, fmt.Errorf("%w: venue %s has no seeded slug", ErrInvalidSeed, v.VenueID)
		}
		if err := add(ProviderInternal, slug, v.VenueID); err != nil {
			return nil, err
		}
		ccxt, ok := venueCCXT[v.VenueID]
		if !ok || ccxt == "" {
			continue
		}
		if err := add(ProviderCCXT, ccxt, v.VenueID); err != nil {
			return nil, err
		}
	}
	for _, m := range extraMappings {
		if err := add(m.Provider, m.ProviderID, m.CanonicalID); err != nil {
			return nil, err
		}
	}

	ref.Mappings = make([]Mapping, 0, len(idx.resolve))
	for k, v := range idx.resolve {
		p, id, _ := strings.Cut(k, "\x00")
		ref.Mappings = append(ref.Mappings, Mapping{Provider: Provider(p), ProviderID: id, CanonicalID: v})
	}
	sort.Slice(ref.Mappings, func(i, j int) bool {
		if ref.Mappings[i].Provider != ref.Mappings[j].Provider {
			return ref.Mappings[i].Provider < ref.Mappings[j].Provider
		}
		return ref.Mappings[i].ProviderID < ref.Mappings[j].ProviderID
	})

	// Misses: seeded omissions minus anything that now resolves. Iterating the
	// seed slice (not a map) keeps the result reproducible.
	for _, m := range seedMisses() {
		if _, resolved := idx.resolve[mappingKey(m.Provider, m.ProviderID)]; resolved {
			continue
		}
		ref.Misses = append(ref.Misses, m)
	}
	sort.Slice(ref.Misses, func(i, j int) bool {
		if ref.Misses[i].Provider != ref.Misses[j].Provider {
			return ref.Misses[i].Provider < ref.Misses[j].Provider
		}
		return ref.Misses[i].ProviderID < ref.Misses[j].ProviderID
	})

	ref.index = idx
	return ref, nil
}

// Resolve returns the canonical id one provider identifier denotes.
//
// It REFUSES rather than guesses: an unknown provider and an unknown identifier
// are distinct errors (ErrUnknownProvider / ErrUnknownIdentifier), no fuzzy or
// case-insensitive match is attempted, the identifier is matched VERBATIM (no
// trimming, so "MATIC " is not "MATIC"), and an identifier is never resolved
// through a symbol. That strictness is the difference between "we do not know
// this coin yet" and "we silently attributed this coin to the wrong asset".
func (r *Reference) Resolve(p Provider, providerID string) (string, error) {
	if r == nil || r.index == nil {
		return "", fmt.Errorf("%w: nil registry", ErrUnknownEntity)
	}
	if !knownProvider(p) {
		return "", fmt.Errorf("%w: %q", ErrUnknownProvider, p)
	}
	id, ok := r.index.resolve[mappingKey(p, providerID)]
	if !ok {
		return "", fmt.Errorf("%w: %s %q", ErrUnknownIdentifier, p, providerID)
	}
	return id, nil
}

// knownProvider reports whether p names an identifier space this build models,
// including the three that live only in the mapping table (ccxt, internal,
// cryptorank-chain) because the asset/chain schema enum has no surface for them.
func knownProvider(p Provider) bool {
	switch p {
	case ProviderCCXT, ProviderInternal, ProviderCryptoRankChain:
		return true
	}
	for _, sp := range SchemaProviders() {
		if sp == p {
			return true
		}
	}
	return false
}

// Asset returns the asset with this id.
func (r *Reference) Asset(id string) (Asset, error) {
	if r == nil || r.index == nil {
		return Asset{}, fmt.Errorf("%w: nil registry", ErrUnknownEntity)
	}
	a, ok := r.index.assets[id]
	if !ok {
		return Asset{}, fmt.Errorf("%w: asset %q", ErrUnknownEntity, id)
	}
	return *a, nil
}

// Token returns the token with this id.
func (r *Reference) Token(id string) (Token, error) {
	if r == nil || r.index == nil {
		return Token{}, fmt.Errorf("%w: nil registry", ErrUnknownEntity)
	}
	t, ok := r.index.tokens[id]
	if !ok {
		return Token{}, fmt.Errorf("%w: token %q", ErrUnknownEntity, id)
	}
	return *t, nil
}

// Chain returns the chain with this id.
func (r *Reference) Chain(id string) (Chain, error) {
	if r == nil || r.index == nil {
		return Chain{}, fmt.Errorf("%w: nil registry", ErrUnknownEntity)
	}
	c, ok := r.index.chains[id]
	if !ok {
		return Chain{}, fmt.Errorf("%w: chain %q", ErrUnknownEntity, id)
	}
	return *c, nil
}

// ChainByName returns the chain with this canonical name (lowercase form of the
// label the retired accounts/wallets package stores).
func (r *Reference) ChainByName(name string) (Chain, error) {
	if r == nil || r.index == nil {
		return Chain{}, fmt.Errorf("%w: nil registry", ErrUnknownEntity)
	}
	c, ok := r.index.byName[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return Chain{}, fmt.Errorf("%w: chain name %q", ErrUnknownEntity, name)
	}
	return *c, nil
}

// Venue returns the venue with this id.
func (r *Reference) Venue(id string) (Venue, error) {
	if r == nil || r.index == nil {
		return Venue{}, fmt.Errorf("%w: nil registry", ErrUnknownEntity)
	}
	v, ok := r.index.venues[id]
	if !ok {
		return Venue{}, fmt.Errorf("%w: venue %q", ErrUnknownEntity, id)
	}
	return *v, nil
}

// TokenByAddress returns the token deployed at (chain, address). The address is
// matched VERBATIM against the seeded full address - deliberately not
// case-insensitively for base58 (which is case-sensitive) and not by prefix,
// which is what makes a truncated `SPL:<mint6>` label fail to resolve instead
// of silently naming the wrong token.
func (r *Reference) TokenByAddress(chainName, address string) (Token, error) {
	if r == nil || r.index == nil {
		return Token{}, fmt.Errorf("%w: nil registry", ErrUnknownEntity)
	}
	chain, ok := r.index.byName[strings.ToLower(strings.TrimSpace(chainName))]
	if !ok {
		return Token{}, fmt.Errorf("%w: chain name %q", ErrUnknownEntity, chainName)
	}
	want := strings.TrimSpace(address)
	for i := range r.Tokens {
		if r.Tokens[i].ChainID == chain.ChainID && r.Tokens[i].Address == want {
			return r.Tokens[i], nil
		}
	}
	return Token{}, fmt.Errorf("%w: token %q on chain %q", ErrUnknownEntity, address, chainName)
}

// ByID returns the entity an id denotes, as its contract type. The id's kind
// prefix selects the namespace, so a typo cannot cross-resolve.
func (r *Reference) ByID(id string) (any, error) {
	kind, _, ok := strings.Cut(id, ":")
	if !ok {
		return nil, fmt.Errorf("%w: %q has no kind prefix", ErrUnknownEntity, id)
	}
	switch EntityKind(kind) {
	case KindAsset:
		return r.Asset(id)
	case KindToken:
		return r.Token(id)
	case KindChain:
		return r.Chain(id)
	case KindVenue:
		return r.Venue(id)
	default:
		return nil, fmt.Errorf("%w: %q names unknown kind %q", ErrUnknownEntity, id, kind)
	}
}

// SDKVersion is the shape version of the emitted document. It is bumped when
// the document's own schema (not the entity schemas) changes incompatibly, so a
// consumer can refuse a document it does not understand instead of misreading
// it.
const SDKVersion = 1

// invalidNodeDump renders "kind key" for an error message, so a seed failure
// names the offending row in a table of sixty without dumping a whole struct.
func invalidNodeDump(kind EntityKind, key string) string {
	return fmt.Sprintf("%s %s", kind, key)
}

func optString(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

func optInt(i int) *int {
	v := i
	return &v
}

// parseProviders turns the flattened seed pairs into contract ProviderID values,
// refusing a provider that the asset/chain contract does not allow inside an
// embedded provider_ids list (ccxt and internal belong in the mapping table).
func parseProviders(pairs []string) ([]ProviderID, error) {
	if len(pairs) == 0 {
		return nil, nil
	}
	out := make([]ProviderID, 0, len(pairs))
	for _, raw := range pairs {
		p, value, err := providerValue(raw)
		if err != nil {
			return nil, err
		}
		if !inSchemaProviders(p) {
			return nil, fmt.Errorf("%w: provider %q may not appear in an embedded provider_ids list (contract enum is %v)",
				ErrInvalidSeed, p, SchemaProviders())
		}
		out = append(out, ProviderID{Provider: p, ProviderID: value})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].ProviderID < out[j].ProviderID
	})
	return out, nil
}

func inSchemaProviders(p Provider) bool {
	for _, sp := range SchemaProviders() {
		if sp == p {
			return true
		}
	}
	return false
}

// seedMisses is the honest list of identifiers this build KNOWS OF but cannot
// resolve. Every row is evidence-backed: it names an id that exists in the tree
// (or a category the tree demonstrably cannot supply) and the reason it has no
// canonical entity. A miss is dropped automatically when a mapping for the same
// (provider, provider_id) appears, so adding a real mapping never has to
// remember to delete a row here.
func seedMisses() []Miss {
	return []Miss{
		{
			Kind:         string(KindToken),
			Provider:     ProviderOnchain,
			ProviderID:   "solana/token-accounts-by-owner",
			KnownAbsence: true,
			Reason:       "the Solana token set cannot be enumerated from the tree: the sync resolves mints at runtime and then discards them",
			ReportedAs:   "SPL:<first 6 chars of the mint>",
		},
		{
			Kind:         string(KindAsset),
			Provider:     ProviderCryptoRank,
			ProviderID:   "hyperliquid",
			KnownAbsence: false,
			Reason:       "the CryptoRank fixture carries the coin row, but HYPE is never priced by the sync, so the asset is seeded without a provider id",
			ReportedAs:   "HYPE",
		},
		{
			Kind:         string(KindAsset),
			Provider:     ProviderOnchain,
			ProviderID:   "ethereum/0x0000000000000000000000000000000000000000",
			KnownAbsence: false,
			Reason:       "untracked swap input: a swap into the zero-address path is not a token this build has a deployment for, and the address is deliberately not seeded as one",
			ReportedAs:   "transfer-log scan result",
		},
	}
}
