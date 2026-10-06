// Command emit writes the canonical reference document to
// contracts/data/reference.json (or to stdout with -stdout), so the id
// space can be shared across services and languages WITHOUT anyone importing
// the producing Go package.
//
// Run from the repository root:
//
//	go run ./apps/api/internal/markets/reference/cmd/emit
//	go run ./apps/api/internal/markets/reference/cmd/emit -check
//
// -check writes nothing and exits non-zero if the checked-in file is stale,
// which is what the test of the same name calls. The output is deterministic, so
// "stale" means the registry changed and the artifact was not regenerated.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/markets/reference"
)

func main() {
	var (
		toStdout = flag.Bool("stdout", false, "write the document to stdout instead of the file")
		check    = flag.Bool("check", false, "verify the checked-in document is current; write nothing")
		root     = flag.String("root", ".", "repository root the artifact path is relative to")
	)
	flag.Parse()

	ref, err := reference.Build()
	if err != nil {
		fail(err)
	}
	want, err := ref.EmitBytes()
	if err != nil {
		fail(err)
	}

	if *toStdout {
		if _, err := os.Stdout.Write(want); err != nil {
			fail(err)
		}
		return
	}

	path := filepath.Join(*root, filepath.FromSlash(reference.DocumentPath))
	have, readErr := os.ReadFile(path)
	if *check {
		switch {
		case readErr != nil && os.IsNotExist(readErr):
			// Named exactly, because "the artifact is missing" and "the artifact is
			// stale" need different fixes: the first is a checkout problem, the
			// second a regeneration.
			fmt.Printf("REFERENCE_FAIL missing %s\n", reference.DocumentPath)
			fmt.Fprintf(os.Stderr, "emit -check: regenerate with: go run ./apps/api/internal/markets/reference/cmd/emit\n")
			os.Exit(1)
		case readErr != nil:
			fmt.Printf("REFERENCE_FAIL cannot read %s: %v\n", reference.DocumentPath, readErr)
			fmt.Fprintf(os.Stderr, "emit -check: %v\n", readErr)
			os.Exit(1)
		case !bytes.Equal(have, want):
			// Both sides are deterministic, so the report can name the actionable
			// facts: how the sizes differ and the first byte region that differs.
			first, line := firstDifference(have, want)
			fmt.Printf("REFERENCE_FAIL %s is STALE: %d bytes on disk, %d emitted (first difference at byte %d%s)\n",
				reference.DocumentPath, len(have), len(want), first, line)
			fmt.Fprintf(os.Stderr, "emit -check: regenerate with: go run ./apps/api/internal/markets/reference/cmd/emit\n")
			os.Exit(1)
		}
		fmt.Printf("REFERENCE_OK %d bytes\n", len(want))
		return
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		fail(err)
	}
	// Write via a temp file + rename so a reader never observes a partial
	// document (the same atomic-write habit the acquisition sidecar uses for its
	// disk cache).
	tmp, err := os.CreateTemp(filepath.Dir(path), ".reference-*.tmp")
	if err != nil {
		fail(err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(want); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		fail(err)
	}
	// os.CreateTemp is 0600. The document is a generated, non-secret artifact
	// that CI and other tooling read, so give it the conventional 0644 before it
	// is visible under its final name.
	if err := os.Chmod(tmpName, 0o644); err != nil {
		os.Remove(tmpName)
		fail(err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		fail(err)
	}
	fmt.Printf("REFERENCE_WRITTEN %s (%d bytes)\n", reference.DocumentPath, len(want))
}

// firstDifference returns the byte offset of the first position where have and
// want disagree (or min(len) when one is a prefix of the other) and a short
// human-readable line number for that offset. Both arguments come from
// deterministic emitters, so this reports a real divergence rather than a
// heuristic: the caller only reaches it when bytes.Equal was already false.
func firstDifference(have, want []byte) (int, string) {
	n := min(len(have), len(want))
	for i := range n {
		if have[i] != want[i] {
			return i, fmt.Sprintf(", on line %d", 1+bytes.Count(have[:i], []byte("\n")))
		}
	}
	// One is a prefix of the other: the difference is the extra tail.
	return n, fmt.Sprintf(", on line %d (one side ends here)", 1+bytes.Count(have[:n], []byte("\n")))
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "emit: %v\n", err)
	os.Exit(1)
}
