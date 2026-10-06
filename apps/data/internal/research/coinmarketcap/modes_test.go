package coinmarketcap

import "testing"

func TestModeTable(t *testing.T) {
	want := []string{"listing", "global", "marketPairs", "exchanges"}
	if len(Modes) != len(want) {
		t.Fatalf("Modes len = %d, want %d", len(Modes), len(want))
	}
	for i, m := range want {
		if Modes[i] != m {
			t.Errorf("Modes[%d] = %q, want %q (order is part of the 400 contract)", i, Modes[i], m)
		}
		if !Known(m) {
			t.Errorf("Known(%q) = false", m)
		}
	}
	if ModeCount != len(want) {
		t.Errorf("ModeCount = %d, want %d", ModeCount, len(want))
	}
	if Known("nope") {
		t.Error(`Known("nope") = true`)
	}
	if Known("") {
		t.Error(`Known("") = true`)
	}
}

func TestUpstreamURL(t *testing.T) {
	cases := []struct {
		mode         string
		slug         string
		start, limit int
		want         string
	}{
		{"listing", "", 1, 100, Base + "/cryptocurrency/listing?start=1&limit=100"},
		{"exchanges", "", 5, 3, Base + "/exchange/listing?start=5&limit=3"},
		{"global", "", 1, 100, Base + "/global-metrics/quotes/latest"},
		{"marketPairs", "bitcoin", 1, 2, Base + "/cryptocurrency/market-pairs/latest?slug=bitcoin&start=1&limit=2"},
		// default branch falls back to the listing path for an unknown mode,
		// which the handler never reaches (mode is validated first).
		{"", "", 1, 1, Base + "/cryptocurrency/listing?start=1&limit=1"},
	}
	for _, c := range cases {
		if got := UpstreamURL(c.mode, c.slug, c.start, c.limit); got != c.want {
			t.Errorf("UpstreamURL(%q,%q,%d,%d) = %q, want %q", c.mode, c.slug, c.start, c.limit, got, c.want)
		}
	}
}

func TestArrayPath(t *testing.T) {
	cases := map[string]string{
		"listing":     "cryptoCurrencyList",
		"exchanges":   "exchanges",
		"marketPairs": "marketPairs",
		"global":      "", // object payload: no array path, so no row count
	}
	for mode, want := range cases {
		if got := ArrayPath(mode); got != want {
			t.Errorf("ArrayPath(%q) = %q, want %q", mode, got, want)
		}
	}
}

func TestAccepts(t *testing.T) {
	// fresh is accepted everywhere; start/limit only on the paginated modes;
	// slug only on marketPairs.
	cases := []struct {
		mode, param string
		want        bool
	}{
		{"listing", ParamMode, true},
		{"listing", ParamStart, true},
		{"listing", ParamLimit, true},
		{"listing", ParamFresh, true},
		{"listing", ParamSlug, false}, // slug is not a listing param
		{"global", ParamMode, true},
		{"global", ParamFresh, true},
		{"global", ParamStart, false}, // global takes no pagination
		{"global", ParamLimit, false},
		{"global", ParamSlug, false},
		{"marketPairs", ParamSlug, true},
		{"marketPairs", ParamStart, true},
		{"marketPairs", ParamLimit, true},
		{"marketPairs", ParamFresh, true},
		{"exchanges", ParamStart, true},
		{"exchanges", ParamLimit, true},
		{"exchanges", ParamSlug, false},
		{"listing", "bogus", false}, // unknown param is refused, never ignored
	}
	for _, c := range cases {
		if got := Accepts(c.mode, c.param); got != c.want {
			t.Errorf("Accepts(%q,%q) = %v, want %v", c.mode, c.param, got, c.want)
		}
	}
}

func TestParseLimit(t *testing.T) {
	cases := []struct {
		raw    string
		want   int
		wantOK bool
	}{
		{"", DefaultLimit, true}, // omitted -> default
		{"1", 1, true},           // MinLimit
		{"100", 100, true},
		{"1000", 1000, true}, // MaxLimit
		{"0", 0, false},      // the empty-list trap: refused locally
		{"1001", 0, false},   // above MaxLimit
		{"-1", 0, false},     // upstream answers 500; we refuse first
		{"abc", 0, false},    // upstream answers 500; we refuse first
		{"99999", 0, false},  // the 9.6MB page: refused at the door
	}
	for _, c := range cases {
		got, ok := ParseLimit(c.raw)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("ParseLimit(%q) = (%d,%v), want (%d,%v)", c.raw, got, ok, c.want, c.wantOK)
		}
	}
}

func TestParseStart(t *testing.T) {
	cases := []struct {
		raw    string
		want   int
		wantOK bool
	}{
		{"", DefaultStart, true},
		{"1", 1, true},
		{"100", 100, true},
		{"100000", 100000, true}, // MaxStart
		{"0", 0, false},          // below DefaultStart
		{"100001", 0, false},     // above MaxStart
		{"-5", 0, false},
		{"abc", 0, false},
	}
	for _, c := range cases {
		got, ok := ParseStart(c.raw)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("ParseStart(%q) = (%d,%v), want (%d,%v)", c.raw, got, ok, c.want, c.wantOK)
		}
	}
}

func TestValidSlug(t *testing.T) {
	good := []string{"bitcoin", "coinmarketcap-20-index", "usd-coin", "x", "a1-b2"}
	bad := []string{"", "Bitcoin", "bit coin", "bit/coin", "../etc", "btc?x=1", "a_b"}
	for _, s := range good {
		if !ValidSlug(s) {
			t.Errorf("ValidSlug(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if ValidSlug(s) {
			t.Errorf("ValidSlug(%q) = true, want false", s)
		}
	}
}
