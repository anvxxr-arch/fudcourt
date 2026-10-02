package repository

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestParsePoolConfigMatchesTS pins the pool shape to the TypeScript runtime's
// PG_OPTS = { max: 8, idleTimeout: 30 } (store.ts). A drift here (say, an
// uncapped pgxpool) would let one slow venue pin arbitrarily many backends on
// the shared Postgres instance (DR-020).
func TestParsePoolConfigMatchesTS(t *testing.T) {
	cfg, err := parsePoolConfig("postgres://u:p@127.0.0.1:5432/fudcourt")
	if err != nil {
		t.Fatalf("parsePoolConfig: %v", err)
	}
	if cfg.MaxConns != 8 {
		t.Errorf("MaxConns = %d, want 8 (PG_OPTS.max)", cfg.MaxConns)
	}
	if cfg.MaxConnIdleTime != 30*time.Second {
		t.Errorf("MaxConnIdleTime = %v, want 30s (PG_OPTS.idleTimeout)", cfg.MaxConnIdleTime)
	}
}

// TestEmbeddedSchemaMatchesTracked is the drift guard for the embedded DDL
// (mirror of the TS test "§59: the embedded DDL matches the tracked
// database/schema/executor-schema.sql").
//
// It asserts BYTE IDENTITY, not the normalized comparison the TS test uses.
// Justification: the TS side must compare a string literal it re-formats by
// hand, so it legitimately normalizes blank lines and `--` comments away.
// The Go side embeds a literal copy of the file, so there is no formatting
// reason for the two to differ — requiring bytes equal makes this guard
// strictly stronger than the TS one, and it also catches a comment-only edit
// (the schema's comment block is itself documentation a drift test should
// protect). The one thing both guards share is the intent: the tracked
// database/schema/executor-schema.sql is the sole owner of the DDL.
func TestEmbeddedSchemaMatchesTracked(t *testing.T) {
	embedded, err := SchemaSQL()
	if err != nil {
		t.Fatalf("SchemaSQL: %v", err)
	}
	tracked := readTrackedSchema(t)
	if embedded != tracked {
		// Point at the first differing byte rather than dumping both files.
		i := 0
		for i < len(embedded) && i < len(tracked) && embedded[i] == tracked[i] {
			i++
		}
		t.Fatalf("embedded %s drifted from tracked database/schema/executor-schema.sql at byte %d:\n embedded: %q\n tracked:  %q",
			SchemaSQLPath, i, snippet(embedded, i), snippet(tracked, i))
	}
}

// readTrackedSchema reads the sole-owner DDL from the repo, located relative
// to this test file (not the process CWD) so the guard holds under `go test`
// from the module dir, from the repo root, or from CI.
func readTrackedSchema(t *testing.T) string {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "..", "database", "schema", "executor-schema.sql")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read tracked schema %s: %v", path, err)
	}
	return string(b)
}

// snippet is a short, readable window of text around offset i.
func snippet(s string, i int) string {
	lo := i - 24
	if lo < 0 {
		lo = 0
	}
	hi := i + 24
	if hi > len(s) {
		hi = len(s)
	}
	return strings.TrimSpace(s[lo:hi])
}

// TestSplitStatementsMatchesTrackedShape pins the splitter against the real
// schema: one statement per `CREATE …`, no prose/comment fragments, and the
// schema creation leading (exactly what the TS `ensureExecutorSchema` does
// after its own `CREATE SCHEMA` prelude). Statements come back WITHOUT the
// terminating semicolon — the `;` is part of the separator, exactly as
// `String.split(/;\s*\n/)` consumes it.
func TestSplitStatementsMatchesTrackedShape(t *testing.T) {
	ddl, err := SchemaSQL()
	if err != nil {
		t.Fatalf("SchemaSQL: %v", err)
	}
	statements := SplitStatements(ddl)
	if len(statements) != 20 {
		t.Fatalf("tracked schema yielded %d statements, want the full 20-statement DDL set (matches grep -c 'IF NOT EXISTS')", len(statements))
	}
	if statements[0] != "CREATE SCHEMA IF NOT EXISTS executor" {
		t.Errorf("first statement = %q, want the schema creation", statements[0])
	}
	for i, s := range statements {
		if strings.HasPrefix(s, "--") {
			t.Errorf("statement %d is a comment fragment: %q", i+1, s)
		}
		upper := strings.ToUpper(s)
		if !strings.HasPrefix(upper, "CREATE ") {
			t.Errorf("statement %d is not a CREATE: %q", i+1, s)
		}
		if !strings.Contains(upper, "IF NOT EXISTS") {
			t.Errorf("statement %d is not idempotent (no IF NOT EXISTS): %q", i+1, s)
		}
		if strings.Contains(s, ";") {
			t.Errorf("statement %d still carries a semicolon (the separator must consume it): %q", i+1, s)
		}
	}
	// The prose comments in the header carry `;` (e.g. "the Turso->Postgres
	// mirror; the executor"). A bare-`;` split would have torn them into
	// fragments; assert no statement contains a mid-prose newline from them.
	for i, s := range statements {
		if strings.Contains(s, "mirror; the executor") {
			t.Fatalf("statement %d contains header prose — the splitter is not the `;\\s*\\n` split: %q", i+1, s)
		}
	}
}

// TestSplitStatementsTranslation covers the splitter's own edges. Every
// expectation below was produced by running the TS splitter itself under bun:
//
//	bun -e '... split(/;\s*\n/).map(s=>s.trim()).filter(s=>s.length>0)'
//
// so the Go port is pinned to the runtime it replaces, not to a guess.
func TestSplitStatementsTranslation(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"single", "SELECT 1;\n", []string{"SELECT 1"}},
		{"two", "SELECT 1;\nSELECT 2;\n", []string{"SELECT 1", "SELECT 2"}},
		{"semicolon in prose is not a separator", "-- mirror; the executor\nSELECT 1;\n", []string{"SELECT 1"}},
		{"semicolon mid-line is not a separator", "SELECT 1; SELECT 2;\n", []string{"SELECT 1; SELECT 2"}},
		{"crlf line endings", "SELECT 1;\r\nSELECT 2;\r\n", []string{"SELECT 1", "SELECT 2"}},
		{"trailing whitespace before newline", "SELECT 1;  \nSELECT 2;\n", []string{"SELECT 1", "SELECT 2"}},
		{"missing final newline is normalized", "SELECT 1;\nSELECT 2;", []string{"SELECT 1", "SELECT 2"}},
		{"empty", "", nil},
		{"comments only", "-- nothing to do\n", nil},
		{"comment line ending in a semicolon is not a statement", "-- numbers;\nSELECT 1;\n", []string{"SELECT 1"}},
		{"blank runs collapse", "a;\n\n\nb;\n", []string{"a", "b"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SplitStatements(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("SplitStatements(%q) = %q, want %q", tc.in, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("statement %d = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}
