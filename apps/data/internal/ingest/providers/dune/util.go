package dune

import "sort"

// sortedKeys returns a map's keys in sorted order, so series upserts and
// metric writes run deterministically (map iteration order must not decide
// write order).
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
