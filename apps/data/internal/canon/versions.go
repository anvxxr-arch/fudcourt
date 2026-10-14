package canon

// Schema and normalization versions (storage contract §40): bumped
// deliberately on any change to data-schema.sql semantics or to a
// normalizer's mapping rules. /health and data.schema_version carry these so
// a schema behavior change can never happen silently.
const (
	// SchemaVersion is the semantic version of the tracked
	// db/schema/data-schema.sql the sidecar applies at startup. 1.2.0 adds the
	// additive DEX Data Platform block (17 data.dex_* tables; audit §7): an
	// ADDITIVE change, so a 1.1.0 database upgrades in place with no rewrite.
	SchemaVersion = "1.2.0"
	// NormalizationVersion is the semantic version of the provider→canonical
	// mapping rules (id minting, market-type spelling, unit conventions).
	// 1.1.0 adds the DEX Data Platform natural keys and the exact-numeric
	// (TokenAmount/Dec) mapping rule — a normalization-rule change, so it is
	// bumped deliberately (audit §7).
	NormalizationVersion = "1.1.0"
)
