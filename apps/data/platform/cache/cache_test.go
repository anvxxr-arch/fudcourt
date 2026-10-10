package cache

// Turn-3 QA suite for the shared L2 cache layer. The fail-open contract is
// proven against a REAL valkey-server (spawned per scenario), because
// Init() is sync.Once per process and the two interesting starting states —
// a wrong password and a healthy server — each need a fresh process. The
// parent re-executes this test binary once per scenario via TestMain.
//
// Scenarios:
//   child=failopen  wrong password  -> L2 disabled, Get miss, Set no-op, no panic
//   child=happy     right password  -> roundtrip, PX TTL expiry, oversized skip
//
// When valkey-server is not on PATH the parent test skips — the same
// environment-gated convention the DSN-gated executor tests use.

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

const valkeyPassword = "qa-cache-test-secret"

func TestMain(m *testing.M) {
	switch os.Getenv("QA_CACHE_CHILD") {
	case "failopen":
		os.Exit(childFailOpen())
	case "happy":
		os.Exit(childHappy())
	}
	os.Exit(m.Run())
}

// ---- parent-side tests -----------------------------------------------------

// The parent proves the two Init scenarios in re-executed children, and the
// pure helpers in this process (no Init needed).
func TestFailOpenAndHappyPaths(t *testing.T) {
	if _, err := exec.LookPath("valkey-server"); err != nil {
		t.Skip("valkey-server not on PATH; L2 scenarios need a local server binary")
	}
	for _, child := range []string{"failopen", "happy"} {
		cmd := exec.Command(os.Args[0])
		cmd.Env = append(os.Environ(), "QA_CACHE_CHILD="+child)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("child %s: %v\n%s", child, err, out)
		}
		t.Logf("child %s: %s", child, strings.TrimSpace(string(out)))
	}
}

func TestKeyNamespacesFamilyAndURL(t *testing.T) {
	k1 := Key("llama", "https://api.llama.fi/v2/chains")
	k2 := Key("news", "https://api.llama.fi/v2/chains")
	if k1 == k2 {
		t.Fatal("two families with the same URL must never share a key")
	}
	if !strings.HasPrefix(k1, "fudcourt:llama:") {
		t.Fatalf("key = %q, want the fudcourt:<family>: prefix", k1)
	}
}

func TestEncodeDecodeRoundtripAndTamper(t *testing.T) {
	body := "{\"rows\":[1,2,3]}\nwith a newline"
	enc := Encode(body, 42, 1791558227)
	got, meta, ok := Decode(enc, 2)
	if !ok || got != body || len(meta) != 2 || meta[0] != 42 || meta[1] != 1791558227 {
		t.Fatalf("roundtrip failed: ok=%v meta=%v body=%q", ok, meta, got)
	}
	for _, tc := range []struct{ name, v string }{
		{"no newline", "42,17"},
		{"wrong field count", "42,17,99\nbody"},
		{"non-numeric meta", "a,b\nbody"},
	} {
		if _, _, ok := Decode(tc.v, 2); ok {
			t.Errorf("%s: Decode ok=true, want miss", tc.name)
		}
	}
}

func TestTTLFromEnv(t *testing.T) {
	t.Setenv("FUDCOURT_DATA_QA_TTL", "7")
	if got := TTLFromEnv("FUDCOURT_DATA_QA_TTL", time.Second); got != 7*time.Second {
		t.Errorf("TTLFromEnv = %v, want 7s", got)
	}
	t.Setenv("FUDCOURT_DATA_QA_TTL", "junk")
	if got := TTLFromEnv("FUDCOURT_DATA_QA_TTL", 3*time.Second); got != 3*time.Second {
		t.Errorf("unparseable TTL = %v, want the fallback 3s", got)
	}
}

// ---- child scenarios (each its own process) -------------------------------

// startChildValkey spawns valkey-server on ports chosen by the caller and
// returns the port that actually opened. The bases live BELOW the ephemeral
// range (32768+, per /proc/sys/net/ipv4/ip_local_port_range): a port inside
// it can be handed to a transient outbound connection, valkey then exits
// before it listens, and the old code blind-waited the whole deadline on a
// dead child (reproduced: "did not open its port in 60s"). A child that dies
// before opening gets the next port a try; five failures stay loud.
func startChildValkey(base int, pass string) (*exec.Cmd, int) {
	for attempt := 0; attempt < 5; attempt++ {
		port := base + attempt
		cmd := exec.Command("valkey-server",
			"--port", strconv.Itoa(port),
			"--save", "",
			"--appendonly", "no",
			"--requirepass", pass,
		)
		var vbuf bytes.Buffer
		cmd.Stdout = &vbuf
		cmd.Stderr = &vbuf
		if err := cmd.Start(); err != nil {
			fmt.Println("child: start valkey-server:", err)
			os.Exit(1)
		}
		exited := make(chan error, 1)
		go func() { exited <- cmd.Wait() }()
		deadline := time.Now().Add(60 * time.Second)
		for time.Now().Before(deadline) {
			select {
			case err := <-exited:
				// Wait returned, so the output copy goroutine is done: safe to read.
				fmt.Printf("child: valkey-server on port %d exited before opening (%v): %s — trying the next port\n",
					port, err, strings.TrimSpace(vbuf.String()))
				goto nextPort
			default:
			}
			if c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second); err == nil {
				c.Close()
				return cmd, port
			}
			time.Sleep(50 * time.Millisecond)
		}
		// Timeout with the server still running: kill first so Wait (and the
		// output copy) finish, then report its diagnostics instead of a bare
		// "did not open" that cannot distinguish a bind failure from a stall.
		_ = cmd.Process.Kill()
		<-exited
		fmt.Printf("child: valkey-server did not open port %d in 60s: %s\n",
			port, strings.TrimSpace(vbuf.String()))
		os.Exit(1)
	nextPort:
	}
	fmt.Println("child: no openable port for valkey-server after 5 attempts")
	os.Exit(1)
	return nil, 0
}

func childPort(offset int) int {
	return offset + int(time.Now().UnixNano()%900)
}

func childFailOpen() int {
	cmd, port := startChildValkey(childPort(19000), valkeyPassword)
	defer cmd.Process.Kill()

	os.Setenv("FUDCOURT_DATA_VALKEY_ADDR", "127.0.0.1:"+strconv.Itoa(port))
	os.Setenv("FUDCOURT_DATA_VALKEY_PASSWORD", "wrong-password-on-purpose")
	Init()
	if Enabled() {
		fmt.Println("child failopen: Enabled()=true with a wrong password — FAIL")
		return 1
	}
	// the family contract under a disabled L2: silent miss / silent no-op
	ctx := context.Background()
	if _, hit := Get(ctx, "fudcourt:llama:https://x"); hit {
		fmt.Println("child failopen: Get reported a hit — FAIL")
		return 1
	}
	Set(ctx, "fudcourt:llama:https://x", "body", time.Minute)
	if _, hit := Get(ctx, "fudcourt:llama:https://x"); hit {
		fmt.Println("child failopen: Set was observable while disabled — FAIL")
		return 1
	}
	fmt.Println("child failopen: disabled, Get miss, Set no-op — OK")
	return 0
}

func childHappy() int {
	cmd, port := startChildValkey(childPort(21000), valkeyPassword)
	defer cmd.Process.Kill()

	os.Setenv("FUDCOURT_DATA_VALKEY_ADDR", "127.0.0.1:"+strconv.Itoa(port))
	os.Setenv("FUDCOURT_DATA_VALKEY_PASSWORD", valkeyPassword)
	Init()
	if !Enabled() {
		fmt.Println("child happy: Enabled()=false against a healthy server — FAIL")
		return 1
	}
	ctx := context.Background()
	key := Key("llama", "https://api.llama.fi/v2/chains")
	Set(ctx, key, Encode(`[{"name":"ethereum"}]`, 1), 200*time.Millisecond)
	if body, hit := Get(ctx, key); !hit || !strings.Contains(body, "ethereum") {
		fmt.Println("child happy: immediate Get missed — FAIL")
		return 1
	}
	time.Sleep(300 * time.Millisecond)
	if _, hit := Get(ctx, key); hit {
		fmt.Println("child happy: PX TTL did not expire — FAIL")
		return 1
	}
	// oversized values are refused without a panic and never observable
	big := strings.Repeat("x", maxValueBytes+1)
	Set(ctx, key, big, time.Minute)
	if _, hit := Get(ctx, key); hit {
		fmt.Println("child happy: oversized value was stored — FAIL")
		return 1
	}
	fmt.Println("child happy: roundtrip, TTL expiry, oversized skip — OK")
	return 0
}
