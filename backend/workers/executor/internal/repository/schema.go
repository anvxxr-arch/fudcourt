package repository

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// The executor DDL is embedded at build time so the binary never depends on
// the process CWD. The tracked DDL lives OUTSIDE this Go module
// (database/schema/executor-schema.sql) and `go:embed` refuses patterns that
// reach a parent directory ("invalid pattern syntax"), so the embed reads a
// byte-identical copy inside the module. The tracked file stays the sole
// owner: schema/executor-schema.sql is a COPIED artifact, and
// TestEmbeddedSchemaMatchesTracked below refuses a build whose copy drifted —
// byte-for-byte, which is stricter than the normalized comparison the TS
// side needs (see that test).
//
//go:embed schema/executor-schema.sql
var embeddedSchemaFS embed.FS

// SchemaSQLPath is the path of the embedded copy relative to this package. It
// names the artifact the drift guard pins and EnsureSchema applies; it is
// exported so the drift test can report the exact file it compared.
const SchemaSQLPath = "schema/executor-schema.sql"

// SchemaSQL returns the embedded DDL: the executor.* schema definition that
// EnsureSchema applies. The returned text is this module's copy — the drift
// guard proves it byte-equal to the tracked database/schema/executor-schema.sql.
func SchemaSQL() (string, error) {
	b, err := embeddedSchemaFS.ReadFile(SchemaSQLPath)
	if err != nil {
		return "", fmt.Errorf("repository: read embedded schema: %w", err)
	}
	return string(b), nil
}

// SplitStatements splits the tracked DDL text into the individual statements a
// driver must send one at a time.
//
// Two steps, chosen to reproduce the TS bootstrap's observable behavior
// exactly (store.ts `ensureExecutorSchema`):
//
//  1. Comment-only lines are dropped. The TS side splits `EXECUTOR_DDL`, a
//     string literal that already contains no comments, so its splitter never
//     sees them. The tracked file DOES carry comments — and its prose contains
//     `;` ("...wire values are numbers;", "the Turso->Postgres mirror; the
//     executor...") — so the Go applier must remove them or a bare-`;` rule
//     would emit comment-only fragments as empty queries. (The TS drift test
//     normalizes the same way, dropping blank and `--` lines.)
//
//  2. The remaining text is split on the `;\s*\n` separator, and the `;` is
//     CONSUMED by the split (as a regex split consumes its delimiter). The
//     extended query protocol refuses multi-statement strings, which is why a
//     split exists at all: each returned statement is sent in its own round
//     trip. Fragments that are empty after trimming are dropped; the final
//     fragment after the last separator is kept when non-empty (mirroring
//     `Array.split`, which always yields the trailing piece).
//
// Every statement in the tracked schema is idempotent (`IF NOT EXISTS`), so
// applying the full set on every start is a no-op after the first.
func SplitStatements(ddl string) []string {
	var cleaned strings.Builder
	for _, line := range strings.Split(ddl, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		cleaned.WriteString(line)
		cleaned.WriteByte('\n')
	}
	text := cleaned.String()
	var out []string
	start := 0
	for i := 0; i < len(text); {
		if text[i] != ';' {
			i++
			continue
		}
		j := i + 1
		for j < len(text) && text[j] != '\n' && isSpace(text[j]) {
			j++
		}
		if j < len(text) && text[j] == '\n' {
			// The separator `;\s*\n` spans [i, j]; the statement ends at i.
			if s := strings.TrimSpace(text[start:i]); s != "" {
				out = append(out, s)
			}
			i = j + 1
			start = i
			continue
		}
		i++
	}
	if s := strings.TrimSpace(text[start:]); s != "" {
		out = append(out, s)
	}
	return out
}

// isSpace reports whether b is whitespace in the sense of the TS `\s` class
// (the splitter above is a direct translation of `;\s*\n`). Newlines are
// handled separately because the separator requires one.
func isSpace(b byte) bool {
	return b < 0x80 && unicode.IsSpace(rune(b))
}

// EnsureSchema applies the tracked executor DDL to s's database, statement by
// statement, idempotently — the Go half of the startup bootstrap the
// TypeScript runtime has always done (store.ts `ensureExecutorSchema`).
//
// The tracked file is the sole owner of the DDL; no statement text is
// duplicated as Go source. Each statement runs in its own round trip because
// the extended query protocol refuses multi-statement strings (the same
// reason the TS splitter exists).
//
// Fail-visible by construction (objective §34): it stops at the FIRST failing
// statement and returns that statement's database error wrapped with its
// 1-based index and leading text, so cmd/executor logs exactly what failed and
// exits non-zero — never a warning over a database whose executor.* schema is
// unusable.
func (s *Store) EnsureSchema(ctx context.Context) error {
	ddl, err := SchemaSQL()
	if err != nil {
		return err
	}
	statements := SplitStatements(ddl)
	if len(statements) == 0 {
		return errors.New("repository: embedded executor schema contains no statements")
	}
	for i, statement := range statements {
		if _, err := s.pool.Exec(ctx, statement); err != nil {
			return fmt.Errorf("repository: apply schema statement %d (%s): %w", i+1, statementHead(statement), err)
		}
	}
	return nil
}

// statementHead is the short, log-safe label of one DDL statement: its first
// line, bounded so a bootstrap failure stays readable. The DDL text carries
// no secrets.
func statementHead(statement string) string {
	head, _, _ := strings.Cut(statement, "\n")
	if len(head) > 72 {
		head = head[:72] + "..."
	}
	return head
}
