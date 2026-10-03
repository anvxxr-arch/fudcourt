package lock

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// Script literals copied verbatim from frontend/web/src/platform/executor/lock.ts.
// The wire tests build their expectations from these literals (not from the
// package constants), so script drift is caught independently.
const (
	releaseLuaOracle   = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
	heartbeatLuaOracle = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
)

// RESP request expectations. The framing (`*N`, `$len`, CRLF) is written
// literally in these formats; only length digits are computed from the
// payloads, so a framing bug in encodeCommand cannot cancel itself out.
func wantSet(key, token, ttlMs string) string {
	return fmt.Sprintf("*6\r\n$3\r\nSET\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n$2\r\nPX\r\n$%d\r\n%s\r\n$2\r\nNX\r\n",
		len(key), key, len(token), token, len(ttlMs), ttlMs)
}

// wantPing renders the exact `PING` request bytes. Written literally like its
// neighbours so a framing change in encodeCommand cannot cancel itself out.
func wantPing() string {
	return "*1\r\n$4\r\nPING\r\n"
}

func wantEval(script, key, token string) string {
	return fmt.Sprintf("*5\r\n$4\r\nEVAL\r\n$%d\r\n%s\r\n$1\r\n1\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n",
		len(script), script, len(key), key, len(token), token)
}

func wantEvalTTL(script, key, token, ttlMs string) string {
	return fmt.Sprintf("*6\r\n$4\r\nEVAL\r\n$%d\r\n%s\r\n$1\r\n1\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n",
		len(script), script, len(key), key, len(token), token, len(ttlMs), ttlMs)
}

// fakeStep is one scripted request→reply exchange on one connection.
type fakeStep struct {
	want         string // exact request bytes expected
	reply        string // reply bytes to write back
	chunk        int    // >0: write the reply in chunks of this many bytes (partial reads)
	dialErr      string // non-empty: the dial fails with this error, no connection is served
	closeNoReply bool   // read the request, then close without replying (mid-op transport failure)

	// multi: this step is a HANDSHAKE (AUTH) and the command that follows it
	// is served over the SAME connection. Dial reserves both steps for it.
	multi bool
	got   string // request bytes actually received (filled by the harness)
}

// fakeValkey is a scripted RESP server behind the Dialer seam. Each dial gets
// one connection and consumes exactly one step (ValkeyLock is one command per
// dial), served over net.Pipe so the real encoding and reply parsing run
// against real I/O.
type fakeValkey struct {
	mu    sync.Mutex
	steps []*fakeStep
	next  int
	dials int
}

func newFakeValkey(steps ...fakeStep) *fakeValkey {
	f := &fakeValkey{}
	for i := range steps {
		f.steps = append(f.steps, &steps[i])
	}
	return f
}

func (f *fakeValkey) Dial(ctx context.Context) (net.Conn, error) {
	f.mu.Lock()
	f.dials++
	if f.next >= len(f.steps) {
		f.mu.Unlock()
		return nil, errors.New("fake valkey: unexpected extra dial")
	}
	step := f.steps[f.next]
	idx := f.next
	// A `multi` step (the AUTH handshake) reserves the command step that
	// follows it: both are replayed over THIS one connection.
	if step.multi && idx+1 < len(f.steps) {
		f.next += 2
	} else {
		f.next++
	}
	f.mu.Unlock()
	if step.dialErr != "" {
		return nil, errors.New(step.dialErr)
	}
	client, server := net.Pipe()
	go f.serve(server, step, idx)
	return client, nil
}

// serve replays one scripted step over one connection. A `multi` step (the
// AUTH handshake) is followed on the SAME connection by the step at idx+1 --
// ValkeyLock.do sends AUTH before its command on one connection, so both
// exchanges share the dial.
func (f *fakeValkey) serve(server net.Conn, step *fakeStep, idx int) {
	defer server.Close()
	cur := step
	curIdx := idx
	for {
		buf := make([]byte, len(cur.want))
		if _, err := io.ReadFull(server, buf); err != nil {
			return
		}
		f.mu.Lock()
		cur.got = string(buf)
		f.mu.Unlock()
		if cur.closeNoReply {
			return
		}
		for i := 0; i < len(cur.reply); {
			n := len(cur.reply) - i
			if cur.chunk > 0 && n > cur.chunk {
				n = cur.chunk
			}
			if _, err := server.Write([]byte(cur.reply[i : i+n])); err != nil {
				return
			}
			i += n
		}
		if !cur.multi {
			return
		}
		f.mu.Lock()
		if curIdx+1 >= len(f.steps) {
			f.mu.Unlock()
			return
		}
		curIdx++
		cur = f.steps[curIdx]
		f.mu.Unlock()
	}
}

func (f *fakeValkey) verify(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.next != len(f.steps) {
		t.Errorf("fake valkey: %d of %d steps served", f.next, len(f.steps))
	}
	for i, s := range f.steps {
		if s.dialErr != "" {
			continue
		}
		if i >= f.next {
			t.Errorf("fake valkey: step %d never served (want request %q)", i, s.want)
			continue
		}
		if s.got != s.want {
			t.Errorf("fake valkey: step %d request bytes\ngot  %q\nwant %q", i, s.got, s.want)
		}
	}
}

// testCtx bounds every wire op so a protocol deadlock surfaces as an error
// instead of a hung test.
func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func newTestValkey(t *testing.T, f *fakeValkey, suffixes ...string) *ValkeyLock {
	t.Helper()
	i := 0
	suffix := func() string {
		if i >= len(suffixes) {
			return "stale"
		}
		s := suffixes[i]
		i++
		return s
	}
	l, err := NewValkeyLock(ValkeyConfig{Dialer: f.Dial, TokenSuffix: suffix})
	if err != nil {
		t.Fatalf("NewValkeyLock: %v", err)
	}
	return l
}

// Reply parsing: +simple string, :integer, $bulk incl. the $-1 null, -error,
// plus the malformed shapes that must be protocol errors, never guesses.
func TestReadReply(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    reply
		wantErr bool
	}{
		{"simple string OK", "+OK\r\n", reply{kind: '+', str: "OK"}, false},
		{"simple string PONG", "+PONG\r\n", reply{kind: '+', str: "PONG"}, false},
		{"integer one", ":1\r\n", reply{kind: ':', num: 1}, false},
		{"integer zero", ":0\r\n", reply{kind: ':', num: 0}, false},
		{"integer other", ":42\r\n", reply{kind: ':', num: 42}, false},
		{"null bulk", "$-1\r\n", reply{kind: '$', null: true}, false},
		{"bulk with payload", "$5\r\nhello\r\n", reply{kind: '$', str: "hello"}, false},
		{"empty bulk", "$0\r\n\r\n", reply{kind: '$', str: ""}, false},
		{"error reply", "-ERR unknown command\r\n", reply{}, true},
		{"unknown prefix", "?wat\r\n", reply{}, true},
		{"bad integer", ":notanint\r\n", reply{}, true},
		{"bad bulk length", "$x\r\n", reply{}, true},
		{"negative bulk length below null", "$-2\r\n", reply{}, true},
		{"short bulk payload", "$5\r\nhell", reply{}, true},
		{"bad bulk trailer", "$5\r\nhelloXY", reply{}, true},
		{"line without CRLF", "+OK", reply{}, true},
		{"empty reply", "", reply{}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := readReply(bufio.NewReader(strings.NewReader(tt.input)))
			if tt.wantErr {
				if err == nil {
					t.Fatalf("readReply(%q) = %v, nil; want error", tt.input, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("readReply(%q) error = %v", tt.input, err)
			}
			if got != tt.want {
				t.Errorf("readReply(%q) = %+v, want %+v", tt.input, got, tt.want)
			}
		})
	}
}

// Acquire wire: exact `SET key token PX <ttlMs> NX` bytes and the SET NX reply
// contract: +OK acquired, $-1 held by someone else, everything else fail-closed.
func TestValkeyLockAcquire(t *testing.T) {
	key := "execution:e1:lock"
	token := "w:abcd"
	tests := []struct {
		name    string
		reply   string
		chunk   int
		wantOK  bool
		wantErr bool
	}{
		{"simple string OK", "+OK\r\n", 0, true, false},
		{"null means held by someone else", "$-1\r\n", 0, false, false},
		{"server error is fail-closed", "-ERR script error\r\n", 0, false, true},
		{"integer reply is unexpected and fail-closed", ":1\r\n", 0, false, true},
		{"bulk OK is unexpected and fail-closed", "$2\r\nOK\r\n", 0, false, true},
		{"OK arriving one byte at a time", "+OK\r\n", 1, true, false},
		{"null arriving one byte at a time", "$-1\r\n", 1, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeValkey(fakeStep{want: wantSet(key, token, "1000"), reply: tt.reply, chunk: tt.chunk})
			l := newTestValkey(t, f, "abcd")
			ok, err := l.Acquire(testCtx(t), "e1", "w", time.Second)
			if ok != tt.wantOK {
				t.Errorf("Acquire = %v, want %v", ok, tt.wantOK)
			}
			if tt.wantErr && !errors.Is(err, ErrUnavailable) {
				t.Errorf("Acquire error = %v, want ErrUnavailable", err)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("Acquire error = %v, want nil", err)
			}
			f.verify(t)
		})
	}
}

// The TTL clamp (lock.ts `Math.max(1, Math.round(ttlMs))`) must be visible on
// the wire: a positive sub-millisecond TTL becomes PX 1, never PX 0.
func TestValkeyLockAcquireTTLClampOnWire(t *testing.T) {
	tests := []struct {
		name    string
		ttl     time.Duration
		wantPX  string
		wantKey string
	}{
		{"sub-millisecond clamps to 1", 500 * time.Microsecond, "1", "execution:e1:lock"},
		{"rounded milliseconds", 1500 * time.Microsecond, "2", "execution:e1:lock"},
		{"plain seconds", 2 * time.Second, "2000", "execution:e1:lock"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeValkey(fakeStep{want: wantSet(tt.wantKey, "w:abcd", tt.wantPX), reply: "+OK\r\n"})
			l := newTestValkey(t, f, "abcd")
			ok, err := l.Acquire(testCtx(t), "e1", "w", tt.ttl)
			if !ok || err != nil {
				t.Fatalf("Acquire = %v, %v; want true, nil", ok, err)
			}
			f.verify(t)
		})
	}
}

// Release wire: exact `EVAL <RELEASE_LUA> 1 key token` bytes (script and argv
// verbatim from lock.ts). :1 (released) and :0 (not owner/expired) are both
// nil; an error reply is reported but best-effort.
func TestValkeyLockRelease(t *testing.T) {
	key := "execution:e1:lock"
	token := "w:abcd"
	tests := []struct {
		name      string
		reply     string
		chunk     int
		wantErr   bool
		wantDials int
	}{
		{"integer one released", ":1\r\n", 0, false, 2},
		{"integer zero is a nil no-op outcome", ":0\r\n", 0, false, 2},
		{"one arriving one byte at a time", ":1\r\n", 1, false, 2},
		{"server error is reported", "-ERR script error\r\n", 0, true, 2},
		{"unexpected reply is reported", "+OK\r\n", 0, true, 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeValkey(
				fakeStep{want: wantSet(key, token, "1000"), reply: "+OK\r\n"},
				fakeStep{want: wantEval(releaseLuaOracle, key, token), reply: tt.reply, chunk: tt.chunk},
			)
			l := newTestValkey(t, f, "abcd")
			if ok, err := l.Acquire(testCtx(t), "e1", "w", time.Second); !ok || err != nil {
				t.Fatalf("Acquire = %v, %v; want true, nil", ok, err)
			}
			err := l.Release(testCtx(t), "e1", "w")
			if tt.wantErr && !errors.Is(err, ErrUnavailable) {
				t.Errorf("Release error = %v, want ErrUnavailable", err)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("Release error = %v, want nil", err)
			}
			if f.dials != tt.wantDials {
				t.Errorf("dials = %d, want %d", f.dials, tt.wantDials)
			}
			f.verify(t)
		})
	}
}

// Renew wire: exact `EVAL <HEARTBEAT_LUA> 1 key token <ttlMs>` bytes. :1 means
// extended, :0 means lease lost (false, nil), anything else fail-closed.
func TestValkeyLockRenew(t *testing.T) {
	key := "execution:e1:lock"
	token := "w:abcd"
	tests := []struct {
		name    string
		reply   string
		chunk   int
		wantOK  bool
		wantErr bool
	}{
		{"integer one extends", ":1\r\n", 0, true, false},
		{"integer zero means lease lost", ":0\r\n", 0, false, false},
		{"one arriving one byte at a time", ":1\r\n", 1, true, false},
		{"server error is fail-closed", "-ERR script error\r\n", 0, false, true},
		{"unexpected reply is fail-closed", "$1\r\n1\r\n", 0, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeValkey(
				fakeStep{want: wantSet(key, token, "1000"), reply: "+OK\r\n"},
				fakeStep{want: wantEvalTTL(heartbeatLuaOracle, key, token, "2000"), reply: tt.reply, chunk: tt.chunk},
			)
			l := newTestValkey(t, f, "abcd")
			if ok, err := l.Acquire(testCtx(t), "e1", "w", time.Second); !ok || err != nil {
				t.Fatalf("Acquire = %v, %v; want true, nil", ok, err)
			}
			ok, err := l.Renew(testCtx(t), "e1", "w", 2*time.Second)
			if ok != tt.wantOK {
				t.Errorf("Renew = %v, want %v", ok, tt.wantOK)
			}
			if tt.wantErr && !errors.Is(err, ErrUnavailable) {
				t.Errorf("Renew error = %v, want ErrUnavailable", err)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("Renew error = %v, want nil", err)
			}
			f.verify(t)
		})
	}
}

// One command per dial (documented on ValkeyLock): each operation opens its own
// connection, sends one command and closes — three ops, three dials.
func TestValkeyLockOneCommandPerDial(t *testing.T) {
	key := "execution:e1:lock"
	token := "w:abcd"
	f := newFakeValkey(
		fakeStep{want: wantSet(key, token, "1000"), reply: "+OK\r\n"},
		fakeStep{want: wantEvalTTL(heartbeatLuaOracle, key, token, "1000"), reply: ":1\r\n"},
		fakeStep{want: wantEval(releaseLuaOracle, key, token), reply: ":1\r\n"},
	)
	l := newTestValkey(t, f, "abcd")
	ctx := testCtx(t)
	if ok, err := l.Acquire(ctx, "e1", "w", time.Second); !ok || err != nil {
		t.Fatalf("Acquire = %v, %v; want true, nil", ok, err)
	}
	if ok, err := l.Renew(ctx, "e1", "w", time.Second); !ok || err != nil {
		t.Fatalf("Renew = %v, %v; want true, nil", ok, err)
	}
	if err := l.Release(ctx, "e1", "w"); err != nil {
		t.Fatalf("Release = %v; want nil", err)
	}
	if f.dials != 3 {
		t.Errorf("dials = %d, want 3 (one command per dial)", f.dials)
	}
	f.verify(t)
}

// Token minting is per-Acquire: two acquires by the same owner string send two
// different tokens over the wire and never alias one lease.
func TestValkeyLockTokenMintedPerAcquire(t *testing.T) {
	key := "execution:e1:lock"
	f := newFakeValkey(
		fakeStep{want: wantSet(key, "w:n1", "1000"), reply: "$-1\r\n"}, // first attempt loses
		fakeStep{want: wantSet(key, "w:n2", "1000"), reply: "+OK\r\n"}, // second attempt: fresh token
	)
	l := newTestValkey(t, f, "n1", "n2")
	ctx := testCtx(t)
	if ok, err := l.Acquire(ctx, "e1", "w", time.Second); ok || err != nil {
		t.Fatalf("first Acquire = %v, %v; want false, nil", ok, err)
	}
	if ok, err := l.Acquire(ctx, "e1", "w", time.Second); !ok || err != nil {
		t.Fatalf("second Acquire = %v, %v; want true, nil", ok, err)
	}
	f.verify(t) // the two SET requests carry w:n1 and w:n2 — they cannot alias
}

// A stale holder (a restarted worker's in-process token map, or an old lease)
// can never release or renew a newer lease: the Lua compares the stored token
// byte-for-byte, so the stale token's EVAL answers :0 and the newer lease
// survives untouched.
func TestValkeyLockStaleOwnerCannotReleaseNewerLease(t *testing.T) {
	key := "execution:e1:lock"
	f := newFakeValkey(
		// inst1 takes the lease with token w:s1.
		fakeStep{want: wantSet(key, "w:s1", "1000"), reply: "+OK\r\n"},
		// The lease expires server-side; inst2 (same owner string, fresh
		// process — new token) takes the newer lease with w:s2.
		fakeStep{want: wantSet(key, "w:s2", "1000"), reply: "+OK\r\n"},
		// inst1's delayed release carries w:s1 → the server compares and
		// answers :0: not the current lease, nothing deleted.
		fakeStep{want: wantEval(releaseLuaOracle, key, "w:s1"), reply: ":0\r\n"},
		// The newer lease is intact: inst2 can still renew it.
		fakeStep{want: wantEvalTTL(heartbeatLuaOracle, key, "w:s2", "1000"), reply: ":1\r\n"},
	)
	inst1 := newTestValkey(t, f, "s1")
	inst2 := newTestValkey(t, f, "s2")
	ctx := testCtx(t)
	if ok, err := inst1.Acquire(ctx, "e1", "w", time.Second); !ok || err != nil {
		t.Fatalf("inst1 Acquire = %v, %v; want true, nil", ok, err)
	}
	if ok, err := inst2.Acquire(ctx, "e1", "w", time.Second); !ok || err != nil {
		t.Fatalf("inst2 Acquire = %v, %v; want true, nil", ok, err)
	}
	if err := inst1.Release(ctx, "e1", "w"); err != nil {
		t.Fatalf("inst1 stale Release = %v; want nil", err)
	}
	if ok, err := inst2.Renew(ctx, "e1", "w", time.Second); !ok || err != nil {
		t.Fatalf("inst2 Renew = %v, %v; want true, nil (newer lease untouched)", ok, err)
	}
	f.verify(t)
}

// Without a held token nothing is sent (lock.ts returns before touching the
// client): Renew answers (false, nil) and Release is a nil NO-OP, zero dials.
func TestValkeyLockNoTokenIsNoOp(t *testing.T) {
	f := newFakeValkey() // any dial would fail the test as an unexpected extra dial
	l := newTestValkey(t, f, "abcd")
	ctx := testCtx(t)
	if ok, err := l.Renew(ctx, "e1", "w", time.Second); ok || err != nil {
		t.Errorf("Renew without lease = %v, %v; want false, nil", ok, err)
	}
	if err := l.Release(ctx, "e1", "w"); err != nil {
		t.Errorf("Release without lease = %v; want nil no-op", err)
	}
	if f.dials != 0 {
		t.Errorf("dials = %d, want 0 (no token → no wire traffic)", f.dials)
	}
	f.verify(t)
}

// FAIL-CLOSED: any transport/protocol failure makes Acquire answer
// (false, ErrUnavailable) and Renew false — the caller must not trade. Release
// is best-effort: it reports the error, drops the local token, and a duplicate
// release is then a nil no-op without wire traffic.
func TestValkeyLockFailClosed(t *testing.T) {
	key := "execution:e1:lock"
	token := "w:abcd"
	tests := []struct {
		name  string
		steps []fakeStep
		run   func(t *testing.T, l *ValkeyLock, ctx context.Context)
	}{
		{
			name:  "acquire fails closed on dial error",
			steps: []fakeStep{{dialErr: "connection refused"}},
			run: func(t *testing.T, l *ValkeyLock, ctx context.Context) {
				ok, err := l.Acquire(ctx, "e1", "w", time.Second)
				if ok {
					t.Error("Acquire = true on dial error; want false (must not trade)")
				}
				if !errors.Is(err, ErrUnavailable) {
					t.Errorf("Acquire error = %v, want ErrUnavailable", err)
				}
			},
		},
		{
			name:  "acquire fails closed when the connection dies mid-command",
			steps: []fakeStep{{want: wantSet(key, token, "1000"), closeNoReply: true}},
			run: func(t *testing.T, l *ValkeyLock, ctx context.Context) {
				ok, err := l.Acquire(ctx, "e1", "w", time.Second)
				if ok {
					t.Error("Acquire = true on dropped connection; want false (must not trade)")
				}
				if !errors.Is(err, ErrUnavailable) {
					t.Errorf("Acquire error = %v, want ErrUnavailable", err)
				}
			},
		},
		{
			name: "renew fails closed on dial error while holding a lease",
			steps: []fakeStep{
				{want: wantSet(key, token, "1000"), reply: "+OK\r\n"},
				{dialErr: "connection refused"},
			},
			run: func(t *testing.T, l *ValkeyLock, ctx context.Context) {
				if ok, err := l.Acquire(ctx, "e1", "w", time.Second); !ok || err != nil {
					t.Fatalf("Acquire = %v, %v; want true, nil", ok, err)
				}
				ok, err := l.Renew(ctx, "e1", "w", time.Second)
				if ok {
					t.Error("Renew = true on dial error; want false (lease lost)")
				}
				if !errors.Is(err, ErrUnavailable) {
					t.Errorf("Renew error = %v, want ErrUnavailable", err)
				}
			},
		},
		{
			name: "release reports the failure best-effort and drops the token",
			steps: []fakeStep{
				{want: wantSet(key, token, "1000"), reply: "+OK\r\n"},
				{want: wantEval(releaseLuaOracle, key, token), closeNoReply: true},
			},
			run: func(t *testing.T, l *ValkeyLock, ctx context.Context) {
				if ok, err := l.Acquire(ctx, "e1", "w", time.Second); !ok || err != nil {
					t.Fatalf("Acquire = %v, %v; want true, nil", ok, err)
				}
				if err := l.Release(ctx, "e1", "w"); !errors.Is(err, ErrUnavailable) {
					t.Fatalf("Release error = %v, want ErrUnavailable", err)
				}
				// The token is dropped regardless (lock.ts `finally`): the
				// duplicate release is a nil no-op and sends nothing.
				if err := l.Release(ctx, "e1", "w"); err != nil {
					t.Errorf("duplicate Release = %v; want nil no-op", err)
				}
			},
		},
		{
			name: "cancelled context fails closed before any dial",
			steps: []fakeStep{
				{want: wantSet(key, token, "1000"), reply: "+OK\r\n"},
			},
			run: func(t *testing.T, l *ValkeyLock, _ context.Context) {
				if ok, err := l.Acquire(context.Background(), "e1", "w", time.Second); !ok || err != nil {
					t.Fatalf("Acquire = %v, %v; want true, nil", ok, err)
				}
				cancelled, cancel := context.WithCancel(context.Background())
				cancel()
				ok, err := l.Renew(cancelled, "e1", "w", time.Second)
				if ok {
					t.Error("Renew = true on cancelled context; want false (lease lost)")
				}
				if !errors.Is(err, ErrUnavailable) {
					t.Errorf("Renew error = %v, want ErrUnavailable", err)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeValkey(tt.steps...)
			l := newTestValkey(t, f, "abcd")
			tt.run(t, l, testCtx(t))
			f.verify(t)
		})
	}
}

// wantAuth renders the exact `AUTH <password>` request bytes, for asserting the
// handshake the lock sends before its command when a password is configured.
func wantAuth(password string) string {
	return fmt.Sprintf("*2\r\n$4\r\nAUTH\r\n$%d\r\n%s\r\n", len(password), password)
}

// newTestValkeyPassword is newTestValkey with the Valkey ACL password set.
// Empty password keeps the no-AUTH path exercised by the existing tests.
func newTestValkeyPassword(t *testing.T, f *fakeValkey, password string, suffixes ...string) *ValkeyLock {
	t.Helper()
	i := 0
	suffix := func() string {
		if i >= len(suffixes) {
			return "stale"
		}
		s := suffixes[i]
		i++
		return s
	}
	l, err := NewValkeyLock(ValkeyConfig{Dialer: f.Dial, Password: password, TokenSuffix: suffix})
	if err != nil {
		t.Fatalf("NewValkeyLock: %v", err)
	}
	return l
}

// TestValkeyLockAuthHandshake: with a password, the lock sends AUTH then the
// real command on ONE connection. The scripted server answers +OK to AUTH and
// +OK to SET NX, so Acquire succeeds and exactly one dial happened.
func TestValkeyLockAuthHandshake(t *testing.T) {
	// The id is BARE: Acquire formats the wire key itself (LockKey), so a
	// pre-formatted key would be wrapped twice and never reach the server.
	id := "e1"
	token := "w:abcd"
	f := newFakeValkey(
		fakeStep{want: wantAuth("sekrit"), reply: "+OK\r\n", multi: true},
		fakeStep{want: wantSet(LockKey(id), token, "1000"), reply: "+OK\r\n"},
	)
	l := newTestValkeyPassword(t, f, "sekrit", "abcd")
	ok, err := l.Acquire(testCtx(t), id, "w", time.Second)
	if !ok || err != nil {
		t.Fatalf("Acquire = %v, %v; want true, nil", ok, err)
	}
	f.verify(t)
	if f.dials != 1 {
		t.Fatalf("dials = %d; want 1 (AUTH + SET on one connection)", f.dials)
	}
}

// TestValkeyLockAuthRejected: a wrong password answers -ERR and Acquire is
// fail-closed — the caller must not trade on a rejected handshake, exactly
// like a dial failure.
func TestValkeyLockAuthRejected(t *testing.T) {
	id := "e1"
	f := newFakeValkey(fakeStep{want: wantAuth("sekrit"), reply: "-ERR wrong password\r\n", multi: true})
	l := newTestValkeyPassword(t, f, "sekrit", "abcd")
	ok, err := l.Acquire(testCtx(t), id, "w", time.Second)
	if ok {
		t.Fatal("Acquire = true; want false (AUTH rejected)")
	}
	if err == nil {
		t.Fatal("AUTH rejection must carry a fail-closed error, not nil")
	}
	f.verify(t)
}

// Ping is the startup gate a worker must pass before it may trade: it proves
// the same path a lease uses (dial, plus the AUTH handshake when a password is
// set) actually works. A worker that skipped it would run with locks that fail
// open on every call — the exact silent-degrade this must never allow.
func TestValkeyLockPing(t *testing.T) {
	t.Run("passwordless instance", func(t *testing.T) {
		f := newFakeValkey(fakeStep{want: wantPing(), reply: "+PONG\r\n"})
		l := newTestValkey(t, f)
		if err := l.Ping(testCtx(t), time.Second); err != nil {
			t.Fatalf("Ping = %v; want nil", err)
		}
	})
	t.Run("authenticated instance sends AUTH before PING", func(t *testing.T) {
		// One connection, two commands: AUTH then PING, exactly as a lease
		// would drive it. If the handshake were skipped the fake records a
		// mismatched request and the test fails on the expected bytes.
		f := newFakeValkey(
			fakeStep{want: wantAuth("sekrit"), reply: "+OK\r\n", multi: true},
			fakeStep{want: wantPing(), reply: "+PONG\r\n"},
		)
		l := newTestValkeyPassword(t, f, "sekrit", "abcd")
		if err := l.Ping(testCtx(t), time.Second); err != nil {
			t.Fatalf("Ping = %v; want nil", err)
		}
		if f.dials != 1 {
			t.Errorf("dials = %d; want 1 (AUTH and PING share the connection)", f.dials)
		}
	})
	t.Run("wrong password fails closed", func(t *testing.T) {
		f := newFakeValkey(fakeStep{want: wantAuth("sekrit"), reply: "-ERR WRONGPASS invalid username-password pair\r\n", multi: true})
		l := newTestValkeyPassword(t, f, "sekrit", "abcd")
		err := l.Ping(testCtx(t), time.Second)
		if err == nil {
			t.Fatal("Ping = nil on WRONGPASS; want an error (worker must refuse to start)")
		}
		if !strings.Contains(err.Error(), "WRONGPASS") {
			t.Errorf("Ping error = %q; want the server's reason (operator needs it)", err.Error())
		}
	})
	t.Run("dead backend fails closed", func(t *testing.T) {
		f := newFakeValkey(fakeStep{dialErr: "connection refused"})
		l := newTestValkey(t, f)
		if err := l.Ping(testCtx(t), time.Second); err == nil {
			t.Fatal("Ping = nil on dial error; want an error")
		}
	})
	t.Run("non-PONG reply is an error, not a pass", func(t *testing.T) {
		f := newFakeValkey(fakeStep{want: wantPing(), reply: "-ERR not allowed\r\n"})
		l := newTestValkey(t, f)
		if err := l.Ping(testCtx(t), time.Second); err == nil {
			t.Fatal("Ping = nil on an error reply; want an error")
		}
	})
	t.Run("zero timeout still bounds the round trip", func(t *testing.T) {
		f := newFakeValkey(fakeStep{want: wantPing(), reply: "+PONG\r\n"})
		l := newTestValkey(t, f)
		if err := l.Ping(testCtx(t), 0); err != nil {
			t.Fatalf("Ping(0) = %v; want nil (0 must mean the default bound, not an unbounded wait)", err)
		}
	})
}
