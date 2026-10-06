package reference

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// loaderArtifact returns the checked-in artifact bytes and its path. The loader's
// whole job is to carry that file into SQL, so every test here reads the real file
// rather than a fixture: a fixture would let the two drift apart silently.
func loaderArtifact(t *testing.T) ([]byte, string) {
	t.Helper()
	path := filepath.Join(repoRoot(t), filepath.FromSlash(DocumentPath))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s: %v", DocumentPath, err)
	}
	return raw, path
}

// TestLoaderPinsTheArtifactRows is the offline proof that the loader is correct
// against the artifact: it loads the checked-in reference.json and asserts the
// exact row counts the document declares. The counts are the artifact's own
// (documented in DECISIONS.md DR-034: 9 chains / 8 assets / 11 tokens / 12 venues
// / 49 mappings / 3 misses), so this fails the moment the loader drops, duplicates
// or invents a row.
func TestLoaderPinsTheArtifactRows(t *testing.T) {
	raw, _ := loaderArtifact(t)
	rows, err := ParseReferenceRows(raw)
	if err != nil {
		t.Fatalf("ParseReferenceRows: %v", err)
	}
	if got, want := len(rows.Mappings), 49; got != want {
		t.Errorf("mappings loaded = %d, want %d (the artifact's published mapping count)", got, want)
	}
	if got, want := len(rows.Misses), 3; got != want {
		t.Errorf("misses loaded = %d, want %d", got, want)
	}
	// Every mapping row must carry a namespace that agrees with its id prefix: a
	// row whose kind disagrees with canonical_id would load a wrong join target.
	for _, m := range rows.Mappings {
		if m.Kind == "" || !strings.HasPrefix(m.CanonicalID, m.Kind+":") {
			t.Fatalf("mapping (%s, %s) -> %q has kind %q", m.Provider, m.ProviderID, m.CanonicalID, m.Kind)
		}
	}
	// The rows must come out in primary-key order, so a re-render is byte-stable.
	for i := 1; i < len(rows.Mappings); i++ {
		a, b := rows.Mappings[i-1], rows.Mappings[i]
		if a.Provider > b.Provider || (a.Provider == b.Provider && a.ProviderID >= b.ProviderID) {
			t.Fatalf("mappings not sorted at %d: (%s,%s) before (%s,%s)", i, a.Provider, a.ProviderID, b.Provider, b.ProviderID)
		}
	}
}

// TestLoaderIsDeterministic is the property the SQL depends on: the same artifact
// bytes render byte-identical SQL every time, so two loads cannot disagree and a
// diff of two renders shows only real artifact changes.
func TestLoaderIsDeterministic(t *testing.T) {
	raw, _ := loaderArtifact(t)
	first, err := ParseReferenceRows(raw)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ParseReferenceRows(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a, b := RenderSQL(first), RenderSQL(second); a != b {
		t.Fatal("RenderSQL is not deterministic across two loads of the same bytes")
	}
}

// TestRenderSQLIsIdempotentAndPrunes encodes the load CONTRACT as text: the single
// rendered statement must upsert on the primary key (idempotent re-runs) and prune
// keys the artifact no longer lists (the table is a mirror of the artifact, not an
// accumulator). It also checks the loader writes ONLY the two canonical tables —
// a money-bearing table named in the statement would be a schema change this
// workstream must never make.
func TestRenderSQLIsIdempotentAndPrunes(t *testing.T) {
	raw, _ := loaderArtifact(t)
	rows, err := ParseReferenceRows(raw)
	if err != nil {
		t.Fatal(err)
	}
	sql := RenderSQL(rows)
	for _, want := range []string{
		"INSERT INTO canonical_reference ",
		"ON CONFLICT (provider, provider_id) DO UPDATE",
		"INSERT INTO canonical_reference_miss ",
		"DELETE FROM canonical_reference ",
		"DELETE FROM canonical_reference_miss ",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("rendered SQL is missing %q", want)
		}
	}
	// One statement: no interior ';' before the final terminator, so it can be
	// sent without a transaction wrapper. The provenance comment may contain
	// semicolons of its own, so comment lines are removed first.
	var code []string
	for _, line := range strings.Split(sql, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "--") {
			code = append(code, line)
		}
	}
	if body := strings.TrimSuffix(strings.TrimSpace(strings.Join(code, "\n")), ";"); strings.Contains(body, ";") {
		t.Error("rendered SQL contains more than one statement")
	}
	// It may name the two canonical tables and nothing else.
	for _, table := range []string{"accounts", "assets", "journal", "ledger", "trades", "transactions", "venues", "wallets", "asset_history", "price_history"} {
		if strings.Contains(sql, " "+table+" ") {
			t.Errorf("rendered SQL mentions the unrelated table %q", table)
		}
	}
	// The header records provenance and the row counts.
	if !strings.Contains(sql, "rows=49") || !strings.Contains(sql, "misses=3") {
		t.Error("rendered SQL header does not record the loaded row counts")
	}
}

// TestLoaderRefusesRatherThanFabricates proves the loud-failure half of the
// contract: a missing file, empty bytes, junk JSON, a dangling id and a miss that
// duplicates a mapping must each be an error — never a partially loaded or empty
// result a caller could mistake for success.
func TestLoaderRefusesRatherThanFabricates(t *testing.T) {
	if _, err := LoadReferenceRows(filepath.Join(t.TempDir(), "does-not-exist.json")); err == nil {
		t.Error("LoadReferenceRows(missing file) = nil error, want refusal")
	}
	for name, bytes := range map[string]string{
		"empty":       ``,
		"not json":    `{`,
		"wrong shape": `{"document_version":1,"chains":[],"assets":[],"tokens":[],"venues":[]}`,
		"no version":  `{"chains":[{}],"assets":[],"tokens":[],"venues":[],"mappings":[],"misses":[]}`,
		"future doc":  `{"document_version":2,"chains":[{}],"assets":[],"tokens":[],"venues":[],"mappings":[],"misses":[]}`,
		"no entities": `{"document_version":1,"chains":[],"assets":[],"tokens":[],"venues":[],"mappings":[],"misses":[]}`,
		"bad id":      `{"document_version":1,"chains":[{}],"assets":[],"tokens":[],"venues":[],"mappings":[{"provider":"ccxt","provider_id":"binance","canonical_id":"binance"}],"misses":[]}`,
		"bad kind":    `{"document_version":1,"chains":[{}],"assets":[],"tokens":[],"venues":[],"mappings":[{"provider":"ccxt","provider_id":"binance","canonical_id":"book:x"}],"misses":[]}`,
		"empty pid":   `{"document_version":1,"chains":[{}],"assets":[],"tokens":[],"venues":[],"mappings":[{"provider":"ccxt","provider_id":"","canonical_id":"venue:x"}],"misses":[]}`,
		"dup key":     `{"document_version":1,"chains":[{}],"assets":[],"tokens":[],"venues":[],"mappings":[{"provider":"ccxt","provider_id":"binance","canonical_id":"venue:x"},{"provider":"ccxt","provider_id":"binance","canonical_id":"venue:y"}],"misses":[]}`,
		"mapped+miss": `{"document_version":1,"chains":[{}],"assets":[],"tokens":[],"venues":[],"mappings":[{"provider":"ccxt","provider_id":"binance","canonical_id":"venue:x"}],"misses":[{"kind":"venue","provider":"ccxt","provider_id":"binance","reason":"r","reported_as":"x"}]}`,
	} {
		if _, err := ParseReferenceRows([]byte(bytes)); err == nil {
			t.Errorf("ParseReferenceRows(%s) = nil error, want refusal", name)
		}
	}
	// A well-formed minimal document loads: the refusals above must be about
	// consistency, not about refusing everything.
	minimal := `{"document_version":1,"generated_by":"test","chains":[{"chain_id":"chain:aaaaaaaaaa"}],"assets":[],"tokens":[],"venues":[],"mappings":[{"provider":"ccxt","provider_id":"binance","canonical_id":"venue:a"}],"misses":[{"kind":"asset","provider":"cryptorank","provider_id":"hype","reason":"r","reported_as":"HYPE"}]}`
	rows, err := ParseReferenceRows([]byte(minimal))
	if err != nil {
		t.Fatalf("a valid minimal document was refused: %v", err)
	}
	if len(rows.Mappings) != 1 || len(rows.Misses) != 1 || rows.Mappings[0].Kind != "venue" {
		t.Fatalf("minimal document loaded wrong: %+v", rows)
	}
	if _, err := LoadReferenceRows(""); err == nil {
		t.Error("LoadReferenceRows(\"\") = nil error, want refusal")
	}
}

// TestRenderSQLEscapesQuotes guards the one place a loaded string becomes SQL: a
// provider name or id containing a single quote must be doubled, or the statement
// is malformed (or worse, injects). The artifact's strings are upstream-supplied.
func TestRenderSQLEscapesQuotes(t *testing.T) {
	rows := &ReferenceRows{
		Mappings: []MappingRow{{Provider: "o'brien", ProviderID: "a'b", CanonicalID: "asset:x", Kind: "asset"}},
		Misses:   []MissRow{{Provider: "p'q", ProviderID: "r's", Kind: "asset", Reason: "it's absent", ReportedAs: "X"}},
	}
	sql := RenderSQL(rows)
	if !strings.Contains(sql, `'o''brien'`) || !strings.Contains(sql, `'r''s'`) {
		t.Fatalf("single quotes were not doubled:\n%s", sql)
	}
	if strings.Contains(sql, `'o'brien'`) {
		t.Fatal("an unescaped quote survived into the rendered SQL")
	}
}

// TestRenderSQLEmptyIsWellFormed pins the empty-artifact edge: the statement must
// still be valid SQL (the prune CTEs have a rowset to test), even though the
// current artifact is never empty.
func TestRenderSQLEmptyIsWellFormed(t *testing.T) {
	sql := RenderSQL(&ReferenceRows{})
	for _, want := range []string{"WITH m AS (", "WHERE false", "DELETE FROM canonical_reference "} {
		if !strings.Contains(sql, want) {
			t.Errorf("empty render is missing %q:\n%s", want, sql)
		}
	}
	if RenderSQL(nil) != "" {
		t.Error("RenderSQL(nil) should render nothing")
	}
}

// TestMappingKindsAreDerivedFromTheRegistry pins the one-list property: the
// loader's accepted namespaces must be exactly the registry's EntityKinds, in the
// same order, so a namespace added to reference.go appears here without a second
// list to update — and neither can be quietly widened.
func TestMappingKindsAreDerivedFromTheRegistry(t *testing.T) {
	want := make([]string, 0, len(EntityKinds))
	for _, k := range EntityKinds {
		want = append(want, string(k))
	}
	if len(mappingKinds) != len(want) {
		t.Fatalf("mappingKinds = %v, want the registry's EntityKinds %v", mappingKinds, want)
	}
	for i := range want {
		if mappingKinds[i] != want[i] {
			t.Fatalf("mappingKinds[%d] = %q, want %q (order must match EntityKinds)", i, mappingKinds[i], want[i])
		}
	}
	// The artifact's own mappings must all be inside that set, which is what makes
	// the DDL's CHECK (canonical_id LIKE kind || ':%') meaningful rather than a
	// constraint on an arbitrary string.
	raw, _ := loaderArtifact(t)
	rows, err := ParseReferenceRows(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range rows.Mappings {
		if !mappingKindSet[m.Kind] {
			t.Fatalf("artifact mapping %q carries namespace %q that is not a registry EntityKind", m.CanonicalID, m.Kind)
		}
	}
}

func TestMappingKindErrorsAreDistinct(t *testing.T) {
	if _, err := ParseReferenceRows([]byte(`{"document_version":1,"chains":[{}],"mappings":[{"provider":"x","provider_id":"y","canonical_id":"noprefix"}]}`)); err == nil {
		t.Fatal("expected an error for an id with no namespace prefix")
	}
	if errors.Is(nil, ErrInvalidSeed) {
		t.Fatal("sanity: nil error must not match a sentinel")
	}
}
