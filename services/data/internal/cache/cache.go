// Package cache is the shared VALK cache layer for the acquisition sidecar
// (DR-019).
//
// Each family already keeps an in-process TTL cache, and those stay: they are
// the L1, and a hit there costs no syscall. What they cannot do is survive a
// restart, and `fudcourt-data` is restarted on every deploy — which is
// exactly when the expensive families are coldest. The measured cost of that:
// the ticker's venue sweep takes ~64 s on a cold process, and api.llama.fi's
// /protocols body is ~9 MB.
//
// So this adds an L2 that outlives the process. Lookup order is L1 -> L2 ->
// upstream, and it FAILS OPEN at every step: if Valkey is unreachable, disabled,
// or returns something unreadable, the caller does exactly what it did before
// this package existed. A cache is an optimisation; it must never become a
// dependency that can take the boards down.
package cache

import (
	"context"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/valkey-io/valkey-go"
)

// DefaultAddr is the loopback Valkey the homeserver runs (valkey-server.service).
const DefaultAddr = "127.0.0.1:6379"

// shared is the process-wide client. One client, one connection pool: the
// families all talk to the same instance, and valkey-go's client is already
// safe for concurrent use.
var (
	shared   valkey.Client
	sharedOn bool
	initOnce sync.Once
)

// Enabled reports whether a usable Valkey client exists. Families call this to
// decide whether to consult the L2 at all, so a disabled cache costs one bool
// read rather than a dial timeout per request.
func Enabled() bool { return sharedOn }

// Init connects once from the environment. It is called by main, so a
// misconfigured cache is reported at startup rather than on the first request:
//
//	FUDCOURT_DATA_CACHE=off            disable the L2 entirely (also: 0, false, no)
//	FUDCOURT_DATA_VALKEY_ADDR=host:port  default 127.0.0.1:6379
//	FUDCOURT_DATA_VALKEY_PASSWORD       default none
//
// A failed connection logs and leaves the L2 disabled; it never returns an
// error, because the sidecar must start and serve without a cache.
func Init() {
	initOnce.Do(func() {
		if v := strings.ToLower(strings.TrimSpace(os.Getenv("FUDCOURT_DATA_CACHE"))); v == "off" || v == "0" || v == "false" || v == "no" {
			log.Printf("cache: L2 disabled by FUDCOURT_DATA_CACHE=%s", v)
			return
		}
		addr := os.Getenv("FUDCOURT_DATA_VALKEY_ADDR")
		if addr == "" {
			addr = DefaultAddr
		}
		client, err := valkey.NewClient(valkey.ClientOption{
			InitAddress: []string{addr},
			Password:    os.Getenv("FUDCOURT_DATA_VALKEY_PASSWORD"),
			// A request must never wait on the cache longer than it would have
			// waited on the upstream call the cache exists to avoid.
			ConnWriteTimeout: 2 * time.Second,
		})
		if err != nil {
			log.Printf("cache: L2 unavailable (%v) - continuing with in-process caches only", err)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
			log.Printf("cache: L2 unreachable at %s (%v) - continuing with in-process caches only", addr, err)
			client.Close()
			return
		}
		shared, sharedOn = client, true
		log.Printf("cache: L2 ready at %s", addr)
	})
}

// DefaultTTL is the L2 lifetime when a family does not name one. It is a floor,
// not a ceiling: use the family's own TTL so L1 and L2 cannot disagree about how
// stale a body may be.
const DefaultTTL = 15 * time.Second

// maxValueBytes caps what will be stored. Some bodies are multi-megabyte (the
// DeFiLlama /protocols payload is ~9 MB); Valkey holds them fine, but a
// pathological response must not be copied into it, and the L1 already covers
// those keys in-process. Bodies above this are simply not stored.
const maxValueBytes = 12 << 20

// Get returns a cached body and whether it was present. A miss — including a
// disabled cache, a transport error, or a value larger than maxValueBytes — is
// reported as (”, false), never as an error: the caller's contract is "cache
// hit or fetch", and a cache failure must resolve to "fetch".
func Get(ctx context.Context, key string) (string, bool) {
	if !sharedOn {
		return "", false
	}
	if key == "" {
		return "", false
	}
	res := shared.Do(ctx, shared.B().Get().Key(key).Build())
	if err := res.Error(); err != nil {
		if err != valkey.Nil {
			log.Printf("cache: get %s failed: %v", key, err)
		}
		return "", false
	}
	body, err := res.ToString()
	if err != nil {
		log.Printf("cache: get %s decode failed: %v", key, err)
		return "", false
	}
	return body, true
}

// Set stores a body for ttl. ttl <= 0 uses DefaultTTL. Failures are logged and
// swallowed: a write that cannot reach Valkey must not fail a fetch that
// already succeeded upstream.
func Set(ctx context.Context, key, body string, ttl time.Duration) {
	if !sharedOn || key == "" || body == "" {
		return
	}
	if len(body) > maxValueBytes {
		return
	}
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if err := shared.Do(ctx, shared.B().Set().Key(key).Value(body).Px(ttl).Build()).Error(); err != nil {
		log.Printf("cache: set %s failed: %v", key, err)
	}
}

// Key namespaces an upstream URL for the L2. Every family keys on the upstream
// URL it would otherwise request, so the key is derivable from a log line and
// two families can never collide.
func Key(family, url string) string {
	return "fudcourt:" + family + ":" + url
}

// Encode packs a body with the numeric facts its family reports alongside it —
// the upstream row count, the fetch time — into one cached value.
//
// The facts must travel with the bytes. A cached body that came back labelled
// "fetched now" would claim a freshness it does not have: the board renders an
// "as of" time, and verify-llama.py/verify-chainrank.py assert the cache mark
// and count on a HIT. The format is one metadata line, then the body verbatim:
//
//	<f1>,<f2>,...\n<body>
//
// Splitting on the FIRST newline is unambiguous even though bodies contain
// newlines (JSON is compact, XML is not).
func Encode(body string, meta ...int64) string {
	parts := make([]string, len(meta))
	for i, m := range meta {
		parts[i] = strconv.FormatInt(m, 10)
	}
	return strings.Join(parts, ",") + "\n" + body
}

// Decode reverses Encode. ok is false for a value that was not produced by
// Encode, which the caller must treat as a miss rather than as a body with
// invented metadata.
func Decode(v string, want int) (body string, meta []int64, ok bool) {
	nl := strings.IndexByte(v, '\n')
	if nl < 0 {
		return "", nil, false
	}
	fields := strings.Split(v[:nl], ",")
	if len(fields) != want {
		return "", nil, false
	}
	meta = make([]int64, want)
	for i, f := range fields {
		n, err := strconv.ParseInt(f, 10, 64)
		if err != nil {
			return "", nil, false
		}
		meta[i] = n
	}
	return v[nl+1:], meta, true
}

// TTLFromEnv reads a seconds-valued TTL override, falling back to fallback when
// unset or unparseable. It exists so each family keeps reading its own
// documented variable (FUDCOURT_DATA_LLAMA_TTL, ...) rather than a shared one.
func TTLFromEnv(name string, fallback time.Duration) time.Duration {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return fallback
}
