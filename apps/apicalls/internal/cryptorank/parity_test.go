package cryptorank_test

// Parity oracle for the Go port.
//
// For every recorded upstream fixture (apps/web/scripts/fixtures/<mode>.json.gz,
// the raw HelperOut stdout of scripts/cr_fetch.py) this runs the Go envelope()
// with the same opts the TS route uses -- default key for keyed/list modes,
// CR_MODE_UPSTREAM[mode] as the upstream field -- and deep-compares the result
// with the frozen TypeScript output in apps/web/scripts/fixtures/expected/.
//
// The comparison is semantic (unmarshal both, deep-equal) plus an explicit
// report of any key present on one side and absent on the other, so a dropped
// `null` or an accidentally omitted field fails with a readable diff rather
// than "not equal".

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"github.com/anvxxr-arch/fudcourt/apps/apicalls/internal/cryptorank"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// fixturesDir walks up from this source file to apps/web/scripts/fixtures.
func fixturesDir(t *testing.T) string {
	t.Helper()
	if d := os.Getenv("APICALLS_FIXTURES_DIR"); d != "" {
		return d
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	for {
		cand := filepath.Join(dir, "web", "scripts", "fixtures")
		if _, err := os.Stat(filepath.Join(cand, "MANIFEST.json")); err == nil {
			return cand
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("apps/web/scripts/fixtures not found (set APICALLS_FIXTURES_DIR to run parity)")
		}
		dir = parent
	}
}

type manifestMode struct {
	File         string `json:"file"`
	UpstreamPath string `json:"upstreamPath"`
	Sha256       string `json:"sha256"`
	JSONBytes    int    `json:"jsonBytes"`
}

type manifest struct {
	LiveModes int                     `json:"liveModes"`
	Modes     map[string]manifestMode `json:"modes"`
}

// routeOpts mirrors dump-envelopes.ts's routeDefaults: the default key for
// keyed modes and the three whitelisted list modes, nothing for the rest.
func routeOpts(mode string) cryptorank.Opts {
	key := ""
	switch {
	case cryptorank.IsKeyed(mode):
		key = cryptorank.DefaultKeys[mode]
	case mode == "exchanges":
		key = cryptorank.DefaultExchange
	case mode == "launchpool":
		key = cryptorank.DefaultLP
	case mode == "nodesale":
		key = cryptorank.DefaultND
	}
	return cryptorank.Opts{Key: key, Upstream: cryptorank.Upstream(mode)}
}

func TestParityAgainstTypeScriptGoldens(t *testing.T) {
	fix := fixturesDir(t)
	raw, err := os.ReadFile(filepath.Join(fix, "MANIFEST.json"))
	if err != nil {
		t.Fatalf("read MANIFEST.json: %v", err)
	}
	var man manifest
	if err := json.Unmarshal(raw, &man); err != nil {
		t.Fatalf("parse MANIFEST.json: %v", err)
	}

	modes := make([]string, 0, len(man.Modes))
	for m := range man.Modes {
		modes = append(modes, m)
	}
	sort.Strings(modes)
	if len(modes) == 0 {
		t.Fatal("MANIFEST declares no modes")
	}
	if man.LiveModes != len(modes) {
		t.Fatalf("MANIFEST liveModes=%d but %d mode entries", man.LiveModes, len(modes))
	}

	live := 0
	for _, mode := range modes {
		mm := man.Modes[mode]
		if !cryptorank.Known(mode) {
			t.Errorf("%s: mode is not in CR_MODES", mode)
			continue
		}
		if cryptorank.IsDisabled(mode) {
			t.Errorf("%s: mode is CR_DISABLED -- it must not have a live envelope", mode)
			continue
		}
		live++
		t.Run(mode, func(t *testing.T) {
			h := loadFixture(t, fix, mm)
			// The MANIFEST path must equal what the route would fetch for the
			// default key, otherwise the oracle would encode a fetch the route
			// never makes.
			path, err := cryptorank.CanonicalPath(mode, routeOpts(mode).Key)
			if err != nil {
				t.Fatalf("canonical path: %v", err)
			}
			if path != mm.UpstreamPath {
				t.Fatalf("route default path %q != MANIFEST upstreamPath %q", path, mm.UpstreamPath)
			}
			opts := routeOpts(mode)
			// upstream must be the string the TS route leaves in place.
			if want := cryptorank.Upstream(mode); opts.Upstream != want {
				t.Fatalf("upstream %q != CR_MODE_UPSTREAM %q", opts.Upstream, want)
			}

			env, err := cryptorank.Envelope(mode, h, opts)
			if err != nil {
				t.Fatalf("envelope refused: %v", err)
			}
			gotRaw, err := json.Marshal(env)
			if err != nil {
				t.Fatalf("marshal (non-finite number?): %v", err)
			}
			assertJSONClean(t, gotRaw)

			wantRaw, err := os.ReadFile(filepath.Join(fix, "expected", mode+".json"))
			if err != nil {
				t.Fatalf("read golden %s.json: %v", mode, err)
			}
			var gotV, wantV interface{}
			if err := json.Unmarshal(gotRaw, &gotV); err != nil {
				t.Fatalf("unmarshal go envelope: %v", err)
			}
			if err := json.Unmarshal(wantRaw, &wantV); err != nil {
				t.Fatalf("unmarshal golden: %v", err)
			}
			if diffs := compare("$", gotV, wantV); len(diffs) > 0 {
				t.Errorf("%s: %d parity difference(s) vs %s.json:\n  %s",
					mode, len(diffs), mode, strings.Join(diffs, "\n  "))
				return
			}
			if !reflect.DeepEqual(gotV, wantV) {
				t.Errorf("%s: deep-equal failed despite no structural diff", mode)
				return
			}
			// Number RENDERING must match too, not just numeric value: TS prints
			// 11500000 and 0.005551724137931036, and encoding/json must produce
			// the same literals (both use shortest round-trip with the same
			// exponent thresholds). Re-marshalling sorts keys, so this compares
			// the numeric literals directly.
			gotCanon, err := json.Marshal(gotV)
			if err != nil {
				t.Fatalf("re-marshal: %v", err)
			}
			wantCanon, err := json.Marshal(wantV)
			if err != nil {
				t.Fatalf("re-marshal golden: %v", err)
			}
			if !bytes.Equal(gotCanon, wantCanon) {
				t.Errorf("%s: canonical JSON differs (number rendering):\n  go: %.200s\n  ts: %.200s",
					mode, gotCanon, wantCanon)
			}
			assertCountInvariant(t, mode, wantV)
		})
	}
	if live != man.LiveModes {
		t.Errorf("checked %d live modes, MANIFEST declares %d", live, man.LiveModes)
	}
}

func loadFixture(t *testing.T, fix string, mm manifestMode) *cryptorank.HelperOut {
	t.Helper()
	f, err := os.Open(filepath.Join(fix, mm.File))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip read: %v", err)
	}
	if mm.JSONBytes != 0 && len(body) != mm.JSONBytes {
		t.Fatalf("fixture is %dB, MANIFEST says %dB", len(body), mm.JSONBytes)
	}
	var h cryptorank.HelperOut
	if err := json.Unmarshal(body, &h); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if h.FetchedAt == 0 {
		t.Fatal("fixture has no fetchedAt (oracle would not be stable)")
	}
	if h.Cache == "" {
		t.Fatal("fixture has no cache field (oracle would not be stable)")
	}
	if !h.OK || h.PageProps == nil {
		t.Fatalf("fixture is not a successful helper payload (ok=%v)", h.OK)
	}
	return &h
}

// compare walks both values and reports every structural difference: a key
// present on one side and absent on the other, a different JSON kind, or a
// different scalar.
func compare(path string, got, want interface{}) []string {
	switch g := got.(type) {
	case map[string]interface{}:
		w, ok := want.(map[string]interface{})
		if !ok {
			return []string{fmt.Sprintf("%s: type %T (go) vs %T (ts)", path, got, want)}
		}
		var out []string
		keys := map[string]bool{}
		for k := range g {
			keys[k] = true
		}
		for k := range w {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			gv, inG := g[k]
			wv, inW := w[k]
			switch {
			case inG && !inW:
				out = append(out, fmt.Sprintf("%s.%s: only in GO (%s)", path, k, brief(gv)))
			case !inG && inW:
				out = append(out, fmt.Sprintf("%s.%s: only in TS (%s)", path, k, brief(wv)))
			default:
				out = append(out, compare(path+"."+k, gv, wv)...)
			}
		}
		return out
	case []interface{}:
		w, ok := want.([]interface{})
		if !ok {
			return []string{fmt.Sprintf("%s: type %T (go) vs %T (ts)", path, got, want)}
		}
		if len(g) != len(w) {
			return []string{fmt.Sprintf("%s: length %d (go) vs %d (ts)", path, len(g), len(w))}
		}
		var out []string
		for i := range g {
			out = append(out, compare(fmt.Sprintf("%s[%d]", path, i), g[i], w[i])...)
		}
		return out
	default:
		if !reflect.DeepEqual(got, want) {
			return []string{fmt.Sprintf("%s: %s (go) vs %s (ts)", path, brief(got), brief(want))}
		}
		return nil
	}
}

func brief(v interface{}) string {
	switch t := v.(type) {
	case string:
		if len(t) > 120 {
			t = t[:120] + "..."
		}
		return strconv.Quote(t)
	case nil:
		return "null"
	case map[string]interface{}:
		return fmt.Sprintf("object{%d keys}", len(t))
	case []interface{}:
		return fmt.Sprintf("array[%d]", len(t))
	default:
		return fmt.Sprintf("%v", v)
	}
}

// assertJSONClean refuses anything JSON cannot carry faithfully (the same rule
// the TS golden generator enforces): no NaN/Infinity, no undefined-equivalents.
func assertJSONClean(t *testing.T, raw []byte) {
	t.Helper()
	for _, bad := range []string{":NaN", ":Infinity", ":-Infinity", `"undefined"`, ":null," + "\n" + "  }"} {
		if bytes.Contains(raw, []byte(bad)) {
			t.Errorf("emitted forbidden token %q", bad)
		}
	}
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Errorf("emitted non-JSON: %v", err)
	}
	walkNumbers(t, "$", v)
}

func walkNumbers(t *testing.T, path string, v interface{}) {
	t.Helper()
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			t.Errorf("%s: non-finite number %v", path, x)
		}
	case map[string]interface{}:
		for k, e := range x {
			walkNumbers(t, path+"."+k, e)
		}
	case []interface{}:
		for i, e := range x {
			walkNumbers(t, path+"["+strconv.Itoa(i)+"]", e)
		}
	}
}

// assertCountInvariant checks the envelope's contract: `count` is the row count
// the envelope actually ships, for every mode that ships rows.
func assertCountInvariant(t *testing.T, mode string, wantV interface{}) {
	t.Helper()
	obj, ok := wantV.(map[string]interface{})
	if !ok {
		t.Fatalf("golden is not an object")
	}
	countF, ok := obj["count"].(float64)
	if !ok {
		t.Fatalf("golden has no numeric count")
	}
	count := int(countF)

	rowArrays := []string{
		"rows", "tagRows", "chainRows", "launchpoolRows", "nodesaleRows",
		"ecosystemRows", "rwaRows", "predictionRows", "newsRows",
		"converterRows", "mediaRows",
	}
	for _, k := range rowArrays {
		if arr, ok := obj[k].([]interface{}); ok {
			if len(arr) != count {
				t.Errorf("%s: count=%d but %s has %d entries", mode, count, k, len(arr))
			}
		}
	}
	if l, ok := obj["listings"].(map[string]interface{}); ok {
		total := 0
		for _, k := range []string{"recentlyAdded", "mostSearched", "mostVisited"} {
			arr, _ := l[k].([]interface{})
			total += len(arr)
		}
		if total != count {
			t.Errorf("%s: count=%d but listings widgets total %d", mode, count, total)
		}
	}
	if _, ok := obj["quarterlyBtc"]; ok {
		btc, _ := obj["quarterlyBtc"].([]interface{})
		eth, _ := obj["quarterlyEth"].([]interface{})
		if len(btc)+len(eth) != count {
			t.Errorf("%s: count=%d but btc(%d)+eth(%d) rows", mode, count, len(btc), len(eth))
		}
	}
	if fr, ok := obj["fundingRounds"].([]interface{}); ok {
		ico, _ := obj["upcomingIco"].([]interface{})
		if len(fr)+len(ico) != count {
			t.Errorf("%s: count=%d but %d rounds + %d ico", mode, count, len(fr), len(ico))
		}
	}
	if ai, ok := obj["aiOverview"].(map[string]interface{}); ok {
		total := 0
		if arr, ok := ai["news"].([]interface{}); ok {
			total += len(arr)
		}
		for _, sec := range []struct{ section, arr string }{
			{"funding", "rounds"},
			{"dropHunting", "activities"},
			{"vesting", "unlocks"},
		} {
			m, _ := ai[sec.section].(map[string]interface{})
			if m == nil {
				continue
			}
			if arr, ok := m[sec.arr].([]interface{}); ok {
				total += len(arr)
			}
		}
		if total != count {
			t.Errorf("%s: count=%d but aiOverview sections total %d", mode, count, total)
		}
	}
}
