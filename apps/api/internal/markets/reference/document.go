package reference

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
)

// DocumentPath is where the emitted document lives, relative to the repository
// root. It is the cross-service sharing artifact described in the package doc:
// a consumer in any language reads this file instead of importing this package.
const DocumentPath = "contracts/data/reference.json"

// Document is the serialized form of a whole registry: every entity, the whole
// resolution table, and the honest list of known-but-unresolved identifiers.
//
// Shape rules that make it usable as a cross-service contract:
//   - `document_version` and `id_rule` travel with the data, so a consumer can
//     tell which id space it is holding without out-of-band knowledge.
//   - every slice is sorted by its natural key, and every entity carries
//     `natural_key`, so the file is a stable diff artifact: adding one asset
//     adds one line, it does not reshuffle the file.
//   - the entities are the SAME structs the contract schemas describe (Asset,
//     Token, Chain, Venue), each with the mandatory `natural_key` added.
type Document struct {
	DocumentVersion int    `json:"document_version"`
	IDRule          string `json:"id_rule"`
	Salt            string `json:"salt"`
	// GeneratedBy names the producer, so a stale file is attributable.
	GeneratedBy string `json:"generated_by"`
	// Missing states the known gaps in one line, mirrored from Misses.
	Unmapped []string `json:"unmapped"`
	Note     string   `json:"note"`

	Chains   []DocumentChain `json:"chains"`
	Assets   []DocumentAsset `json:"assets"`
	Tokens   []DocumentToken `json:"tokens"`
	Venues   []DocumentVenue `json:"venues"`
	Mappings []Mapping       `json:"mappings"`
	Misses   []Miss          `json:"misses"`
}

// DocumentChain is Chain plus its natural key.
type DocumentChain struct {
	NaturalKey string `json:"natural_key"`
	Chain
}

// DocumentAsset is Asset plus its natural key.
type DocumentAsset struct {
	NaturalKey string `json:"natural_key"`
	Asset
}

// DocumentToken is Token plus its natural key.
type DocumentToken struct {
	NaturalKey string `json:"natural_key"`
	Token
}

// DocumentVenue is Venue plus its natural key.
type DocumentVenue struct {
	NaturalKey string `json:"natural_key"`
	Venue
}

// IDRuleText is the human-readable statement of the minting rule, carried inside
// the document so an independent implementation can re-derive an id and check it
// rather than trusting this file.
const IDRuleText = `id = kind ":" hex(sha256(salt + 0x00 + kind + 0x00 + natural_key))[0:10]; ` +
	`natural_key per kind: chain "chain/<name>", asset "asset/<kind>/<SYMBOL>", ` +
	`token "token/<chain-name>/<full-address>", venue "venue/<venue-id>"`

// Emit writes the canonical JSON document for this registry.
//
// The output is deterministic: no map is ever iterated without being sorted
// first, no clock or random value is included, and the same registry always
// produces byte-identical bytes. That is what lets a test pin the checked-in file
// and lets a consumer diff two versions of it.
func (r *Reference) Emit(w io.Writer) error {
	if r == nil {
		return fmt.Errorf("%w: nil registry", ErrUnknownEntity)
	}
	doc := r.Document()
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return fmt.Errorf("reference: encode document: %w", err)
	}
	return nil
}

// EmitBytes returns the document bytes, for tests and goldens.
func (r *Reference) EmitBytes() ([]byte, error) {
	var buf bytes.Buffer
	if err := r.Emit(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Document builds the serializable form. Slices are already sorted by Build, but
// they are sorted again here so a Reference assembled by hand in a test cannot
// produce an unstable document.
func (r *Reference) Document() Document {
	doc := Document{
		DocumentVersion: SDKVersion,
		IDRule:          IDRuleText,
		Salt:            Salt,
		GeneratedBy:     "apps/api/internal/markets/reference",
		Unmapped:        Unmapped(),
		Note: "Cross-service reference artifact. Consumers MUST NOT import the producing Go package: " +
			"read this file (or the JSON Schemas under contracts/schemas/) instead. " +
			"An id is opaque; resolve through `mappings`, never by parsing an id or matching a symbol.",
	}
	for _, c := range r.Chains {
		doc.Chains = append(doc.Chains, DocumentChain{NaturalKey: ChainKey(c.Name), Chain: c})
	}
	for _, a := range r.Assets {
		doc.Assets = append(doc.Assets, DocumentAsset{NaturalKey: AssetKey(a.Kind, a.Symbol), Asset: a})
	}
	for _, t := range r.Tokens {
		name := ""
		if c, ok := r.chainNameByID(t.ChainID); ok {
			name = c
		}
		doc.Tokens = append(doc.Tokens, DocumentToken{NaturalKey: TokenKey(name, t.Address), Token: t})
	}
	for _, v := range r.Venues {
		key := ""
		if r.index != nil {
			if slug, ok := r.index.venueSlug[v.VenueID]; ok {
				key = VenueKey(slug)
			}
		}
		doc.Venues = append(doc.Venues, DocumentVenue{NaturalKey: key, Venue: v})
	}
	doc.Mappings = append([]Mapping(nil), r.Mappings...)
	doc.Misses = append([]Miss(nil), r.Misses...)
	sort.Slice(doc.Mappings, func(i, j int) bool {
		if doc.Mappings[i].Provider != doc.Mappings[j].Provider {
			return doc.Mappings[i].Provider < doc.Mappings[j].Provider
		}
		return doc.Mappings[i].ProviderID < doc.Mappings[j].ProviderID
	})
	sort.Slice(doc.Misses, func(i, j int) bool {
		if doc.Misses[i].Provider != doc.Misses[j].Provider {
			return doc.Misses[i].Provider < doc.Misses[j].Provider
		}
		return doc.Misses[i].ProviderID < doc.Misses[j].ProviderID
	})
	return doc
}

// Load rebuilds a registry from its emitted document: registry -> JSON ->
// registry yields the same ids, the same resolution answers and the same
// ordering.
//
// It VALIDATES everything it reads rather than trusting the file, because a
// consumer in another language (or a future generator) may hand it a document
// this build did not write:
//   - every id must be a well-formed id of its kind, and must equal the id the
//     declared natural key mints (so a hand-edited id is refused, not accepted);
//   - every cross-reference (token->chain, token->asset, chain->native asset,
//     asset->chain, mapping->entity) must land on an entity in the document;
//   - every mapping's target kind must match the mapping's own implied namespace
//     check, and no two mappings may disagree about one identifier.
func Load(rd io.Reader) (*Reference, error) {
	var doc Document
	dec := json.NewDecoder(rd)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrInvalidDocument, err)
	}
	if doc.DocumentVersion != SDKVersion {
		return nil, fmt.Errorf("%w: document_version %d, this build understands %d",
			ErrInvalidDocument, doc.DocumentVersion, SDKVersion)
	}
	if doc.Salt != Salt {
		return nil, fmt.Errorf("%w: salt %q does not match this build's %q - ids would differ",
			ErrInvalidDocument, doc.Salt, Salt)
	}

	ref := &Reference{}
	idx := &indexes{
		chains:    map[string]*Chain{},
		assets:    map[string]*Asset{},
		tokens:    map[string]*Token{},
		venues:    map[string]*Venue{},
		byName:    map[string]*Chain{},
		resolve:   map[string]string{},
		venueSlug: map[string]string{},
	}

	for _, dc := range doc.Chains {
		if err := requireID(KindChain, dc.ChainID, dc.NaturalKey, ChainKey(dc.Name)); err != nil {
			return nil, err
		}
		if dc.Name == "" {
			return nil, fmt.Errorf("%w: chain %s has an empty name", ErrInvalidDocument, dc.ChainID)
		}
		if !dc.Kind.Valid() {
			return nil, fmt.Errorf("%w: chain %q has unknown kind %q", ErrInvalidDocument, dc.Name, dc.Kind)
		}
		c := dc.Chain
		if _, dup := idx.chains[c.ChainID]; dup {
			return nil, fmt.Errorf("%w: chain id %s appears twice", ErrDuplicateID, c.ChainID)
		}
		if _, dup := idx.byName[c.Name]; dup {
			return nil, fmt.Errorf("%w: chain name %q appears twice", ErrDuplicateID, c.Name)
		}
		idx.chains[c.ChainID] = &c
		idx.byName[c.Name] = &c
		ref.Chains = append(ref.Chains, c)
	}
	for _, da := range doc.Assets {
		if err := requireID(KindAsset, da.AssetID, da.NaturalKey, AssetKey(da.Kind, da.Symbol)); err != nil {
			return nil, err
		}
		if !da.Kind.Valid() {
			return nil, fmt.Errorf("%w: asset %q has unknown kind %q", ErrInvalidDocument, da.Symbol, da.Kind)
		}
		a := da.Asset
		if _, dup := idx.assets[a.AssetID]; dup {
			return nil, fmt.Errorf("%w: asset id %s appears twice", ErrDuplicateID, a.AssetID)
		}
		idx.assets[a.AssetID] = &a
		ref.Assets = append(ref.Assets, a)
	}
	for _, dt := range doc.Tokens {
		chain, ok := idx.chains[dt.ChainID]
		if !ok {
			return nil, fmt.Errorf("%w: token %s refers to chain %s which is not in the document", ErrInvalidDocument, dt.TokenID, dt.ChainID)
		}
		if err := requireID(KindToken, dt.TokenID, dt.NaturalKey, TokenKey(chain.Name, dt.Address)); err != nil {
			return nil, err
		}
		if dt.AssetID != nil {
			if _, ok := idx.assets[*dt.AssetID]; !ok {
				return nil, fmt.Errorf("%w: token %s refers to asset %s which is not in the document", ErrInvalidDocument, dt.TokenID, *dt.AssetID)
			}
		}
		kind, err := AddressKind(dt.Address)
		if err != nil {
			return nil, fmt.Errorf("%w: token %s", ErrInvalidDocument, err)
		}
		if dt.AddressKind != kind {
			return nil, fmt.Errorf("%w: token %s declares address_kind %q but its address is %q",
				ErrInvalidDocument, dt.TokenID, dt.AddressKind, kind)
		}
		t := dt.Token
		if _, dup := idx.tokens[t.TokenID]; dup {
			return nil, fmt.Errorf("%w: token id %s appears twice", ErrDuplicateID, t.TokenID)
		}
		idx.tokens[t.TokenID] = &t
		ref.Tokens = append(ref.Tokens, t)
	}
	for _, dv := range doc.Venues {
		if err := requireID(KindVenue, dv.VenueID, dv.NaturalKey, VenueKey(venueIDFromNaturalKey(dv.NaturalKey))); err != nil {
			return nil, err
		}
		if !dv.Kind.Valid() {
			return nil, fmt.Errorf("%w: venue %s has unknown kind %q", ErrInvalidDocument, dv.VenueID, dv.Kind)
		}
		for _, mt := range dv.MarketTypes {
			if !mt.Valid() {
				return nil, fmt.Errorf("%w: venue %s has unknown market type %q", ErrInvalidDocument, dv.VenueID, mt)
			}
		}
		v := dv.Venue
		if _, dup := idx.venues[v.VenueID]; dup {
			return nil, fmt.Errorf("%w: venue id %s appears twice", ErrDuplicateID, v.VenueID)
		}
		idx.venues[v.VenueID] = &v
		idx.venueSlug[v.VenueID] = venueIDFromNaturalKey(dv.NaturalKey)
		ref.Venues = append(ref.Venues, v)
	}
	// Chain -> native asset cross-reference, after assets exist.
	for i := range ref.Chains {
		c := &ref.Chains[i]
		if c.NativeAssetID == nil {
			continue
		}
		if _, ok := idx.assets[*c.NativeAssetID]; !ok {
			return nil, fmt.Errorf("%w: chain %q names native asset %s which is not in the document",
				ErrInvalidDocument, c.Name, *c.NativeAssetID)
		}
	}
	for i := range ref.Assets {
		a := &ref.Assets[i]
		if a.ChainID == nil {
			continue
		}
		if _, ok := idx.chains[*a.ChainID]; !ok {
			return nil, fmt.Errorf("%w: asset %q refers to chain %s which is not in the document",
				ErrInvalidDocument, a.Symbol, *a.ChainID)
		}
	}
	// Entity-embedded provider ids, then the explicit mapping table.
	addPair := func(p Provider, id, canonical string) error {
		if p == "" || id == "" {
			return fmt.Errorf("%w: mapping with an empty provider or identifier", ErrInvalidDocument)
		}
		if !knownProvider(p) {
			return fmt.Errorf("%w: mapping names unknown provider %q", ErrInvalidDocument, p)
		}
		if !entityExists(idx, canonical) {
			return fmt.Errorf("%w: mapping %s/%s points at %s which is not in the document",
				ErrInvalidDocument, p, id, canonical)
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
			if !inSchemaProviders(pid.Provider) {
				return nil, fmt.Errorf("%w: asset %q carries provider %q, which the asset schema's enum does not allow",
					ErrInvalidDocument, ref.Assets[i].Symbol, pid.Provider)
			}
			if err := addPair(pid.Provider, pid.ProviderID, ref.Assets[i].AssetID); err != nil {
				return nil, err
			}
		}
	}
	for i := range ref.Chains {
		for _, pid := range ref.Chains[i].ProviderIDs {
			if !inSchemaProviders(pid.Provider) {
				return nil, fmt.Errorf("%w: chain %q carries provider %q, which the chain schema's enum does not allow",
					ErrInvalidDocument, ref.Chains[i].Name, pid.Provider)
			}
			if err := addPair(pid.Provider, pid.ProviderID, ref.Chains[i].ChainID); err != nil {
				return nil, err
			}
		}
	}
	for _, m := range doc.Mappings {
		if err := addPair(m.Provider, m.ProviderID, m.CanonicalID); err != nil {
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
	ref.Misses = append([]Miss(nil), doc.Misses...)
	ref.index = idx
	return ref, nil
}

// entityExists reports whether an id names an entity present in the index.
func entityExists(idx *indexes, id string) bool {
	kind, _, ok := strings.Cut(id, ":")
	if !ok {
		return false
	}
	switch EntityKind(kind) {
	case KindAsset:
		_, ok := idx.assets[id]
		return ok
	case KindToken:
		_, ok := idx.tokens[id]
		return ok
	case KindChain:
		_, ok := idx.chains[id]
		return ok
	case KindVenue:
		_, ok := idx.venues[id]
		return ok
	default:
		return false
	}
}

// requireID refuses an id that is malformed, belongs to another namespace, or
// does not equal the id its declared natural key mints. The last check is the
// important one: it makes the document self-verifying, so a hand-edited id is a
// load error rather than a silent divergence.
func requireID(kind EntityKind, id, naturalKey, expectedKey string) error {
	if id == "" {
		return fmt.Errorf("%w: %s entity with an empty id", ErrInvalidDocument, kind)
	}
	prefix, _, ok := strings.Cut(id, ":")
	if !ok || EntityKind(prefix) != kind {
		return fmt.Errorf("%w: id %q is not a %s id", ErrInvalidDocument, id, kind)
	}
	if naturalKey == "" {
		return fmt.Errorf("%w: %s %s has an empty natural_key", ErrInvalidDocument, kind, id)
	}
	if naturalKey != expectedKey {
		return fmt.Errorf("%w: %s %s declares natural_key %q but %s derives from %q",
			ErrInvalidDocument, kind, id, naturalKey, kind, expectedKey)
	}
	if want := MintID(kind, naturalKey); want != id {
		return fmt.Errorf("%w: %s id %s does not match the id %q minted from natural_key %q",
			ErrInvalidDocument, kind, id, want, naturalKey)
	}
	return nil
}

// venueIDFromNaturalKey extracts the venue id from a "venue/<id>" natural key.
func venueIDFromNaturalKey(naturalKey string) string {
	_, rest, _ := strings.Cut(naturalKey, "/")
	return rest
}

// chainNameByID is a lookup used only by Document(), which must not iterate a
// map to build its output.
func (r *Reference) chainNameByID(id string) (string, bool) {
	if r.index == nil {
		return "", false
	}
	c, ok := r.index.chains[id]
	if !ok {
		return "", false
	}
	return c.Name, true
}
