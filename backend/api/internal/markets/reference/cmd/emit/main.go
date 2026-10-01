// Command emit writes the canonical reference document to
// shared/contracts/data/reference.json (or to stdout with -stdout), so the id
// space can be shared across services and languages WITHOUT anyone importing
// the producing Go package.
//
// Run from the repository root:
//
//	go run ./backend/api/internal/markets/reference/cmd/emit
//	go run ./backend/api/internal/markets/reference/cmd/emit -check
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

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/markets/reference"
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
			fail(fmt.Errorf("%s does not exist; run: go run ./backend/api/internal/markets/reference/cmd/emit", reference.DocumentPath))
		case readErr != nil:
			fail(readErr)
		case !bytes.Equal(have, want):
			fail(fmt.Errorf("%s is STALE (%d bytes on disk, %d emitted); regenerate with: go run ./backend/api/internal/markets/reference/cmd/emit",
				reference.DocumentPath, len(have), len(want)))
		}
		fmt.Printf("REFERENCE_UP_TO_DATE %s (%d bytes)\n", reference.DocumentPath, len(want))
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

func fail(err error) {
	fmt.Fprintf(os.Stderr, "emit: %v\n", err)
	os.Exit(1)
}
