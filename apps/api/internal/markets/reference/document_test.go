package reference

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestBuildIsDeterministic proves the registry is reproducible: the same seeds
// produce the same ids and the same ORDER, and so does a deliberately shuffled
// insertion order. Nothing may depend on map iteration order - Go randomizes it
// per process, so a registry built from a map would produce a different document
// on every run and this test would catch it.
func TestBuildIsDeterministic(t *testing.T) {
	first, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	firstBytes, err := first.EmitBytes()
	if err != nil {
		t.Fatal(err)
	}
	for i := range 8 {
		again, err := Build()
		if err != nil {
			t.Fatalf("Build() call %d failed: %v", i, err)
		}
		againBytes, err := again.EmitBytes()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(firstBytes, againBytes) {
			t.Fatalf("Build() call %d produced a different document (%d bytes vs %d bytes)",
				i, len(againBytes), len(firstBytes))
		}
	}

	// Shuffled insertion order: reverse every seed table and rebuild. The
	// ordering code must restore the canonical order, so the documents must be
	// byte-identical even though the inputs were reversed.
	shuffled, err := buildFrom(
		func() []seedChain { return reverseSlice(seedChains()) },
		func() []seedAsset { return reverseSlice(seedAssets()) },
		func() []seedToken { return reverseSlice(seedTokens()) },
		func() []seedVenue { return reverseSlice(seedVenues()) },
		nil,
	)
	if err != nil {
		t.Fatalf("Build() from reversed seeds failed: %v", err)
	}
	shuffledBytes, err := shuffled.EmitBytes()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstBytes, shuffledBytes) {
		t.Fatal("reversing the seed insertion order changed the document; something depends on insertion order")
	}
}

func reverseSlice[T any](in []T) []T {
	out := make([]T, 0, len(in))
	for i := len(in) - 1; i >= 0; i-- {
		out = append(out, in[i])
	}
	return out
}

// TestDocumentRoundTrip is the property that makes the artifact usable across
// services: registry -> JSON -> registry yields the same ids, the same ordering
// and the same resolution answers, and re-emitting the loaded registry is
// byte-identical.
func TestDocumentRoundTrip(t *testing.T) {
	original, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	doc1, err := original.EmitBytes()
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(bytes.NewReader(doc1))
	if err != nil {
		t.Fatalf("Load() of our own document failed: %v", err)
	}
	doc2, err := loaded.EmitBytes()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(doc1, doc2) {
		t.Fatalf("round-trip changed the document:\n--- first ---\n%s\n--- second ---\n%s", doc1, doc2)
	}

	// The entities themselves must match, id for id and field for field.
	if len(loaded.Chains) != len(original.Chains) ||
		len(loaded.Assets) != len(original.Assets) ||
		len(loaded.Tokens) != len(original.Tokens) ||
		len(loaded.Venues) != len(original.Venues) ||
		len(loaded.Mappings) != len(original.Mappings) {
		t.Fatalf("round-trip changed the size of the registry: chains %d/%d assets %d/%d tokens %d/%d venues %d/%d mappings %d/%d",
			len(loaded.Chains), len(original.Chains), len(loaded.Assets), len(original.Assets),
			len(loaded.Tokens), len(original.Tokens), len(loaded.Venues), len(original.Venues),
			len(loaded.Mappings), len(original.Mappings))
	}

	// Every resolution answer must survive the trip. This is the property a
	// consumer in another module actually depends on.
	for _, m := range original.Mappings {
		got, err := loaded.Resolve(m.Provider, m.ProviderID)
		if err != nil {
			t.Errorf("loaded registry cannot resolve %s/%s: %v", m.Provider, m.ProviderID, err)
			continue
		}
		if got != m.CanonicalID {
			t.Errorf("loaded Resolve(%s, %s) = %s, want %s", m.Provider, m.ProviderID, got, m.CanonicalID)
		}
	}
	// And every refusal must survive too.
	for _, bad := range []string{"bitcoin", "not-a-coin", "ethereum-2"} {
		if _, err := loaded.Resolve(ProviderCoinGecko, bad); err == nil {
			t.Errorf("loaded registry resolved the unknown identifier %q", bad)
		}
	}
	for _, c := range original.Chains {
		got, err := loaded.Chain(c.ChainID)
		if err != nil {
			t.Errorf("loaded registry lost chain %s: %v", c.ChainID, err)
			continue
		}
		if got.Name != c.Name || got.Kind != c.Kind {
			t.Errorf("chain %s round-tripped as name=%q kind=%q, want name=%q kind=%q",
				c.ChainID, got.Name, got.Kind, c.Name, c.Kind)
		}
	}
}

// TestLoadRefusesCorruptDocuments proves the loader validates instead of
// trusting the file: a hand-edited id, a dangling reference and a wrong salt all
// fail loudly. This is what stops a consumer in another language (or a future
// generator) from feeding in a document that would silently re-identify rows.
func TestLoadRefusesCorruptDocuments(t *testing.T) {
	base, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	good, err := base.EmitBytes()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Load(bytes.NewReader(good)); err != nil {
		t.Fatalf("the untouched document must load: %v", err)
	}

	mutate := func(t *testing.T, edit func(s string) string) string {
		t.Helper()
		return edit(string(good))
	}

	cases := []struct {
		name string
		doc  func(t *testing.T) string
		want error
	}{
		{
			name: "a tampered id",
			doc: func(t *testing.T) string {
				return mutate(t, func(s string) string {
					return strings.Replace(s, `"asset_id": "asset:`, `"asset_id": "asset:ffffffff`, 1)
				})
			},
			want: ErrInvalidDocument,
		},
		{
			name: "a wrong natural key",
			doc: func(t *testing.T) string {
				return mutate(t, func(s string) string {
					return strings.Replace(s, `"natural_key": "chain/arbitrum"`, `"natural_key": "chain/not-arbitrum"`, 1)
				})
			},
			want: ErrInvalidDocument,
		},
		{
			name: "a dangling native-asset reference",
			doc: func(t *testing.T) string {
				return mutate(t, func(s string) string {
					// Target the ETH asset specifically, which every EVM chain
					// names as its native asset, so the mutation is guaranteed to
					// change a real reference.
					return strings.Replace(s, `"asset_id": "asset:d40acc5bec"`, `"asset_id": "asset:0000000000`, 1)
				})
			},
			want: ErrInvalidDocument,
		},
		{
			name: "a dangling mapping target",
			doc: func(t *testing.T) string {
				return mutate(t, func(s string) string {
					return strings.Replace(s, `"canonical_id": "asset:`, `"canonical_id": "asset:deadbeefde`, 1)
				})
			},
			want: ErrInvalidDocument,
		},
		{
			name: "a wrong salt",
			doc: func(t *testing.T) string {
				return mutate(t, func(s string) string {
					return strings.Replace(s, Salt, "some-other-salt", 1)
				})
			},
			want: ErrInvalidDocument,
		},
		{
			name: "an unknown provider",
			doc: func(t *testing.T) string {
				return mutate(t, func(s string) string {
					return strings.Replace(s, `"provider": "coingecko"`, `"provider": "coingeko"`, 1)
				})
			},
			want: ErrInvalidDocument,
		},
		{
			name: "an unknown field",
			doc: func(t *testing.T) string {
				return mutate(t, func(s string) string {
					return strings.Replace(s, `"document_version": 1,`, `"document_version": 1, "surprise": true,`, 1)
				})
			},
			want: ErrInvalidDocument,
		},
		{
			name: "a future document version",
			doc: func(t *testing.T) string {
				return mutate(t, func(s string) string {
					return strings.Replace(s, `"document_version": 1,`, `"document_version": 99,`, 1)
				})
			},
			want: ErrInvalidDocument,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := tc.doc(t)
			if doc == string(good) {
				t.Fatalf("the mutation did not change the document; the test is not testing anything")
			}
			_, err := Load(strings.NewReader(doc))
			if err == nil {
				t.Fatalf("Load() accepted a document with %s", tc.name)
			}
			if !errors.Is(err, ErrInvalidDocument) && !errors.Is(err, ErrDuplicateID) {
				t.Errorf("Load() = %v, want an ErrInvalidDocument/ErrDuplicateID refusal", err)
			}
		})
	}

	// A truncated document is a decode error, not a partial registry.
	_, err = Load(strings.NewReader(string(good)[:len(good)/2]))
	if err == nil {
		t.Error("Load() accepted a truncated document")
	}
}

// TestBuildRefusesCorruptSeeds proves the SEED validation fires, by corrupting a
// copy of each seed table. The tables are injected rather than mutated, so the
// package's real data is never touched.
func TestBuildRefusesCorruptSeeds(t *testing.T) {
	corrupt := func(name string,
		chains func() []seedChain, assets func() []seedAsset,
		tokens func() []seedToken, venues func() []seedVenue,
	) (string, error) {
		_, err := buildFrom(chains, assets, tokens, venues, nil)
		if err == nil {
			return "", nil
		}
		return err.Error(), err
	}

	t.Run("unknown asset kind", func(t *testing.T) {
		assets := seedAssets
		msg, err := corrupt("unknown asset kind", seedChains,
			func() []seedAsset {
				out := assets()
				out[0].kind = "commodity"
				return out
			}, seedTokens, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted an unknown asset kind")
		}
		if !strings.Contains(msg, "kind") {
			t.Errorf("refusal %q does not name the offending field", msg)
		}
	})

	t.Run("unknown chain kind", func(t *testing.T) {
		msg, err := corrupt("unknown chain kind", func() []seedChain {
			out := seedChains()
			out[0].kind = "cosmos"
			return out
		}, seedAssets, seedTokens, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted an unknown chain kind")
		}
		if !strings.Contains(msg, "kind") {
			t.Errorf("refusal %q does not name the offending field", msg)
		}
	})

	t.Run("unknown venue market type", func(t *testing.T) {
		msg, err := corrupt("unknown market type", seedChains, seedAssets, seedTokens,
			func() []seedVenue {
				out := seedVenues()
				out[0].marketTypes = []MarketType{"perpetual"}
				return out
			})
		if err == nil {
			t.Fatal("Build() accepted an unknown market type")
		}
		if !strings.Contains(msg, "market type") {
			t.Errorf("refusal %q does not name the offending field", msg)
		}
	})

	t.Run("duplicate chain name", func(t *testing.T) {
		_, err := corrupt("duplicate chain name", func() []seedChain {
			out := seedChains()
			return append(out, out[0])
		}, seedAssets, seedTokens, seedVenues)
		if !errors.Is(err, ErrDuplicateID) {
			t.Fatalf("Build() = %v, want ErrDuplicateID for a duplicated chain name", err)
		}
	})

	t.Run("duplicate asset symbol", func(t *testing.T) {
		_, err := corrupt("duplicate asset symbol", seedChains,
			func() []seedAsset {
				out := seedAssets()
				return append(out, out[0])
			}, seedTokens, seedVenues)
		if !errors.Is(err, ErrDuplicateID) {
			t.Fatalf("Build() = %v, want ErrDuplicateID for a duplicated asset symbol", err)
		}
	})

	t.Run("unclassifiable token address", func(t *testing.T) {
		msg, err := corrupt("bad address", seedChains, seedAssets,
			func() []seedToken {
				out := seedTokens()
				out[0].address = "0xnot-hex"
				return out
			}, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted an address it cannot classify")
		}
		if !strings.Contains(msg, "address") {
			t.Errorf("refusal %q does not mention the address", msg)
		}
	})

	t.Run("truncated token address", func(t *testing.T) {
		_, err := corrupt("truncated address", seedChains, seedAssets,
			func() []seedToken {
				out := seedTokens()
				// A six-character prefix is exactly the SPL mistake.
				out[0].address = out[0].address[2:8]
				return out
			}, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted a truncated contract address; the SPL mistake would get through")
		}
	})

	t.Run("dangling chain reference on a token", func(t *testing.T) {
		_, err := corrupt("dangling chain", seedChains, seedAssets,
			func() []seedToken {
				out := seedTokens()
				out[0].chainName = "dogechain"
				return out
			}, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted a token on a chain that does not exist")
		}
	})

	t.Run("dangling asset reference on a token", func(t *testing.T) {
		_, err := corrupt("dangling asset", seedChains, seedAssets,
			func() []seedToken {
				out := seedTokens()
				out[0].assetSym = "DOGE"
				return out
			}, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted a token referring to an asset that does not exist")
		}
	})

	t.Run("dangling chain reference on an asset", func(t *testing.T) {
		_, err := corrupt("dangling chain on asset", seedChains,
			func() []seedAsset {
				out := seedAssets()
				out[0].chainName = "dogechain"
				return out
			}, seedTokens, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted an asset on a chain that does not exist")
		}
	})

	t.Run("a schema-illegal provider inside an entity", func(t *testing.T) {
		_, err := corrupt("ccxt inside an asset", seedChains,
			func() []seedAsset {
				out := seedAssets()
				out[0].providers = append(out[0].providers, "ccxt=ethereum")
				return out
			}, seedTokens, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted a provider the asset schema's enum does not allow")
		}
	})

	t.Run("one provider id claiming two entities", func(t *testing.T) {
		// The BNB collision, reproduced deliberately: a bare `coingecko=bnb`
		// on the BSC chain must be refused because the BNB ASSET already
		// claims it. This is the exact bug the seed's surface split fixes.
		_, err := corrupt("colliding provider id", func() []seedChain {
			out := seedChains()
			for i := range out {
				if out[i].name == "bsc" {
					out[i].mappings = append(out[i].mappings, "coingecko=binancecoin")
				}
			}
			return out
		}, seedAssets, seedTokens, seedVenues)
		if !errors.Is(err, ErrDuplicateID) {
			t.Fatalf("Build() = %v, want ErrDuplicateID when one provider id claims two entities", err)
		}
	})

	t.Run("a malformed provider pair", func(t *testing.T) {
		_, err := corrupt("malformed pair", seedChains,
			func() []seedAsset {
				out := seedAssets()
				out[0].providers = append(out[0].providers, "coingecko")
				return out
			}, seedTokens, seedVenues)
		if err == nil {
			t.Fatal("Build() accepted a provider pair with no value")
		}
	})

	t.Run("two mapping rows for one identifier", func(t *testing.T) {
		_, err := buildFrom(seedChains, seedAssets, seedTokens, seedVenues, []Mapping{
			{Provider: ProviderCoinGecko, ProviderID: "ethereum", CanonicalID: "asset:aaaaaaaaaa"},
		})
		if !errors.Is(err, ErrDuplicateID) {
			t.Fatalf("Build() = %v, want ErrDuplicateID for a mapping that contradicts an entity's own provider id", err)
		}
	})
}

// TestReferenceArtifactIsCurrent ties the package to the checked-in artifact:
// contracts/data/reference.json must be exactly what this build emits.
// A stale artifact is a red test, because the artifact is the channel other
// services read - a stale one means they are resolving against an id space this
// build no longer mints.
func TestReferenceArtifactIsCurrent(t *testing.T) {
	root := repoRoot(t)
	path := filepath.Join(root, filepath.FromSlash(DocumentPath))
	ref, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	want, err := ref.EmitBytes()
	if err != nil {
		t.Fatal(err)
	}
	have, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s: %v\nregenerate with: go run %s", DocumentPath, err, emitCmdPath)
	}
	if !bytes.Equal(have, want) {
		t.Fatalf("%s is STALE (%d bytes on disk, %d emitted)\nregenerate with: go run %s", DocumentPath, len(have), len(want), emitCmdPath)
	}
	// The artifact must also LOAD, so a hand-edit that still happens to match a
	// bad emit cannot slip through.
	if _, err := Load(bytes.NewReader(have)); err != nil {
		t.Fatalf("%s does not load: %v", DocumentPath, err)
	}
}

const emitCmdPath = "./backend/api/internal/markets/reference/cmd/emit"

// repoRoot walks up from the test's working directory until it finds go.mod,
// which is the repository root by definition (the single-module layout).
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for range 12 {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not find the repository root (go.mod) walking up from %s", dir)
	return ""
}
