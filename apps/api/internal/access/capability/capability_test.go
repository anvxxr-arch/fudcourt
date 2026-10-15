package capability

import (
	"reflect"
	"strings"
	"testing"
)

// wantList is the vocabulary the dashboard exposes (§22). It is written out here IN FULL on purpose:
// the mapping table in Postgres stores these strings, so a rename or a removal is a breaking change,
// and this assertion is the only thing that makes someone think about that before doing it.
var wantList = []string{
	"moderation.read", "moderation.warn", "moderation.timeout", "moderation.kick", "moderation.ban",
	"automod.read", "automod.write",
	"logs.read",
	"welcome.read", "welcome.write",
	"roles.read", "roles.manage",
	"custom_commands.read", "custom_commands.manage",
	"feeds.read", "feeds.manage",
	"scheduler.read", "scheduler.manage",
	"settings.read", "settings.manage",
	"permissions.read", "permissions.manage",
}

func TestListIsTheVocabularyWePublish(t *testing.T) {
	if !reflect.DeepEqual(List, wantList) {
		t.Fatalf("List = %v\nwant %v", List, wantList)
	}
}

func TestListIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range List {
		if seen[c] {
			t.Fatalf("%q appears twice — the panel would render it twice and a grant would be ambiguous", c)
		}
		seen[c] = true
		if !strings.HasPrefix(c, Namespace(c)+".") {
			t.Fatalf("%q does not start with its namespace %q plus a dot", c, Namespace(c))
		}
		if !IsKnown(c) {
			t.Fatalf("IsKnown(%q) is false for a capability in List", c)
		}
		if !Acceptable(c) {
			t.Fatalf("Acceptable(%q) is false: the panel could list a capability it refuses to store", c)
		}
	}
}

func TestNamedChecksAreInList(t *testing.T) {
	// A named check that is not in List can never be granted, which would make the guard refuse
	// everyone forever — the worst possible failure: silent and total.
	for _, c := range []string{PermissionsManage} {
		if !IsKnown(c) {
			t.Fatalf("%q is checked by name but absent from List", c)
		}
	}
}

func TestNamespacesAreDistinctAndInListOrder(t *testing.T) {
	got := Namespaces()
	want := []string{
		"moderation", "automod", "logs", "welcome", "roles", "custom_commands",
		"feeds", "scheduler", "settings", "permissions",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Namespaces() = %v\nwant %v", got, want)
	}
}

func TestNamespace(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"moderation.kick", "moderation"},
		{"custom_commands.manage", "custom_commands"},
		{"logs", "logs"}, // no dot: its own namespace, never ""
		{"", ""},
	} {
		if got := Namespace(tc.in); got != tc.want {
			t.Errorf("Namespace(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestAcceptable(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want bool
		why  string
	}{
		{"moderation.read", true, "a known capability"},
		{"moderation.*", true, "the one wildcard shape, over a namespace that exists"},
		{"custom_commands.*", true, "underscored namespaces work the same"},
		{"*", false, `"everything" is the owner override's job, not a one-character grant`},
		{"*.*", false, "two dots is not our wildcard shape"},
		{"moderation.kick.*", false, "a wildcard may not nest"},
		{"nope.*", false, "a wildcard over a namespace nothing implements grants nothing"},
		{"moderation", false, "a bare namespace is neither a capability nor a wildcard"},
		{"moderation.KICK", false, "capabilities are exact and lower-case"},
		{"", false, "an empty grant is a typo, not a grant"},
	} {
		if got := Acceptable(tc.in); got != tc.want {
			t.Errorf("Acceptable(%q) = %v, want %v — %s", tc.in, got, tc.want, tc.why)
		}
	}
}

func TestResolveOwnerHoldsEverything(t *testing.T) {
	set, unknown := Resolve([]string{"nonsense"}, true)
	if len(unknown) != 0 {
		t.Fatalf("unknown = %v, want none — the owner short-circuits before grants are read", unknown)
	}
	if len(set) != len(List) {
		t.Fatalf("owner holds %d capabilities, want %d", len(set), len(List))
	}
	if len(Missing(set)) != 0 {
		t.Fatalf("Missing(owner) = %v, want none", Missing(set))
	}
}

func TestResolveUnionsGrants(t *testing.T) {
	set, unknown := Resolve([]string{"logs.read", "moderation.warn", "logs.read"}, false)
	if len(unknown) != 0 {
		t.Fatalf("unknown = %v", unknown)
	}
	if !Has(set, "logs.read") || !Has(set, "moderation.warn") {
		t.Fatalf("set = %v, want both grants", set)
	}
	// A duplicate grant must not double-count anywhere: the set is a set.
	if len(set) != 2 {
		t.Fatalf("set has %d entries, want 2", len(set))
	}
	if Has(set, "moderation.kick") {
		t.Fatal("a grant to warn must not imply kick")
	}
}

func TestResolveWildcardExpandsWithinItsNamespaceOnly(t *testing.T) {
	set, unknown := Resolve([]string{"moderation.*"}, false)
	if len(unknown) != 0 {
		t.Fatalf("unknown = %v", unknown)
	}
	for _, c := range []string{"moderation.read", "moderation.warn", "moderation.kick", "moderation.ban"} {
		if !Has(set, c) {
			t.Errorf("moderation.* did not grant %q", c)
		}
	}
	for _, c := range []string{"automod.read", "logs.read", "permissions.manage"} {
		if Has(set, c) {
			t.Errorf("moderation.* leaked into %q", c)
		}
	}
	if len(set) != 5 {
		t.Fatalf("moderation.* expanded to %d capabilities, want exactly the 5 in the namespace: %v", len(set), set)
	}
}

func TestResolveDropsAndReportsTheUnknown(t *testing.T) {
	set, unknown := Resolve([]string{"logs.read", "typo.read", "typo.read", "ghost.*"}, false)
	if want := []string{"typo.read", "ghost.*"}; !reflect.DeepEqual(unknown, want) {
		t.Fatalf("unknown = %v, want %v (in the order given, de-duplicated)", unknown, want)
	}
	if Has(set, "typo.read") || Has(set, "ghost.read") {
		t.Fatalf("set = %v: an unknown grant must never resolve to something", set)
	}
	if !Has(set, "logs.read") {
		t.Fatal("a real grant next to an unknown one must still apply")
	}
}

func TestResolveEmpty(t *testing.T) {
	set, unknown := Resolve(nil, false)
	if len(set) != 0 || len(unknown) != 0 {
		t.Fatalf("Resolve(nil) = %v / %v, want an empty set and no drift", set, unknown)
	}
	if Has(set, "logs.read") {
		t.Fatal("an empty grant list must hold nothing")
	}
	if len(Missing(set)) != len(List) {
		t.Fatalf("Missing(empty) = %d entries, want all %d", len(Missing(set)), len(List))
	}
}

func TestHasNilSet(t *testing.T) {
	if Has(nil, "logs.read") {
		t.Fatal("a nil set (no session, no mapping) must hold nothing")
	}
}
