package reference

import (
	"fmt"
	"strings"
	"testing"

	exchangeaccounts "github.com/anvxxr-arch/fudcourt/apps/api/internal/accounts/exchange"
)

// This file makes seed.go's promise true. seedVenues() records that "binance is
// NOT in [TICKER_EXCHANGES] even though the executor trades it, which is exactly
// the kind of divergence the agreement test in venues_test.go exists to catch."
// The agreement is between THREE statements the tree makes about venue ids:
//
//  1. VenueIDInvariants() - the vocabularies the executor, the ccxt ticker and
//     the backend/api allowlist actually use, expressed in the venue-id
//     vocabulary the tree uses (seed.go);
//  2. the registry built from seedVenues() - what the canonical model knows;
//  3. exchangeaccounts.KnownExchange - the venues this build may PLACE on.
//
// The registry mints each venue a canonical id (`venue:<hex>`); the tree's own
// id is carried as the `internal` mapping row (provider_id = tree id,
// canonical_id = minted id). Resolution therefore goes through Resolve, exactly
// as a consumer would - see resolveVenue below.
//
// A venue id that any invariant uses but (2) cannot resolve is a red test naming
// the invariant, the id and its Source. The reverse direction is checked in
// TestKnownExchangeAgreesWithRegistry for the known=true set. The recorded
// divergences (binance traded-but-not-ccxt; paper simulated-with-no-ccxt-id) are
// asserted explicitly rather than smoothed over, so a future edit to either list
// is caught here instead of silently reconciling this registry to it.

// contains reports whether the slice holds the value.
func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

// invariantSources renders every invariant's Source+Name for a failure message.
func invariantSources() []string {
	out := make([]string, 0, len(VenueIDInvariants()))
	for _, inv := range VenueIDInvariants() {
		out = append(out, fmt.Sprintf("%q (%s)", inv.Source, inv.Name))
	}
	return out
}

// venueIDInvariantBySource returns the recorded invariant whose Source names the
// given substring, failing if none matches - so a test that asserts "the ticker
// vocabulary" breaks the day Invariants() renames or drops that row.
func venueIDInvariantBySource(t *testing.T, substr string) VenueIDInvariant {
	t.Helper()
	for _, inv := range VenueIDInvariants() {
		if strings.Contains(inv.Source, substr) {
			return inv
		}
	}
	t.Fatalf("no VenueIDInvariant whose Source contains %q; invariants: %v", substr, invariantSources())
	return VenueIDInvariant{}
}

// resolveVenue resolves a tree venue id (the slug seed.go uses) to the seeded
// venue, via the mapping table a real consumer would use.
func resolveVenue(ref *Reference, treeID string) (Venue, error) {
	canonicalID, err := ref.Resolve(ProviderInternal, treeID)
	if err != nil {
		return Venue{}, err
	}
	return ref.Venue(canonicalID)
}

// slugForVenue is the reverse of resolveVenue: the tree id for a minted venue.
func slugForVenue(ref *Reference, canonicalID string) (string, bool) {
	for _, m := range ref.Mappings {
		if m.Provider == ProviderInternal && m.CanonicalID == canonicalID {
			return m.ProviderID, true
		}
	}
	return "", false
}

// TestVenueIDInvariantsResolveInRegistry is (1) -> (2): every venue id a part of
// the tree says it uses must be a venue the canonical registry knows.
func TestVenueIDInvariantsResolveInRegistry(t *testing.T) {
	ref := mustBuild(t)
	for _, inv := range VenueIDInvariants() {
		if len(inv.VenueIDs) == 0 {
			t.Errorf("invariant %q (%s) lists no venue ids - an empty vocabulary asserts nothing", inv.Name, inv.Source)
		}
		for _, id := range inv.VenueIDs {
			v, err := resolveVenue(ref, id)
			if err != nil {
				t.Errorf("invariant %q uses venue id %q (source: %s) that the registry cannot resolve: %v",
					inv.Name, id, inv.Source, err)
				continue
			}
			if v.VenueID == "" {
				t.Errorf("invariant %q resolved venue %q to a venue with an empty id", inv.Name, id)
			}
		}
	}
}

// TestKnownExchangeAgreesWithRegistry is the reverse direction for the venue ids
// this build may PLACE on. KnownExchange (accounts/exchange) is exercised live,
// not copied: a venue that is known=true in the registry but refused by
// KnownExchange - or an allowlist entry the registry cannot resolve - fails the
// comparison, naming both sides.
func TestKnownExchangeAgreesWithRegistry(t *testing.T) {
	ref := mustBuild(t)

	// The allowlist vocabulary is the recorded invariant, not a second hand list.
	allow := venueIDInvariantBySource(t, "KnownExchange")

	// Direction A: every id the allowlist states must be traded AND known.
	for _, id := range allow.VenueIDs {
		if !exchangeaccounts.KnownExchange(id) {
			t.Errorf("allowlist %s names %q, but KnownExchange(%q) = false", allow.Source, id, id)
		}
		v, err := resolveVenue(ref, id)
		if err != nil {
			t.Errorf("allowlist %s names %q, but the registry cannot resolve it: %v", allow.Source, id, err)
			continue
		}
		if !v.Known {
			t.Errorf("allowlist %s names %q, but the registry has known=false for it", allow.Source, id)
		}
	}

	// Direction B: every venue the registry marks known=true must be one
	// KnownExchange accepts. This is the assertion that fires when a venue is
	// seeded known=true in only one place.
	for _, v := range ref.Venues {
		if !v.Known {
			continue
		}
		slug, ok := slugForVenue(ref, v.VenueID)
		if !ok {
			t.Errorf("registry venue %s is known=true but has no internal mapping naming its tree id", v.VenueID)
			continue
		}
		if !exchangeaccounts.KnownExchange(slug) {
			t.Errorf("registry venue %q is known=true but KnownExchange refuses it; either set known=false in "+
				"seedVenues() or add %q to the KnownExchange switch in %s", slug, slug, allow.Source)
		}
	}
}

// TestVenueIDDivergencesAreRecorded pins the divergences seed.go's provenance
// paragraph calls out, each as its own assertion + comment, so neither list can
// drift silently.
func TestVenueIDDivergencesAreRecorded(t *testing.T) {
	ref := mustBuild(t)
	ccxt := venueIDInvariantBySource(t, "TICKER_EXCHANGES")
	exec := venueIDInvariantBySource(t, "types.go ExchangeID")

	// Divergence 1: binance is traded by the executor yet absent from the ccxt
	// ticker vocabulary. seed.go relies on this staying true.
	if contains(ccxt.VenueIDs, "binance") {
		t.Errorf("binance now appears in %q; seedVenues() documents it as deliberately absent from %s",
			ccxt.Source, ccxt.Source)
	}
	if !contains(exec.VenueIDs, "binance") {
		t.Errorf("binance is no longer in the executor vocabulary %q; seedVenues() documents it as executor-traded", exec.Source)
	}
	if !exchangeaccounts.KnownExchange("binance") {
		t.Errorf("KnownExchange no longer trades binance, but seedVenues() marks it known=true")
	}
	if bv, err := resolveVenue(ref, "binance"); err != nil {
		t.Errorf("registry cannot resolve binance: %v", err)
	} else if !bv.Known {
		t.Errorf("registry venue binance is known=false; seedVenues() marks it known=true")
	}

	// Divergence 2: paper is this repo's own simulator - an executor venue id
	// that is known=false and has no ccxt venue id at all.
	if contains(ccxt.VenueIDs, "paper") {
		t.Errorf("paper appears in the ccxt ticker vocabulary %q, but it is a simulated adapter", ccxt.Source)
	}
	if !contains(exec.VenueIDs, "paper") {
		t.Errorf("paper is missing from the executor vocabulary %q", exec.Source)
	}
	pv, err := resolveVenue(ref, "paper")
	if err != nil {
		t.Fatalf("registry cannot resolve the paper venue: %v", err)
	}
	if pv.Known {
		t.Errorf("paper is known=true; the simulator is not a venue this build may obtain credentials for")
	}
	if cid, err := ref.Resolve(ProviderCCXT, "paper"); err == nil {
		t.Errorf("registry resolves the ccxt id paper to %s, but the simulator has no ccxt venue id", cid)
	}

	// The ccxt ticker vocabulary OVERLAPS the traded set (bybit and mexc are
	// both quoted AND traded), so the two are not disjoint. A ccxt venue's known
	// flag must therefore simply AGREE with KnownExchange, and the venues that
	// come out known=false are the read-only market-data ones.
	allow := venueIDInvariantBySource(t, "KnownExchange")
	traded := map[string]bool{}
	for _, id := range allow.VenueIDs {
		traded[id] = true
	}
	for _, id := range ccxt.VenueIDs {
		cid, err := ref.Resolve(ProviderCCXT, id)
		if err != nil {
			t.Errorf("ccxt ticker venue %q has no ccxt mapping in the registry: %v", id, err)
			continue
		}
		v, err := ref.Venue(cid)
		if err != nil {
			t.Errorf("ccxt ticker venue %q resolved to %s, which does not resolve back: %v", id, cid, err)
			continue
		}
		if v.Known != traded[id] {
			t.Errorf("ccxt ticker venue %q has known=%v but KnownExchange(%q)=%v; the registry and the allowlist must agree",
				id, v.Known, id, traded[id])
		}
	}
}

// TestVenueIDsWellFormed asserts the id-space invariants: non-empty, lowercase,
// no surrounding whitespace, and unique across every recorded vocabulary and the
// registry. A duplicate venue id must fail rather than silently merge.
func TestVenueIDsWellFormed(t *testing.T) {
	ref := mustBuild(t)

	slugSeen := map[string]int{}
	for _, m := range ref.Mappings {
		if m.Provider == ProviderInternal {
			slugSeen[m.ProviderID]++
		}
	}
	for slug, n := range slugSeen {
		if n > 1 {
			t.Errorf("internal venue id %q has %d mapping rows; a duplicate must fail, not silently merge", slug, n)
		}
	}

	seen := map[string]int{}
	for i, v := range ref.Venues {
		if v.VenueID == "" {
			t.Errorf("registry venue %d has an empty id", i)
		}
		seen[v.VenueID]++
	}
	for id, n := range seen {
		if n > 1 {
			t.Errorf("registry venue id %q appears %d times; a duplicate must fail, not silently merge", id, n)
		}
	}

	for _, inv := range VenueIDInvariants() {
		for _, id := range inv.VenueIDs {
			if id == "" {
				t.Errorf("invariant %q (%s) contains an empty venue id", inv.Name, inv.Source)
				continue
			}
			if id != strings.ToLower(id) {
				t.Errorf("invariant %q (%s) contains non-lowercase venue id %q", inv.Name, inv.Source, id)
			}
			if strings.TrimSpace(id) != id {
				t.Errorf("invariant %q (%s) contains venue id %q with surrounding whitespace", inv.Name, inv.Source, id)
			}
		}
	}
}
