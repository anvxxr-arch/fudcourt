package dexcap

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// tierRank orders the plan §3 tiers for fallback: lower rank = higher quality.
// S0 blockchain is ground truth; S5 is Fudcourt's own derived output.
var tierRank = map[string]int{
	"S0": 0, "S1": 1, "S2": 2, "S3": 3, "S4": 4, "S5": 5,
}

// Health is a provider's current liveness as the resolver sees it. It is
// supplied by the reliability recorder (plan §34) at query time rather than
// stored here, so this package stays a pure index.
type Health string

const (
	HealthHealthy      Health = "healthy"
	HealthDegraded     Health = "degraded"
	HealthRateLimited  Health = "rate_limited"
	HealthUnhealthy    Health = "unhealthy"
	HealthUnconfigured Health = "unconfigured"
	HealthDisabled     Health = "disabled"
)

// Usable reports whether a provider in this health state may be selected. An
// unconfigured provider (missing key) and a disabled one are never selected;
// unhealthy and rate-limited ones are skipped when a better option exists but
// allowed as a last resort.
func (h Health) Usable() bool {
	switch h {
	case HealthUnconfigured, HealthDisabled:
		return false
	}
	return true
}

// preferred reports whether a provider in this state should be tried before one
// in the "last resort" bucket.
func (h Health) preferred() bool {
	return h == HealthHealthy || h == HealthDegraded || h == "" // "" = unknown, treat as healthy
}

// HealthFunc reports the current health of a provider. It is injected so this
// package never imports the reliability package (plan §39 keeps the dependency
// arrow pointing INWARD: dexcap knows only an interface).
type HealthFunc func(provider string) Health

// Registry indexes provider descriptors by capability and answers resolution
// queries. It is built once at startup and is read-only thereafter, so it is
// safe for concurrent use without locking on the read path; Register panics on a
// duplicate to keep the index coherent (a duplicate is a wiring bug, not a
// runtime condition).
type Registry struct {
	mu     sync.RWMutex
	byName map[string]Descriptor
	byCap  map[Capability][]Descriptor
	health HealthFunc
}

// NewRegistry builds an empty registry. health may be nil, in which case every
// provider is treated as "unknown" (preferred).
func NewRegistry(health HealthFunc) *Registry {
	return &Registry{
		byName: map[string]Descriptor{},
		byCap:  map[Capability][]Descriptor{},
		health: health,
	}
}

// Register adds a descriptor. It validates the descriptor's capability set and
// requires a distinct name: registering the same provider twice is a wiring bug
// that must fail loudly at startup rather than silently shadow.
func (r *Registry) Register(d Descriptor) error {
	if strings.TrimSpace(d.Name) == "" {
		return fmt.Errorf("dexcap: descriptor has no name")
	}
	for _, c := range d.Capabilities {
		if !c.Valid() {
			return fmt.Errorf("dexcap: provider %q declares unknown capability %q", d.Name, c)
		}
	}
	// An omitted Auth is the keyless zero value, not a malformed one: a
	// descriptor that needs no key simply does not spell AuthNone. Only a
	// NON-empty, non-none auth without a key env is an error.
	if d.Auth != AuthNone && d.Auth != "" && strings.TrimSpace(d.APIKeyEnv) == "" {
		return fmt.Errorf("dexcap: provider %q declares auth %q but no APIKeyEnv", d.Name, d.Auth)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.byName[d.Name]; dup {
		return fmt.Errorf("dexcap: provider %q registered twice", d.Name)
	}
	r.byName[d.Name] = d
	for _, p := range d.pairs() {
		r.byCap[p.Capability] = append(r.byCap[p.Capability], d)
	}
	return nil
}

// MustRegister registers or panics. For startup wiring, where a bad descriptor
// is a build/deploy bug.
func (r *Registry) MustRegister(d Descriptor) {
	if err := r.Register(d); err != nil {
		panic(err)
	}
}

// Descriptor returns one provider's descriptor and whether it is registered.
func (r *Registry) Descriptor(name string) (Descriptor, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.byName[name]
	return d, ok
}

// Names returns every registered provider name, sorted.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.byName))
	for n := range r.byName {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// All returns every registered descriptor, sorted by name.
func (r *Registry) All() []Descriptor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Descriptor, 0, len(r.byName))
	for _, d := range r.byName {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Candidates returns the providers that can serve capability c on chain
// (chainName empty = any chain), ordered by the plan §3 tier and then
// PriorityWithinTier. Unusable providers (unconfigured/disabled) are OMITTED
// entirely; unhealthy/rate-limited ones are returned LAST so Resolve can pick
// them only when nothing better exists.
func (r *Registry) Candidates(c Capability, chainName string) []Descriptor {
	r.mu.RLock()
	descs := append([]Descriptor(nil), r.byCap[c]...)
	health := r.health
	r.mu.RUnlock()

	if !c.Valid() {
		return nil
	}
	chain := strings.ToLower(strings.TrimSpace(chainName))

	usable := make([]Descriptor, 0, len(descs))
	for _, d := range descs {
		if health != nil && !health(d.Name).Usable() {
			continue
		}
		if chain != "" && !d.coversChain(chain) {
			continue
		}
		usable = append(usable, d)
	}
	sort.SliceStable(usable, func(i, j int) bool {
		hi, hj := Health(""), Health("")
		if health != nil {
			hi, hj = health(usable[i].Name), health(usable[j].Name)
		}
		pi, pj := hi.preferred(), hj.preferred()
		if pi != pj {
			return pi // preferred bucket first
		}
		ri, rj := tierRank[usable[i].Tier], tierRank[usable[j].Tier]
		if ri != rj {
			return ri < rj
		}
		return usable[i].PriorityWithinTier < usable[j].PriorityWithinTier
	})
	return usable
}

// Resolve picks the single best provider for capability c on chain. ok is false
// when no usable provider exists — the caller must then fail LOUDLY (plan §65:
// never hide missing data), not fabricate a value.
func (r *Registry) Resolve(c Capability, chainName string) (Descriptor, bool) {
	cs := r.Candidates(c, chainName)
	if len(cs) == 0 {
		return Descriptor{}, false
	}
	return cs[0], true
}

// FallbackChain returns the ordered list of providers to try for capability c
// on chain, best first — the plan §35 fallback chain. The caller walks it until
// one succeeds.
func (r *Registry) FallbackChain(c Capability, chainName string) []Descriptor {
	return r.Candidates(c, chainName)
}

// coversChain reports whether a descriptor covers a chain name. An empty Chains
// list means "chain-agnostic" (all chains) — used only by genuinely global
// sources; a chain-scoped provider lists its chains explicitly.
func (d Descriptor) coversChain(chain string) bool {
	if len(d.Chains) == 0 {
		return true
	}
	for _, c := range d.Chains {
		if strings.EqualFold(strings.TrimSpace(c), chain) {
			return true
		}
	}
	return false
}

// Supports reports whether this descriptor declares capability c.
func (d Descriptor) Supports(c Capability) bool {
	for _, have := range d.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}
