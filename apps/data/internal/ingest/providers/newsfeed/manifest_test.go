package newsfeed

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

// manifestDoc mirrors the manifest wire shape (the `manifest` type is
// unexported, so the test writes its own view).
type manifestDoc struct {
	Version int      `json:"version"`
	Note    string   `json:"note"`
	Sources []Source `json:"sources"`
}

// TestManifestMatchesTable keeps the version-controlled audit trail honest: if
// the Go registry and manifest.json disagree, the manifest is a lie about what
// the engine actually fetches. Regenerate with:
//
//	UPDATE_MANIFEST=1 go test ./apps/data/internal/ingest/providers/newsfeed/ -run TestManifestMatchesTable
func TestManifestMatchesTable(t *testing.T) {
	want, err := buildManifestJSON()
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	const path = "manifest.json"

	if os.Getenv("UPDATE_MANIFEST") == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		t.Logf("regenerated %s", path)
		return
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate: UPDATE_MANIFEST=1 go test -run TestManifestMatchesTable)", path, err)
	}
	if jsonEqual(t, got, want) {
		return
	}
	t.Fatalf("%s is stale vs the Go Sources table; regenerate with UPDATE_MANIFEST=1 go test -run TestManifestMatchesTable", path)
}

func buildManifestJSON() ([]byte, error) {
	srcs := make([]Source, len(Sources))
	copy(srcs, Sources)
	for i := range srcs {
		srcs[i].PollIntervalSeconds = int(srcs[i].PollInterval / time.Second)
		srcs[i].PollInterval = 0
	}
	doc := manifestDoc{
		Version: 1,
		Note: "Audit trail for the news ingestion registry. Runtime truth is the Sources table in sources.go; " +
			"TestManifestMatchesTable keeps this file equal to it. The 158-entry planning inventory is not present " +
			"in this repo: append entries here and load them with LoadManifest, which validates before use.",
		Sources: srcs,
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var av, bv any
	if err := json.Unmarshal(a, &av); err != nil {
		t.Fatalf("parse manifest.json: %v", err)
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		t.Fatalf("parse generated: %v", err)
	}
	return reflect.DeepEqual(av, bv)
}

// TestManifestLoads proves the committed manifest round-trips through
// LoadManifest and validates — the drop-in path for the real inventory.
func TestManifestLoads(t *testing.T) {
	b, err := os.ReadFile("manifest.json")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	srcs, err := LoadManifest(b)
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	if len(srcs) != len(Sources) {
		t.Fatalf("manifest has %d sources, table has %d", len(srcs), len(Sources))
	}
}
