package decimal

import "testing"

func TestFloorToStep(t *testing.T) {
	cases := []struct {
		q, step, want string
		ok            bool
	}{
		{"0.012583", "0.001", "0.012", true}, // PRD §71 vector
		{"0.0198", "0.0001", "0.0198", true},
		{"5", "1", "5", true},
		{"0.0005", "0.001", "0", true},
		{"1", "0", "", false}, // unusable grid: never guess
		{"1", "-0.1", "", false},
		{"abc", "0.1", "", false},
		{"-1", "0.1", "", false}, // negative refused, never clamped
	}
	for _, c := range cases {
		got, ok, err := FloorToStep(c.q, c.step)
		if c.ok {
			if err != nil || !ok || got != c.want {
				t.Errorf("FloorToStep(%q,%q) = (%q,%v,%v), want (%q,true,nil)", c.q, c.step, got, ok, err, c.want)
			}
		} else if ok {
			t.Errorf("FloorToStep(%q,%q) = (%q,%v,%v), want refusal", c.q, c.step, got, ok, err)
		}
	}
}

func TestRoundToTickTiesHalfUp(t *testing.T) {
	cases := []struct{ p, tick, want string }{
		{"100.005", "0.01", "100.01"}, // tie → up
		{"100.004", "0.01", "100"},
		{"99.995", "0.01", "100"},
	}
	for _, c := range cases {
		got, err := RoundToTick(c.p, c.tick)
		if err != nil || got != c.want {
			t.Errorf("RoundToTick(%q,%q) = (%q,%v), want %q", c.p, c.tick, got, err, c.want)
		}
	}
}

func TestExactArithmetic(t *testing.T) {
	if got, _ := Add("0.1", "0.2"); got != "0.3" {
		t.Errorf("Add(0.1,0.2) = %q, want 0.3", got)
	}
	if got, _ := Sub("1", "0.0001"); got != "0.9999" {
		t.Errorf("Sub = %q", got)
	}
	if got, _ := Mul("1e12", "0.01"); got != "10000000000" {
		t.Errorf("Mul 1e12-scale inexact: %q", got)
	}
	if got, _ := Quo("1", "3"); got != "0.333333333333333333333333" {
		t.Errorf("Quo(1,3) = %q", got)
	}
	if _, err := Quo("1", "0"); err == nil {
		t.Error("division by zero must be refused")
	}
	if n, _ := Cmp("2", "10"); n != -1 {
		t.Errorf("Cmp(2,10) = %d", n)
	}
}

func TestParseRefusesGarbage(t *testing.T) {
	for _, bad := range []string{"", " ", "abc", "1.2.3", "0x10", "Inf", "NaN"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("Parse(%q) must refuse", bad)
		}
	}
}
