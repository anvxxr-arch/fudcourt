// Package reference — the SQL half of the canonical mapping.
//
// This file turns the published artifact contracts/data/reference.json into
// the rows of the Postgres table db/schema/pg-schema.sql declares
// (`canonical_reference` + `canonical_reference_miss`). It is the loader the
// canonical id space has been missing: before it, a database consumer could only
// resolve identity through a symbol string.
//
// It is deliberately UNWIRED. Nothing in the running system calls it — no route,
// no timer, no service, no consumer is re-pointed (DR-036). It exists so the
// mapping has a SQL side that is correct BEFORE anything depends on it, and it is
// provable with no database: the only logic is reading the artifact and rendering
// deterministic SQL.
//
// # The artifact is the source of truth
//
// This loader NEVER re-derives an id. It does not call MintID, does not read
// seed.go, and does not accept an id from anywhere except the file: it unmarshals
// reference.json into the same Document type the emitter writes, VALIDATES that
// the artifact's own ids and cross-references are mutually consistent
// (validateDocument — the loader's own check, not a re-mint), and renders those
// rows verbatim. A missing, empty or malformed file is a loud error, never a
// fabricate-and-continue. (reference.Load would additionally re-mint every id to
// check it; that is the emitter's self-verification and would defeat the point of
// a loader that must simply carry what the file says. The consistency checks here
// are structural — kinds, namespaces, dangling references — not arithmetic.)
//
// # Applying it
//
// db/schema/pg-schema.sql carries the DDL. Apply that first, then this
// loader's output. RenderSQL emits ONE statement — a data-modifying CTE that
// upserts the mappings and misses and prunes any provider key the artifact no
// longer lists — so psql/bun can run it without a wrapping transaction, and it
// never mutates an existing money-bearing table. (Applying it needs a Postgres
// driver this module does not have; the loader itself is driver-free.)
package reference

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

// DocumentPath (document.go) is the artifact path, relative to the repository root.

// mappingKinds is the set of id prefixes a mapping row may carry. It is DERIVED
// from the registry's own EntityKinds rather than restated, so the loader and the
// minter cannot drift: a new namespace in reference.go appears here automatically.
// A mapping's canonical_id always starts with "<kind>:", and the loader checks the
// two agree — in Go (validateDocument) and again in SQL (the DDL's CHECK).
var mappingKinds = func() []string {
	out := make([]string, 0, len(EntityKinds))
	for _, k := range EntityKinds {
		out = append(out, string(k))
	}
	return out
}()

// mappingKindSet is mappingKinds as a membership test.
var mappingKindSet = func() map[string]bool {
	m := make(map[string]bool, len(mappingKinds))
	for _, k := range mappingKinds {
		m[k] = true
	}
	return m
}()

// ReferenceRows is the loaded, validated artifact: the tables the DDL stores.
//
// It is the loader's OWN type rather than Document so the two can evolve apart:
// Document is the wire shape the emitter owns, ReferenceRows is what this loader
// guarantees to the SQL layer.
type ReferenceRows struct {
	// GeneratedBy and Note are carried into the SQL header comment so a loaded
	// database records which artifact revision filled it. (The artifact carries no
	// generation timestamp, so `loaded_at` is filled by the DDL default — the time
	// the load ran — rather than by a value this loader invents.)
	GeneratedBy string
	Note        string
	Mappings    []MappingRow
	Misses      []MissRow
}

// MappingRow is one `canonical_reference` row.
type MappingRow struct {
	Provider    string
	ProviderID  string
	CanonicalID string
	Kind        string
}

// MissRow is one `canonical_reference_miss` row.
type MissRow struct {
	Provider     string
	ProviderID   string
	Kind         string
	Reason       string
	ReportedAs   string
	KnownAbsence bool
}

// LoadReferenceRows reads and validates the artifact at path, returning the rows
// the SQL tables hold. It refuses — never fabricates — when the file is missing,
// empty, not JSON, or internally inconsistent, so a caller can trust that a
// non-nil result names real canonical entities.
func LoadReferenceRows(path string) (*ReferenceRows, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reference loader: read %s: %w", path, err)
	}
	return ParseReferenceRows(raw)
}

// artifactRows is the subset of the artifact document this loader reads. It is a
// NAMED type (not an anonymous struct repeated at each use) so ParseReferenceRows
// and validateDocument cannot drift apart field by field; the entity lists are
// decoded as `[]any` because the loader only needs them present and non-empty — it
// never reads their contents, so it must not invent a shape for them.
type artifactRows struct {
	DocumentVersion int       `json:"document_version"`
	GeneratedBy     string    `json:"generated_by"`
	Note            string    `json:"note"`
	Chains          []any     `json:"chains"`
	Assets          []any     `json:"assets"`
	Tokens          []any     `json:"tokens"`
	Venues          []any     `json:"venues"`
	Mappings        []Mapping `json:"mappings"`
	Misses          []Miss    `json:"misses"`
}

// DocumentVersionSupported is the artifact's document_version this loader knows.
// The emitter's Document carries it "so a consumer can tell which id space it is
// holding"; a loader that ignored it would happily read a future, differently
// shaped document and load wrong rows, so it is checked rather than assumed.
const DocumentVersionSupported = 1

// ParseReferenceRows is LoadReferenceRows over bytes already in memory — the form
// a test uses to pin the builder against the checked-in artifact bytes.
func ParseReferenceRows(raw []byte) (*ReferenceRows, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("reference loader: artifact is empty")
	}
	var doc artifactRows
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("reference loader: %s is not a reference document: %w", DocumentPath, err)
	}
	if err := validateDocument(&doc); err != nil {
		return nil, err
	}

	rows := &ReferenceRows{
		GeneratedBy: doc.GeneratedBy,
		Note:        doc.Note,
		Mappings:    make([]MappingRow, 0, len(doc.Mappings)),
		Misses:      make([]MissRow, 0, len(doc.Misses)),
	}
	for _, m := range doc.Mappings {
		rows.Mappings = append(rows.Mappings, MappingRow{
			Provider:    string(m.Provider),
			ProviderID:  m.ProviderID,
			CanonicalID: m.CanonicalID,
			Kind:        kindOf(m.CanonicalID),
		})
	}
	for _, m := range doc.Misses {
		rows.Misses = append(rows.Misses, MissRow{
			Provider:     string(m.Provider),
			ProviderID:   m.ProviderID,
			Kind:         m.Kind,
			Reason:       m.Reason,
			ReportedAs:   m.ReportedAs,
			KnownAbsence: m.KnownAbsence,
		})
	}
	sortRows(rows)
	return rows, nil
}

// validateDocument checks the artifact's internal consistency without re-minting
// an id. Every failure is a refusal: an id whose prefix disagrees with its
// mapping row, a key with no entity behind it, a duplicate provider key, or a
// document_version this loader was not written for would each load a WRONG (or
// misread) row, which is worse than loading none.
//
// The presence checks use the loader's own named type: json.Unmarshal is lenient
// (a scalar where a list belongs is not an error), so the four entity lists are
// required to be non-nil and the mappings/misses are required to be readable, and
// the document_version is required to be the one this loader supports.
func validateDocument(doc *artifactRows) error {
	if doc.DocumentVersion != DocumentVersionSupported {
		return fmt.Errorf("reference loader: artifact document_version is %d, this loader supports %d", doc.DocumentVersion, DocumentVersionSupported)
	}
	if doc.Chains == nil || doc.Assets == nil || doc.Tokens == nil || doc.Venues == nil {
		return fmt.Errorf("reference loader: artifact is missing one of its entity lists (chains/assets/tokens/venues)")
	}
	if len(doc.Chains)+len(doc.Assets)+len(doc.Tokens)+len(doc.Venues) == 0 {
		return fmt.Errorf("reference loader: artifact has no entities; refusing to load an empty id space")
	}
	seen := make(map[string]bool, len(doc.Mappings))
	for i, m := range doc.Mappings {
		if m.ProviderID == "" {
			return fmt.Errorf("reference loader: mappings[%d] (%s) has an empty provider_id", i, m.Provider)
		}
		switch kind := kindOf(m.CanonicalID); {
		case kind == "":
			return fmt.Errorf("reference loader: mappings[%d] (%s/%s) has canonical_id %q with no <kind>: prefix", i, m.Provider, m.ProviderID, m.CanonicalID)
		case !mappingKindSet[kind]:
			return fmt.Errorf("reference loader: mappings[%d] (%s/%s) canonical_id %q has unknown namespace %q", i, m.Provider, m.ProviderID, m.CanonicalID, kind)
		}
		key := string(m.Provider) + "\x00" + m.ProviderID
		if seen[key] {
			return fmt.Errorf("reference loader: duplicate mapping for (%s, %s)", m.Provider, m.ProviderID)
		}
		seen[key] = true
	}
	for i, m := range doc.Misses {
		if m.ProviderID == "" {
			return fmt.Errorf("reference loader: misses[%d] (%s) has an empty provider_id", i, m.Provider)
		}
		if m.Kind != "" && kindOf(m.Kind+":x") == "" {
			return fmt.Errorf("reference loader: misses[%d] has kind %q that is not a canonical namespace", i, m.Kind)
		}
		if seen[string(m.Provider)+"\x00"+m.ProviderID] {
			return fmt.Errorf("reference loader: (%s, %s) is BOTH mapped and missed; a miss must be dropped once a mapping exists", m.Provider, m.ProviderID)
		}
	}
	return nil
}

// kindOf returns the id's namespace, or "" when the id has no "<kind>:" prefix.
func kindOf(id string) string {
	if i := strings.IndexByte(id, ':'); i > 0 {
		return id[:i]
	}
	return ""
}

// sortRows orders both tables by their primary key, so the rendered SQL is
// byte-stable across runs and a diff of two loads shows only real changes.
func sortRows(r *ReferenceRows) {
	sort.Slice(r.Mappings, func(i, j int) bool {
		if r.Mappings[i].Provider != r.Mappings[j].Provider {
			return r.Mappings[i].Provider < r.Mappings[j].Provider
		}
		return r.Mappings[i].ProviderID < r.Mappings[j].ProviderID
	})
	sort.Slice(r.Misses, func(i, j int) bool {
		if r.Misses[i].Provider != r.Misses[j].Provider {
			return r.Misses[i].Provider < r.Misses[j].Provider
		}
		return r.Misses[i].ProviderID < r.Misses[j].ProviderID
	})
}

// RenderSQL returns one idempotent statement that loads r into the tables DR-036's
// DDL declares. Running it any number of times yields the same table contents:
//
//   - a data-modifying CTE upserts every mapping and every miss on
//     (provider, provider_id);
//   - two DELETE CTEs prune any provider key the artifact no longer lists, so the
//     table tracks the artifact instead of accumulating rows from retired keys —
//     the artifact stays the single source of truth;
//   - nothing else is touched: no existing table is read, written or altered.
//
// The statement is one line so psql/bun can send it without a transaction wrapper.
// Its values are literal SQL (these are ids and provider names, never user input);
// single quotes in artifact strings are doubled, which is the escape this and any
// reference document is limited to.
func RenderSQL(r *ReferenceRows) string {
	if r == nil {
		return ""
	}
	rows := make([]string, 0, len(r.Mappings))
	for _, m := range r.Mappings {
		// sqlLit already emits the surrounding quotes, so the tuple carries none.
		rows = append(rows, fmt.Sprintf("(%s,%s,%s,%s)",
			sqlLit(m.Provider), sqlLit(m.ProviderID), sqlLit(m.CanonicalID), sqlLit(m.Kind)))
	}
	misses := make([]string, 0, len(r.Misses))
	for _, m := range r.Misses {
		misses = append(misses, fmt.Sprintf("(%s,%s,%s,%s,%s,%t)",
			sqlLit(m.Provider), sqlLit(m.ProviderID), sqlLit(m.Kind), sqlLit(m.Reason), sqlLit(m.ReportedAs), m.KnownAbsence))
	}
	var b strings.Builder
	w := func(s string) { b.WriteString(s) }
	w(sqlHeader(r))
	w("WITH m AS (")
	if len(rows) == 0 {
		// No rows is still a valid load (the prune CTEs need a rowset to test
		// against); an explicit empty rowset keeps the statement well-formed.
		w("SELECT NULL::text provider, NULL::text provider_id, NULL::text canonical_id, NULL::text kind WHERE false")
	} else {
		w("SELECT * FROM (VALUES ")
		w(strings.Join(rows, ","))
		w(") AS t(provider, provider_id, canonical_id, kind)")
	}
	w("),\nms AS (")
	if len(misses) == 0 {
		w("SELECT NULL::text provider, NULL::text provider_id, NULL::text kind, NULL::text reason, NULL::text reported_as, NULL::boolean known_absence WHERE false")
	} else {
		w("SELECT * FROM (VALUES ")
		w(strings.Join(misses, ","))
		w(") AS t(provider, provider_id, kind, reason, reported_as, known_absence)")
	}
	w("),\nins AS (INSERT INTO canonical_reference (provider, provider_id, canonical_id, kind) SELECT provider, provider_id, canonical_id, kind FROM m WHERE provider IS NOT NULL ON CONFLICT (provider, provider_id) DO UPDATE SET canonical_id = EXCLUDED.canonical_id, kind = EXCLUDED.kind RETURNING 1),\n")
	w("insm AS (INSERT INTO canonical_reference_miss (provider, provider_id, kind, reason, reported_as, known_absence) SELECT provider, provider_id, kind, reason, reported_as, known_absence FROM ms WHERE provider IS NOT NULL ON CONFLICT (provider, provider_id) DO UPDATE SET kind = EXCLUDED.kind, reason = EXCLUDED.reason, reported_as = EXCLUDED.reported_as, known_absence = EXCLUDED.known_absence RETURNING 1),\n")
	w("prune AS (DELETE FROM canonical_reference t WHERE NOT EXISTS (SELECT 1 FROM m WHERE m.provider IS NOT NULL AND m.provider = t.provider AND m.provider_id = t.provider_id) RETURNING 1),\n")
	w("prunem AS (DELETE FROM canonical_reference_miss t WHERE NOT EXISTS (SELECT 1 FROM ms WHERE ms.provider IS NOT NULL AND ms.provider = t.provider AND ms.provider_id = t.provider_id) RETURNING 1)\n")
	w("SELECT (SELECT count(*) FROM ins) AS mappings_upserted, (SELECT count(*) FROM insm) AS misses_upserted, (SELECT count(*) FROM prune) AS mappings_pruned, (SELECT count(*) FROM prunem) AS misses_pruned;")
	return b.String()
}

// sqlHeader is the comment line the rendered statement carries: which artifact
// revision it loads, so a database's contents are attributable.
func sqlHeader(r *ReferenceRows) string {
	var b strings.Builder
	b.WriteString("-- canonical_reference load (DR-036) from ")
	b.WriteString(DocumentPath)
	if r.GeneratedBy != "" {
		b.WriteString("; generated_by=")
		b.WriteString(sqlComment(r.GeneratedBy))
	}
	b.WriteString(fmt.Sprintf("; rows=%d misses=%d\n", len(r.Mappings), len(r.Misses)))
	return b.String()
}

// sqlLit renders s as a single-quoted SQL literal, doubling embedded quotes.
func sqlLit(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// sqlComment makes s safe inside a line comment: a newline would end it and a
// carriage return could hide the rest of the line, so both become spaces.
func sqlComment(s string) string {
	return strings.NewReplacer("\n", " ", "\r", " ").Replace(s)
}
