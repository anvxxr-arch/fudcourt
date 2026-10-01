package lock

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

// releaseLua is RELEASE_LUA verbatim from apps/web/src/platform/executor/lock.ts:
// compare-and-act (GET-then-DEL would race another owner's acquisition).
const releaseLua = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

// heartbeatLua is HEARTBEAT_LUA verbatim from lock.ts: extend the TTL only if
// the stored token is still ours.
const heartbeatLua = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"

// Dialer opens one connection to the lock server. It is the injection seam
// that lets tests drive the real RESP encoding against a scripted server over
// net.Pipe() instead of a live Valkey. The connection is used for exactly one
// command and closed (see ValkeyLock.do).
type Dialer func(ctx context.Context) (net.Conn, error)

// ValkeyConfig configures a ValkeyLock. The zero value is invalid: an Address
// or a Dialer is required (ErrInvalidConfig).
type ValkeyConfig struct {
	// Address is the `host:port` the default Dialer connects to. Ignored when
	// Dialer is set.
	Address string

	// Dialer is the connection seam. nil means net.Dialer to Address.
	Dialer Dialer

	// Clock is part of the shared injection seam (address, dialer, clock,
	// token suffix) so callers can build both lock implementations from one
	// options shape. ValkeyLock does not consult it: lease TTLs are enforced
	// server-side with PX and I/O deadlines come from the context, so there is
	// no client-side time to compute. nil means SystemClock.
	Clock Clock

	// TokenSuffix mints the random half of each owner token (`owner:suffix`).
	// Tests inject a deterministic sequence so exact wire bytes are assertable;
	// nil means the crypto/rand default.
	TokenSuffix func() string
}

// ValkeyLock is the production ExecutionLock: it speaks the exact Redis
// commands of lock.ts over a hand-rolled RESP encoding (stdlib net only — no
// third-party client). FAIL-CLOSED: any dial, transport, or protocol failure
// makes Acquire answer (false, ErrUnavailable-wrapped error) and Renew answer
// false — the caller must not trade. Release is best-effort. The
// (executionID, owner) → token map is in-process only: a restarted holder has
// no token and must re-acquire (PRD §114).
//
// One command per dial: every operation opens a fresh connection, sends one
// command, reads one reply, and closes. Lock calls are rare (a handful per
// execution per minute) and a shared connection would need pooling, health
// checks and reconnect state — a far larger failure surface than one TCP
// handshake. The fail-closed consequence is documented on do: a connection
// that dies mid-command is an error, never a guessed success.
type ValkeyLock struct {
	dial   Dialer
	clock  Clock
	suffix func() string

	mu     sync.Mutex
	tokens map[tokenKey]string
}

// NewValkeyLock builds a ValkeyLock from cfg. It fails with ErrInvalidConfig
// when neither Dialer nor Address is set: a lock that cannot dial would only
// ever answer fail-closed, and that deserves one loud error at construction
// instead of silence at trade time.
func NewValkeyLock(cfg ValkeyConfig) (*ValkeyLock, error) {
	dial := cfg.Dialer
	if dial == nil {
		if cfg.Address == "" {
			return nil, fmt.Errorf("lock: new valkey lock: %w (need Address or Dialer)", ErrInvalidConfig)
		}
		d := net.Dialer{}
		dial = func(ctx context.Context) (net.Conn, error) {
			return d.DialContext(ctx, "tcp", cfg.Address)
		}
	}
	if cfg.Clock == nil {
		cfg.Clock = SystemClock{}
	}
	if cfg.TokenSuffix == nil {
		cfg.TokenSuffix = randomTokenSuffix
	}
	return &ValkeyLock{
		dial:   dial,
		clock:  cfg.Clock,
		suffix: cfg.TokenSuffix,
		tokens: make(map[tokenKey]string),
	}, nil
}

var _ ExecutionLock = (*ValkeyLock)(nil)

// Acquire runs `SET key token PX <ttlMs> NX`: +OK means acquired, the $-1 null
// means someone else holds it (false, nil). Any transport/protocol error is
// (false, ErrUnavailable-wrapped error) FAIL-CLOSED — the caller must not
// trade. The owner token is minted per attempt (even on failed attempts the
// next Acquire gets a fresh suffix) and recorded only on success.
func (l *ValkeyLock) Acquire(ctx context.Context, executionID, owner string, ttl time.Duration) (bool, error) {
	if err := validateParams(executionID, owner); err != nil {
		return false, err
	}
	if ttl <= 0 {
		return false, fmt.Errorf("%w", ErrInvalidTTL)
	}
	token := mintToken(owner, l.suffix)
	rep, err := l.do(ctx, "SET", LockKey(executionID), token, "PX", strconv.FormatInt(ttlMillis(ttl), 10), "NX")
	if err != nil {
		return false, unavailable("acquire", executionID, err)
	}
	if rep.kind == '$' && rep.null {
		return false, nil // held by someone else — exactly SET NX's null
	}
	if rep.kind != '+' || rep.str != "OK" {
		return false, unavailable("acquire", executionID, fmt.Errorf("unexpected SET reply %s", rep))
	}
	l.mu.Lock()
	l.tokens[tokenKey{executionID, owner}] = token
	l.mu.Unlock()
	return true, nil
}

// Renew EVALs HEARTBEAT_LUA (lock.ts verbatim) with the token this owner's
// successful Acquire minted. The Lua reply :1 means extended (true); :0 means
// the lease is lost — expired or taken (false, nil) — and the caller must stop
// trading. FAIL-CLOSED: any error answers false with an ErrUnavailable-wrapped
// error. With no token on record (never acquired, already released, restarted)
// nothing is sent and the answer is (false, nil): lease lost.
func (l *ValkeyLock) Renew(ctx context.Context, executionID, owner string, ttl time.Duration) (bool, error) {
	if err := validateParams(executionID, owner); err != nil {
		return false, err
	}
	if ttl <= 0 {
		return false, fmt.Errorf("%w", ErrInvalidTTL)
	}
	l.mu.Lock()
	token, ok := l.tokens[tokenKey{executionID, owner}]
	l.mu.Unlock()
	if !ok {
		return false, nil // no lease minted here — lease lost, fail-closed
	}
	rep, err := l.do(ctx, "EVAL", heartbeatLua, "1", LockKey(executionID), token, strconv.FormatInt(ttlMillis(ttl), 10))
	if err != nil {
		return false, unavailable("renew", executionID, err)
	}
	switch {
	case rep.kind == ':' && rep.num == 1:
		return true, nil
	case rep.kind == ':' && rep.num == 0:
		return false, nil // lease lost (expired or someone else's)
	default:
		return false, unavailable("renew", executionID, fmt.Errorf("unexpected EVAL reply %s", rep))
	}
}

// Release EVALs RELEASE_LUA (lock.ts verbatim) with the token this owner's
// successful Acquire minted. The local token is dropped first (lock.ts deletes
// it in a finally block), so a duplicate release is a NO-OP even if this
// attempt errors. Releasing a lease you do not hold is a NO-OP (nil) — without
// a token nothing is sent, so someone else's lease is never unlocked. The Lua
// reply :1 (released) and :0 (not owner / expired) are both nil; errors are
// reported for logs only — release is best-effort, there is nothing to lose.
func (l *ValkeyLock) Release(ctx context.Context, executionID, owner string) error {
	if err := validateParams(executionID, owner); err != nil {
		return err
	}
	k := tokenKey{executionID, owner}
	l.mu.Lock()
	token, ok := l.tokens[k]
	delete(l.tokens, k) // drop first: duplicates no-op even if this attempt fails
	l.mu.Unlock()
	if !ok {
		return nil // not our lease — NO-OP, never someone else's unlock
	}
	rep, err := l.do(ctx, "EVAL", releaseLua, "1", LockKey(executionID), token)
	if err != nil {
		return unavailable("release", executionID, err) // best-effort: for logs only
	}
	if rep.kind != ':' || (rep.num != 0 && rep.num != 1) {
		return unavailable("release", executionID, fmt.Errorf("unexpected EVAL reply %s", rep))
	}
	return nil
}

// do runs exactly one command on a fresh connection and parses one reply (see
// the one-command-per-dial rationale on ValkeyLock). Deadlines come from ctx:
// if the caller set one, it is installed on the connection; a caller that
// needs a bound must set a deadline — that is the contract. ctx cancellation
// before the dial also fails here. Every failure is the caller's cue to treat
// the lock as unavailable (fail-closed).
func (l *ValkeyLock) do(ctx context.Context, args ...string) (reply, error) {
	if err := ctx.Err(); err != nil {
		return reply{}, err
	}
	conn, err := l.dial(ctx)
	if err != nil {
		return reply{}, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			return reply{}, err
		}
	}
	if _, err := conn.Write(encodeCommand(args...)); err != nil {
		return reply{}, err
	}
	return readReply(bufio.NewReader(conn))
}

// encodeCommand encodes args as a RESP array of bulk strings —
// `*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n...` — the only request shape Valkey needs
// here. Lengths are byte lengths, as RESP requires.
func encodeCommand(args ...string) []byte {
	var b bytes.Buffer
	b.Grow(16 + 16*len(args))
	b.WriteByte('*')
	b.WriteString(strconv.Itoa(len(args)))
	b.WriteString("\r\n")
	for _, a := range args {
		b.WriteByte('$')
		b.WriteString(strconv.Itoa(len(a)))
		b.WriteString("\r\n")
		b.WriteString(a)
		b.WriteString("\r\n")
	}
	return b.Bytes()
}

// reply is one parsed RESP2 reply: kind '+' (simple string, payload in str),
// ':' (integer in num), or '$' (bulk string in str; null is the $-1 reply,
// which Redis/Valkey use for "no such key" / SET NX miss).
type reply struct {
	kind byte
	str  string
	num  int64
	null bool
}

// String renders the reply for error messages (never payload secrets — lock
// tokens are not secret material but are still never logged whole).
func (r reply) String() string {
	switch r.kind {
	case '+':
		return "simple string " + strconv.Quote(r.str)
	case ':':
		return "integer " + strconv.FormatInt(r.num, 10)
	case '$':
		if r.null {
			return "null bulk string"
		}
		return "bulk string " + strconv.Quote(r.str)
	default:
		return "unknown reply kind"
	}
}

// readReply parses exactly one RESP2 reply with a bufio reader so partial
// reads (a reply arriving in many TCP segments) are reassembled: '+simple
// string', ':integer', '$bulk' including the '$-1' null, and '-error' (returned
// as an error). Anything else — bad CRLF framing, bad lengths, unknown
// prefixes, oversize declared lengths — is a protocol error, never a guessed
// success.
func readReply(r *bufio.Reader) (reply, error) {
	line, err := readLine(r)
	if err != nil {
		return reply{}, err
	}
	if len(line) == 0 {
		return reply{}, fmt.Errorf("lock: empty RESP reply")
	}
	prefix, rest := line[0], line[1:]
	switch prefix {
	case '+':
		return reply{kind: '+', str: rest}, nil
	case ':':
		n, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			return reply{}, fmt.Errorf("lock: bad RESP integer %q: %w", rest, err)
		}
		return reply{kind: ':', num: n}, nil
	case '$':
		n, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			return reply{}, fmt.Errorf("lock: bad RESP bulk length %q: %w", rest, err)
		}
		if n == -1 {
			return reply{kind: '$', null: true}, nil
		}
		if n < 0 {
			return reply{}, fmt.Errorf("lock: bad RESP bulk length %d", n)
		}
		buf := make([]byte, n+2) // payload + CRLF
		if _, err := io.ReadFull(r, buf); err != nil {
			return reply{}, fmt.Errorf("lock: short RESP bulk payload: %w", err)
		}
		if buf[n] != '\r' || buf[n+1] != '\n' {
			return reply{}, fmt.Errorf("lock: bad RESP bulk trailer")
		}
		return reply{kind: '$', str: string(buf[:n])}, nil
	case '-':
		return reply{}, fmt.Errorf("lock: server error: %s", rest)
	default:
		return reply{}, fmt.Errorf("lock: unknown RESP prefix %q", prefix)
	}
}

// readLine reads one CRLF-terminated RESP line and returns its payload without
// the CRLF, rejecting any framing that is not exactly \r\n-terminated.
func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("lock: short RESP line: %w", err)
	}
	if len(line) < 2 || line[len(line)-2] != '\r' {
		return "", fmt.Errorf("lock: bad RESP line terminator in %q", line)
	}
	return line[:len(line)-2], nil
}
