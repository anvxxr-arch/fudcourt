package health

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestNoDependenciesIsReady(t *testing.T) {
	results, ready := NewRegistry().Run(context.Background(), time.Second)
	if !ready {
		t.Fatal("a service with no dependencies must be ready")
	}
	if results != nil {
		t.Fatalf("no dependencies must yield no result rows, got %v", results)
	}
}

func TestOneFailedDependencyBlocksReadiness(t *testing.T) {
	r := NewRegistry()
	r.Register("postgres", func(ctx context.Context) error { return nil })
	r.Register("valkey", func(ctx context.Context) error { return errors.New("dial tcp 127.0.0.1:6379: connection refused") })
	results, ready := r.Run(context.Background(), time.Second)
	if ready {
		t.Fatal("readiness must be false when a dependency is down (objective §34)")
	}
	if len(results) != 2 {
		t.Fatalf("every dependency must report, got %d rows", len(results))
	}
	for _, res := range results {
		switch res.Name {
		case "valkey":
			if res.OK || res.Error == "" {
				t.Fatalf("failed check must carry the reason: %+v", res)
			}
		case "postgres":
			if !res.OK {
				t.Fatalf("healthy check must pass: %+v", res)
			}
		}
	}
}

func TestCheckTimeoutFailsClosed(t *testing.T) {
	r := NewRegistry()
	r.Register("slow", func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	_, ready := r.Run(context.Background(), 10*time.Millisecond)
	if ready {
		t.Fatal("a hung dependency must not report ready")
	}
}
