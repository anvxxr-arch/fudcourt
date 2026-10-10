package ingest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSplitStatementsDollarQuoting is the unit test for the splitter using a
// trimmed fixture: ';' inside single quotes, inside DO $$ blocks and inside
// line comments must not terminate; comment-only fragments disappear; the
// statement text passes through verbatim.
func TestSplitStatementsDollarQuoting(t *testing.T) {
	const fixture = `-- leading comment with a ; semicolon
CREATE TABLE IF NOT EXISTS data.a (id text PRIMARY KEY); -- trailing comment
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM x WHERE y = 'a;b') THEN
    PERFORM something(';not a terminator');
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS a_idx ON data.a (id);
SELECT create_hypertable('data.t', 'ts', if_not_exists => TRUE);
-- comment-only fragment (dropped)
DO $body$
RAISE NOTICE 'done; done';
$body$;
SELECT '$1 is not a dollar quote';
`
	stmts, err := SplitStatements(fixture)
	if err != nil {
		t.Fatalf("SplitStatements: %v", err)
	}
	want := []string{
		"CREATE TABLE IF NOT EXISTS data.a (id text PRIMARY KEY)",
		"DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM x WHERE y = 'a;b') THEN\n    PERFORM something(';not a terminator');\n  END IF;\nEND\n$$",
		"CREATE INDEX IF NOT EXISTS a_idx ON data.a (id)",
		"SELECT create_hypertable('data.t', 'ts', if_not_exists => TRUE)",
		"DO $body$\nRAISE NOTICE 'done; done';\n$body$",
		"SELECT '$1 is not a dollar quote'",
	}
	if len(stmts) != len(want) {
		t.Fatalf("got %d statements, want %d:\n%q", len(stmts), len(want), stmts)
	}
	for i, w := range want {
		if stmts[i] != w {
			t.Errorf("statement %d:\n got %q\nwant %q", i, stmts[i], w)
		}
	}
}

// TestSplitStatementsUnterminated fails visibly on a broken script instead
// of silently truncating it.
func TestSplitStatementsUnterminated(t *testing.T) {
	for name, bad := range map[string]string{
		"open dollar quote": "SELECT 1; DO $$ BEGIN",
		"open literal":      "SELECT 'abc",
		"open block":        "SELECT 1; /* never closed",
	} {
		if _, err := SplitStatements(bad); err == nil {
			t.Errorf("%s: want error, got nil", name)
		}
	}
}

// TestSplitStatementsRealSchema pins the splitter against the embedded DDL:
// the statement census (1 schema + 29 tables + 13 hypertables + 11 secondary
// indexes = 54) and spot-checks that every structural statement survived
// whole.
func TestSplitStatementsRealSchema(t *testing.T) {
	ddl := MustSchemaSQL()
	stmts, err := SplitStatements(ddl)
	if err != nil {
		t.Fatalf("SplitStatements(schema): %v", err)
	}
	joined := strings.Join(stmts, "\n;;\n")
	if got := strings.Count(joined, "CREATE TABLE IF NOT EXISTS data."); got != 29 {
		t.Errorf("tables: got %d, want 29", got)
	}
	if got := strings.Count(joined, "create_hypertable("); got != 13 {
		t.Errorf("hypertables: got %d, want 13", got)
	}
	if got := strings.Count(joined, "CREATE INDEX IF NOT EXISTS"); got != 11 {
		t.Errorf("secondary indexes: got %d, want 11", got)
	}
	// No statement may be empty or contain a stray terminator at the end.
	for i, s := range stmts {
		if s == "" {
			t.Errorf("statement %d is empty", i)
		}
		if strings.HasSuffix(s, ";") {
			t.Errorf("statement %d keeps its terminator: %q", i, statementHead(s))
		}
	}
	// The DO-block guards survived as whole statements.
	if got := strings.Count(joined, "DO $$"); got < 1 {
		t.Errorf("DO blocks lost: %d", got)
	}
}

// TestEmbeddedSchemaMatchesTracked is the drift guard: the embedded copy and
// db/schema/data-schema.sql must be BYTE-IDENTICAL. The tracked
// apps/data/internal/ingest/schema.sql is the sole owner; db/schema/
// data-schema.sql is its byte-copy. Byte identity (not normalized) also
// catches comment-only drift — the same reasoning the executor's
// TestEmbeddedSchemaMatchesTracked documents.
func TestEmbeddedSchemaMatchesTracked(t *testing.T) {
	embedded := MustSchemaSQL()

	// The module-local copy (what go:embed reads).
	local, err := os.ReadFile(filepath.Join(".", SchemaSQLPath))
	if err != nil {
		t.Fatalf("read local schema.sql: %v", err)
	}
	// The tracked db/ copy, four directories up from this package.
	tracked, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "db", "schema", "data-schema.sql"))
	if err != nil {
		t.Fatalf("read db/schema/data-schema.sql: %v", err)
	}
	if string(local) != string(tracked) {
		t.Fatal("db/schema/data-schema.sql has drifted from apps/data/internal/ingest/schema.sql: byte copies must stay identical")
	}
	if embedded != string(tracked) {
		t.Fatal("embedded DDL has drifted from the tracked files")
	}
}

// TestSchemaStatementHead keeps the failure label bounded.
func TestSchemaStatementHead(t *testing.T) {
	long := strings.Repeat("x", 100)
	if got := statementHead(long); len(got) != 72+3 {
		t.Errorf("statementHead length = %d, want 75", len(got))
	}
	if got := statementHead("line1\nline2"); got != "line1" {
		t.Errorf("statementHead = %q", got)
	}
}
