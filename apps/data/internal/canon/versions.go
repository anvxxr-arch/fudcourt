package canon

// Schema and normalization versions (storage contract §40): bumped
// deliberately on any change to data-schema.sql semantics or to a
// normalizer's mapping rules. /health and data.schema_version carry these so
// a schema behavior change can never happen silently.
const (
	// SchemaVersion is the semantic version of the tracked
	// db/schema/data-schema.sql the sidecar applies at startup.
	SchemaVersion = "1.1.0"
	// NormalizationVersion is the semantic version of the provider→canonical
	// mapping rules (id minting, market-type spelling, unit conventions).
	NormalizationVersion = "1.0.0"
)
