package canon

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// dexTypeNames is the DEX Data Platform's canonical type set. The guard below
// walks each one's STRUCT FIELDS and fails on any float64/float32, because plan
// §65 lists "use floats untuk token balances" as an anti-goal and plan §54
// requires exact numerics for financial data. A new DEX type added without
// extending this list is caught by TestDexTypeListIsComplete.
var dexTypeNames = []string{
	// provenance.go
	"Provenance", "DerivedProvenance", "TokenAmount", "Dec",
	// dex_types.go
	"DexDeployment", "PoolToken", "ProviderObservation", "IngestionCheckpoint",
	"PoolRef", "TokenRef",
	// dex_trading.go
	"Swap", "DexCandle", "DexLiquiditySnapshot", "DexMarketSnapshot",
	// dex_analytics.go
	"LiquiditySource", "RouteLeg", "RouteQuote", "RiskMetric", "MEVEvent",
	"PerpMarket", "FundingSnapshot", "PerpLiquidation", "WalletActivity",
	"DexLiquidityPosition", "DexOrderbookSnapshot", "OrderbookLevel",
}

// parseCanonDir parses every non-test .go file in this package directory.
func parseCanonDir(t *testing.T) (*token.FileSet, map[string]*ast.File) {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	fset := token.NewFileSet()
	files := map[string]*ast.File{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		files[name] = f
	}
	if len(files) == 0 {
		t.Fatal("parsed no canon source files")
	}
	return fset, files
}

// TestDexTypesCarryNoFloats is the structural guard: no field of any DEX
// canonical type may be a float64/float32, directly or inside a slice/map/array
// element type. This is what keeps a future adapter from quietly reintroducing
// a lossy balance.
func TestDexTypesCarryNoFloats(t *testing.T) {
	fset, files := parseCanonDir(t)
	want := map[string]bool{}
	for _, n := range dexTypeNames {
		want[n] = true
	}
	found := map[string]string{} // type name -> file it was declared in

	for name, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			ts, ok := n.(*ast.TypeSpec)
			if !ok || !want[ts.Name.Name] {
				return true
			}
			st, ok := ts.Type.(*ast.StructType)
			if !ok {
				return true
			}
			found[ts.Name.Name] = name
			for _, field := range st.Fields.List {
				typ := typeString(fset, field.Type)
				if strings.Contains(typ, "float64") || strings.Contains(typ, "float32") {
					pos := fset.Position(field.Pos())
					t.Errorf("%s: %s.%s is %s — DEX canonical types must not carry floats (plan §54/§65)",
						pos, ts.Name.Name, fieldName(field), typ)
				}
			}
			return true
		})
	}

	// Every declared DEX type must actually exist, or the guard is vacuous.
	for _, n := range dexTypeNames {
		if _, ok := found[n]; !ok {
			t.Errorf("DEX type %s not found in canon sources — the guard would not cover it", n)
		}
	}
}

// preExistingNonDex are canon types that PREDATE the DEX work and legitimately
// carry float64 (they belong to the frozen market contract — audit §1.1). They
// are excluded from the "looks like a DEX type" heuristic BY NAME, so a new DEX
// type cannot hide behind a shared prefix.
var preExistingNonDex = map[string]bool{
	"Token":         true, // market token (contract deployment)
	"Pool":          true, // market pool snapshot, instrument-shaped
	"PoolQuery":     true, // the ListPools filter
	"FundingRate":   true, // instrument-keyed funding (perp funding is FundingSnapshot)
	"OrderbookSnap": true, // instrument-keyed depth (DEX depth is DexOrderbookSnapshot)
	"Instrument":    true,
	"Asset":         true,
	"Chain":         true,
	"Venue":         true,
	"Protocol":      true,
	"Trade":         true,
	"Ohlcv":         true,
}

// TestDexTypeListIsComplete fails when a DEX-looking struct exists that the
// guard list does not cover, so adding a type cannot silently skip the check.
func TestDexTypeListIsComplete(t *testing.T) {
	_, files := parseCanonDir(t)
	known := map[string]bool{}
	for _, n := range dexTypeNames {
		known[n] = true
	}
	// The prefix convention: a DEX-specific type is named Dex*, Perp*, Route*,
	// Liquidity*, Risk*, MEV*, Orderbook*, Pool*, Token*, Deployment*,
	// Funding*, Ingestion*.
	prefixes := []string{"Dex", "Perp", "Route", "Liquidity", "Risk", "MEV", "Orderbook", "Pool", "Token", "Deployment", "Funding", "Ingestion"}
	nouns := map[string]bool{"Swap": true, "Candle": true, "WalletActivity": true, "ProviderObservation": true}
	for name, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			ts, ok := n.(*ast.TypeSpec)
			if !ok {
				return true
			}
			if _, isStruct := ts.Type.(*ast.StructType); !isStruct {
				return true
			}
			if known[ts.Name.Name] || preExistingNonDex[ts.Name.Name] {
				return true
			}
			if nouns[ts.Name.Name] {
				t.Errorf("%s: %s is a DEX noun type missing from dexTypeNames", name, ts.Name.Name)
				return true
			}
			for _, p := range prefixes {
				if strings.HasPrefix(ts.Name.Name, p) {
					t.Errorf("%s: %s looks like a DEX type but is missing from dexTypeNames", name, ts.Name.Name)
					break
				}
			}
			return true
		})
	}
}

func fieldName(f *ast.Field) string {
	if len(f.Names) > 0 {
		return f.Names[0].Name
	}
	return "<embedded>"
}

// typeString renders a type expression's source text.
func typeString(fset *token.FileSet, e ast.Expr) string {
	var sb strings.Builder
	switch t := e.(type) {
	case *ast.Ident:
		sb.WriteString(t.Name)
	case *ast.StarExpr:
		sb.WriteString("*")
		sb.WriteString(typeString(fset, t.X))
	case *ast.ArrayType:
		sb.WriteString("[]")
		sb.WriteString(typeString(fset, t.Elt))
	case *ast.MapType:
		sb.WriteString("map[")
		sb.WriteString(typeString(fset, t.Key))
		sb.WriteString("]")
		sb.WriteString(typeString(fset, t.Value))
	case *ast.SelectorExpr:
		sb.WriteString(typeString(fset, t.X))
		sb.WriteString(".")
		sb.WriteString(t.Sel.Name)
	case *ast.StructType:
		sb.WriteString("struct{...}")
	case *ast.InterfaceType:
		sb.WriteString("interface{...}")
	default:
		// Fall back to the raw source span for anything exotic.
		sb.WriteString("?")
	}
	return sb.String()
}
