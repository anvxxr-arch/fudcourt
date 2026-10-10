package ingest

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"strings"
)

// The data-domain DDL is embedded at build time so the binary never depends
// on the process CWD. The tracked DDL lives OUTSIDE the Go module
// (db/schema/data-schema.sql) and `go:embed` refuses patterns that reach a
// parent directory ("invalid pattern syntax"), so the embed reads a
// byte-identical copy inside the module. The tracked file stays the sole
// owner: schema.sql is a COPIED artifact, and TestEmbeddedSchemaMatchesTracked
// refuses a build whose copy drifted — byte-for-byte, which also catches
// comment-only edits (the comment blocks are documentation a drift guard
// should protect). Same arrangement as the executor's
// apps/executor/internal/repository/schema.go (DR-040 startup-apply
// precedent).
//
//go:embed schema.sql
var embeddedSchemaFS embed.FS

// SchemaSQLPath is the path of the embedded copy relative to this package.
// It is exported so tests can report the exact file they compared.
const SchemaSQLPath = "schema.sql"

// SchemaSQL returns the embedded DDL: the data.* schema definition (29
// tables, 13 hypertables, named constraints and secondary indexes) that
// Apply runs. The returned text is this module's copy — the drift test
// proves it byte-equal to the tracked db/schema/data-schema.sql.
func SchemaSQL() (string, error) {
	b, err := fs.ReadFile(embeddedSchemaFS, SchemaSQLPath)
	if err != nil {
		return "", fmt.Errorf("ingest: embedded %s: %w", SchemaSQLPath, err)
	}
	return string(b), nil
}

// MustSchemaSQL is SchemaSQL panicking on embed failure. The embedded file is
// compiled in; a failure means the build itself is broken, which is worth a
// panic rather than a silent empty schema.
func MustSchemaSQL() string {
	s, err := SchemaSQL()
	if err != nil {
		panic(err)
	}
	return s
}

// SplitStatements splits one multi-statement SQL script into single
// statements, honoring dollar-quoted strings ($$...$$, $tag$...$tag$) and
// single-quoted literals, both of which may legally contain ';' where it is
// NOT a terminator (this schema's DO $$ ... END $$ blocks and quoted defaults
// rely on that). A plain strings.Split(sql, ";") is therefore WRONG here —
// the same reason the executor's splitter exists.
//
// Line comments (-- to end of line) and block comments (/* ... */) are
// recognized so a ';' inside them never terminates, and whitespace/comment-
// only fragments are dropped. Statement text otherwise passes through
// verbatim (trimmed); no quote stripping, no re-formatting — pgx executes
// exactly what is returned.
//
// Fail-visible: an unterminated dollar quote or literal returns an error
// instead of silently truncating the rest of the script.
func SplitStatements(sql string) ([]string, error) {
	var out []string
	var b strings.Builder
	inLine := false  // inside a "-- ..." comment
	inBlock := false // inside a /* ... */ comment
	inSingle := false
	dollarTag := "" // non-empty while inside $tag$...$tag$

	flush := func() {
		s := strings.TrimSpace(b.String())
		b.Reset()
		if s != "" {
			out = append(out, s)
		}
	}

	runes := []rune(sql)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		switch {
		case inLine:
			if c == '\n' {
				inLine = false
				b.WriteRune(c)
			}
		case inBlock:
			if c == '*' && i+1 < len(runes) && runes[i+1] == '/' {
				inBlock = false
				b.WriteString("*/")
				i++
			} else {
				b.WriteRune(c)
			}
		case dollarTag != "":
			if c == '$' && i+len(dollarTag) <= len(runes) &&
				string(runes[i:i+len(dollarTag)]) == dollarTag {
				// Closing tag: write it and skip past it.
				b.WriteString(dollarTag)
				i += len(dollarTag) - 1
				dollarTag = ""
				continue
			}
			b.WriteRune(c)
		case inSingle:
			b.WriteRune(c)
			if c == '\'' {
				// '' is an escaped quote inside a literal, not its end.
				if i+1 < len(runes) && runes[i+1] == '\'' {
					b.WriteByte('\'')
					i++
				} else {
					inSingle = false
				}
			}
		default:
			switch {
			case c == '-' && i+1 < len(runes) && runes[i+1] == '-':
				inLine = true
				i++
			case c == '/' && i+1 < len(runes) && runes[i+1] == '*':
				inBlock = true
				i++
			case c == '\'':
				inSingle = true
				b.WriteRune(c)
			case c == '$':
				tag := dollarTagAt(runes, i)
				if tag != "" {
					dollarTag = tag
					b.WriteString(tag)
					i += len(tag) - 1
				} else {
					b.WriteRune(c)
				}
			case c == ';':
				flush()
			default:
				b.WriteRune(c)
			}
		}
	}
	if inLine || inBlock || inSingle || dollarTag != "" {
		return nil, fmt.Errorf("ingest: unterminated construct in SQL script (inLine=%v inBlock=%v inSingle=%v dollarTag=%q)", inLine, inBlock, inSingle, dollarTag)
	}
	flush()
	return out, nil
}

// dollarTagAt returns the dollar-quote tag starting at runes[i] ('$'), or ""
// if this '$' does not open a dollar quote. A tag is '$', '$tag$' where tag
// is an unquoted identifier-like run ([A-Za-z_][A-Za-z0-9_]*); anything else
// (e.g. '$1' placeholder) is not a quote opener.
func dollarTagAt(runes []rune, i int) string {
	if i >= len(runes) || runes[i] != '$' {
		return ""
	}
	j := i + 1
	for j < len(runes) && (isDollarTagRune(runes[j])) {
		j++
	}
	if j >= len(runes) || runes[j] != '$' {
		return ""
	}
	if j > i+1 && !isDollarTagStart(runes[i+1]) {
		return ""
	}
	return string(runes[i : j+1])
}

func isDollarTagStart(r rune) bool {
	return r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}

func isDollarTagRune(r rune) bool {
	return isDollarTagStart(r) || (r >= '0' && r <= '9')
}

// Apply creates/upgrades the data.* schema by executing the embedded DDL one
// statement at a time: the extended query protocol that pgx uses refuses
// multi-statement strings, and DO $$ blocks make a naive ';' split wrong
// (SplitStatements handles the quoting).
//
// The DDL is idempotent, so Apply is safe to run at every startup — and it
// runs BEFORE the engine loop and either serve surface can accept traffic.
// Fail-visible by construction: it stops at the FIRST failing statement and
// returns that statement's database error wrapped with its 1-based index and
// a short head of the statement text, so startup logs exactly what failed.
//
// pool is the subset of *pgxpool.Pool the applier needs; *pgxpool.Pool
// satisfies it (same interface shape as the executor's repository).
func Apply(ctx context.Context, pool PGConn, logger *slog.Logger) error {
	ddl, err := SchemaSQL()
	if err != nil {
		return err
	}
	stmts, err := SplitStatements(ddl)
	if err != nil {
		return err
	}
	for i, stmt := range stmts {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			head := statementHead(stmt)
			return fmt.Errorf("ingest: apply schema statement %d/%d (%s): %w", i+1, len(stmts), head, err)
		}
		if logger != nil {
			logger.DebugContext(ctx, "ingest: schema statement applied", "index", i+1, "total", len(stmts), "statement", statementHead(stmt))
		}
	}
	if logger != nil {
		logger.InfoContext(ctx, "ingest: schema applied", "statements", len(stmts))
	}
	return nil
}

// PGConn is the subset of *pgxpool.Pool (and *pgx.Conn) the schema applier
// needs. Declared here so Apply stays testable against a fake and so the
// engine never needs the concrete pool type.
type PGConn interface {
	Exec(ctx context.Context, sql string, args ...any) (any, error)
}

// statementHead is the short, log-safe label of one DDL statement: its first
// line, bounded so a bootstrap failure stays readable. The DDL carries no
// secrets.
func statementHead(statement string) string {
	head, _, _ := strings.Cut(statement, "\n")
	if len(head) > 72 {
		head = head[:72] + "..."
	}
	return head
}
