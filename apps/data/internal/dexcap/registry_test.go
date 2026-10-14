package dexcap

import "testing"

func TestRegisterRejectsUnknownCapability(t *testing.T) {
	r := NewRegistry(nil)
	if err := r.Register(Descriptor{Name: "x", Capabilities: []Capability{"bogus"}}); err == nil {
		t.Fatal("unknown capability accepted")
	}
}

func TestRegisterRequiresKeyEnvWhenAuth(t *testing.T) {
	r := NewRegistry(nil)
	if err := r.Register(Descriptor{Name: "x", Auth: AuthAPIKey}); err == nil {
		t.Fatal("api_key provider with no APIKeyEnv accepted")
	}
	if err := r.Register(Descriptor{Name: "y", Auth: AuthAPIKey, APIKeyEnv: "Y_KEY"}); err != nil {
		t.Fatalf("valid keyed provider rejected: %v", err)
	}
}

func TestRegisterRejectsDuplicate(t *testing.T) {
	r := NewRegistry(nil)
	if err := r.Register(Descriptor{Name: "dup", Capabilities: []Capability{CapPrice}}); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(Descriptor{Name: "dup", Capabilities: []Capability{CapPools}}); err == nil {
		t.Fatal("duplicate provider accepted")
	}
}

func TestResolvePrefersHigherTier(t *testing.T) {
	r := NewRegistry(nil)
	r.MustRegister(Descriptor{Name: "agg", Tier: "S3", Capabilities: []Capability{CapPrice}})
	r.MustRegister(Descriptor{Name: "native", Tier: "S1", Capabilities: []Capability{CapPrice}})
	r.MustRegister(Descriptor{Name: "chain", Tier: "S0", Capabilities: []Capability{CapPrice}})
	got, ok := r.Resolve(CapPrice, "")
	if !ok || got.Name != "chain" {
		t.Fatalf("resolve = %q ok=%v, want chain", got.Name, ok)
	}
}

func TestResolveWithinTierUsesPriority(t *testing.T) {
	r := NewRegistry(nil)
	r.MustRegister(Descriptor{Name: "b", Tier: "S3", PriorityWithinTier: 2, Capabilities: []Capability{CapPrice}})
	r.MustRegister(Descriptor{Name: "a", Tier: "S3", PriorityWithinTier: 1, Capabilities: []Capability{CapPrice}})
	got, _ := r.Resolve(CapPrice, "")
	if got.Name != "a" {
		t.Fatalf("resolve = %q, want a", got.Name)
	}
}

func TestCandidatesOmitsUnconfiguredAndDisabled(t *testing.T) {
	health := func(p string) Health {
		switch p {
		case "nokey":
			return HealthUnconfigured
		case "off":
			return HealthDisabled
		}
		return HealthHealthy
	}
	r := NewRegistry(health)
	r.MustRegister(Descriptor{Name: "nokey", Tier: "S0", Capabilities: []Capability{CapPrice}})
	r.MustRegister(Descriptor{Name: "off", Tier: "S0", Capabilities: []Capability{CapPrice}})
	r.MustRegister(Descriptor{Name: "ok", Tier: "S3", Capabilities: []Capability{CapPrice}})
	got := r.Candidates(CapPrice, "")
	if len(got) != 1 || got[0].Name != "ok" {
		t.Fatalf("candidates = %v, want [ok]", names(got))
	}
}

func TestUnhealthyReturnedLast(t *testing.T) {
	health := func(p string) Health {
		if p == "sick" {
			return HealthUnhealthy
		}
		return HealthHealthy
	}
	r := NewRegistry(health)
	r.MustRegister(Descriptor{Name: "sick", Tier: "S0", Capabilities: []Capability{CapPrice}})
	r.MustRegister(Descriptor{Name: "well", Tier: "S3", Capabilities: []Capability{CapPrice}})
	got := r.Candidates(CapPrice, "")
	if len(got) != 2 || got[0].Name != "well" || got[1].Name != "sick" {
		t.Fatalf("order = %v, want [well sick]", names(got))
	}
	// Resolve still returns the healthy one even though sick is a higher tier.
	best, _ := r.Resolve(CapPrice, "")
	if best.Name != "well" {
		t.Fatalf("resolve = %q, want well", best.Name)
	}
}

func TestResolveFailsLoudWhenNothingUsable(t *testing.T) {
	health := func(string) Health { return HealthUnconfigured }
	r := NewRegistry(health)
	r.MustRegister(Descriptor{Name: "nokey", Tier: "S1", Capabilities: []Capability{CapPrice}})
	if _, ok := r.Resolve(CapPrice, ""); ok {
		t.Fatal("resolve succeeded with no usable provider")
	}
}

func TestChainScoping(t *testing.T) {
	r := NewRegistry(nil)
	r.MustRegister(Descriptor{Name: "ethonly", Tier: "S1", Chains: []string{"ethereum"}, Capabilities: []Capability{CapPools}})
	r.MustRegister(Descriptor{Name: "global", Tier: "S3", Capabilities: []Capability{CapPools}})
	if got := r.Candidates(CapPools, "ethereum"); len(got) != 2 {
		t.Fatalf("ethereum candidates = %v, want 2", names(got))
	}
	if got := r.Candidates(CapPools, "base"); len(got) != 1 || got[0].Name != "global" {
		t.Fatalf("base candidates = %v, want [global]", names(got))
	}
}

func TestFallbackChainIsOrdered(t *testing.T) {
	r := NewRegistry(nil)
	r.MustRegister(Descriptor{Name: "c", Tier: "S3", Capabilities: []Capability{CapSwaps}})
	r.MustRegister(Descriptor{Name: "a", Tier: "S1", Capabilities: []Capability{CapSwaps}})
	r.MustRegister(Descriptor{Name: "b", Tier: "S2", Capabilities: []Capability{CapSwaps}})
	got := names(r.FallbackChain(CapSwaps, ""))
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("chain = %v, want [a b c]", got)
	}
}

func TestSupportsAndNames(t *testing.T) {
	r := NewRegistry(nil)
	r.MustRegister(Descriptor{Name: "z", Capabilities: []Capability{CapPrice}})
	r.MustRegister(Descriptor{Name: "a", Capabilities: []Capability{CapPools}})
	if ns := r.Names(); len(ns) != 2 || ns[0] != "a" || ns[1] != "z" {
		t.Fatalf("names = %v", ns)
	}
	d, _ := r.Descriptor("z")
	if !d.Supports(CapPrice) || d.Supports(CapPools) {
		t.Fatal("Supports wrong")
	}
	if _, ok := r.Descriptor("missing"); ok {
		t.Fatal("missing descriptor reported present")
	}
}

func TestHealthUsable(t *testing.T) {
	if HealthUnconfigured.Usable() || HealthDisabled.Usable() {
		t.Fatal("unconfigured/disabled must be unusable")
	}
	for _, h := range []Health{HealthHealthy, HealthDegraded, HealthRateLimited, HealthUnhealthy, ""} {
		if !h.Usable() {
			t.Errorf("%q should be usable", h)
		}
	}
}

func names(ds []Descriptor) []string {
	out := make([]string, len(ds))
	for i, d := range ds {
		out[i] = d.Name
	}
	return out
}
