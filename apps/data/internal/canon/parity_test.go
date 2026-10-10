package canon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// referenceFixtureRel is the parity artifact, repo-relative: it is the
// cross-service contract described in the reference package doc. A consumer in
// any language reads the file instead of importing the producing package, so
// this test reads it rather than importing apps/api.
const referenceFixtureRel = "contracts/data/reference.json"

// referenceEntities is the subset of the artifact this test needs. Every
// entity row carries its natural_key and minted id, so the test can re-derive
// the id from the row's OWN fields with THIS package's rule and compare.
type referenceEntities struct {
	Chains []struct {
		ChainID string `json:"chain_id"`
		Name    string `json:"name"`
	} `json:"chains"`
	Assets []struct {
		AssetID string `json:"asset_id"`
		Symbol  string `json:"symbol"`
		Kind    string `json:"kind"`
	} `json:"assets"`
	Tokens []struct {
		TokenID string `json:"token_id"`
		ChainID string `json:"chain_id"`
		Address string `json:"address"`
	} `json:"tokens"`
	Venues []struct {
		NaturalKey string `json:"natural_key"`
		VenueID    string `json:"venue_id"`
	} `json:"venues"`
}

// referenceArtifact returns the checked-in artifact bytes. The path is
// resolved from THIS SOURCE FILE (runtime.Caller, the pattern
// research/cryptorank/parity_test.go uses), never from the test process's
// working directory: go test may run the package from any directory, and a
// fixture found by luck of cwd is a fixture that silently stops being tested
// under a different invocation.
func referenceArtifact(t *testing.T) []byte {
	t.Helper()
	if d := os.Getenv("FUDCOURT_DATA_FIXTURES_DIR"); d != "" {
		raw, err := os.ReadFile(filepath.Join(d, "reference.json"))
		if err != nil {
			t.Fatalf("FUDCOURT_DATA_FIXTURES_DIR: read reference.json: %v", err)
		}
		return raw
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	for {
		cand := filepath.Join(dir, filepath.FromSlash(referenceFixtureRel))
		if _, err := os.Stat(cand); err == nil {
			raw, err := os.ReadFile(cand)
			if err != nil {
				t.Fatalf("read %s: %v", cand, err)
			}
			return raw
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("reference artifact not found: walked up from %s looking for %s", filepath.Dir(thisFile), referenceFixtureRel)
		}
		dir = parent
	}
}
func loadReference(t *testing.T) referenceEntities {
	t.Helper()
	var doc referenceEntities
	if err := json.Unmarshal(referenceArtifact(t), &doc); err != nil {
		t.Fatalf("parse %s: %v", referenceFixtureRel, err)
	}
	return doc
}

// TestMintIDParityWithReferenceArtifact re-derives every existing id in the
// artifact using this package's builders + MintID, and asserts the bytes
// match. The four kinds are the pre-existing apps/api id space; if this
// package's rule drifts from apps/api's by even one byte, the ids diverge
// here first, not in production data.
//
// The natural keys are rebuilt from the rows' own fields (chains: name;
// venues: the natural key's own id segment; tokens: chain name + address;
// assets: kind + symbol) rather than copied from natural_key, so both halves
// of the rule - key construction AND hashing - are checked.
func TestMintIDParityWithReferenceArtifact(t *testing.T) {
	doc := loadReference(t)
	type row struct {
		kind   EntityKind
		key    string
		wantID string
		label  string
	}
	var rows []row
	chainNameByID := map[string]string{}
	for _, c := range doc.Chains {
		chainNameByID[c.ChainID] = c.Name
		rows = append(rows, row{
			kind:   KindChain,
			key:    ChainKey(c.Name),
			wantID: c.ChainID,
			label:  "chain " + c.Name,
		})
	}
	for _, a := range doc.Assets {
		rows = append(rows, row{
			kind:   KindAsset,
			key:    AssetKey(AssetKind(a.Kind), a.Symbol),
			wantID: a.AssetID,
			label:  "asset " + a.Symbol,
		})
	}
	for _, tok := range doc.Tokens {
		cname := chainNameByID[tok.ChainID]
		rows = append(rows, row{
			kind:   KindToken,
			key:    TokenKey(cname, tok.Address),
			wantID: tok.TokenID,
			label:  "token " + tok.Address,
		})
	}
	// Venues: the artifact's venue rows key on the venue id the tree already
	// uses. The row's `name` is the display name; the natural key carries the
	// id, so take the id segment from the natural key itself ("venue/<id>")
	// and prove VenueKey rebuilds it byte-for-byte.
	for _, v := range doc.Venues {
		id := strings.TrimPrefix(v.NaturalKey, "venue/")
		rows = append(rows, row{
			kind:   KindVenue,
			key:    VenueKey(id),
			wantID: v.VenueID,
			label:  "venue " + id,
		})
	}
	if len(rows) < 30 {
		t.Fatalf("parity fixture shrank: only %d rows, need >= 30", len(rows))
	}
	checked := map[EntityKind]int{}
	for _, r := range rows {
		if got := MintID(r.kind, r.key); got != r.wantID {
			t.Errorf("%s: MintID(%q) = %q, artifact says %q", r.label, r.key, got, r.wantID)
		}
		if k := Kind(r.wantID); k != string(r.kind) {
			t.Errorf("%s: Kind(%q) = %q, want %q", r.label, r.wantID, k, r.kind)
		}
		checked[r.kind]++
	}
	for _, k := range []EntityKind{KindChain, KindAsset, KindToken, KindVenue} {
		if checked[k] == 0 {
			t.Errorf("kind %s: no rows checked - fixture lost the kind", k)
		}
	}
	t.Logf("parity: %d ids re-derived (%d chains, %d assets, %d tokens, %d venues)",
		len(rows), checked[KindChain], checked[KindAsset], checked[KindToken], checked[KindVenue])
}
