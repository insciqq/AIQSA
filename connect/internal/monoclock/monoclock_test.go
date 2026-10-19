package monoclock

import (
	"fmt"
	"os"
	"runtime"
	"testing"
)

// childEnv makes the test binary print one stamp and exit, so a test can
// read the clock in another process.
const childEnv = "AIQSA_CONNECT_TEST_MONOCLOCK_CHILD"

func TestMain(m *testing.M) {
	if os.Getenv(childEnv) == "1" {
		s := Now()
		fmt.Printf("%s %d\n", s.Kind, s.At)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestNowIsAValidReadingThatNeverGoesBack(t *testing.T) {
	want := Wall
	if runtime.GOOS == "linux" {
		want = Mono
	}
	prev := Now()
	if !prev.Valid() || prev.Kind != want {
		t.Fatalf("stamp %+v, want kind %s", prev, want)
	}
	for range 1000 {
		next := Now()
		if !next.Comparable(prev) || want == Mono && next.At < prev.At {
			t.Fatalf("%+v after %+v", next, prev)
		}
		prev = next
	}
}

func TestStampsCompareOnlyWithinOneValidClock(t *testing.T) {
	mono, wall := Stamp{Mono, 5}, Stamp{Wall, 7}
	if !mono.Comparable(Stamp{Mono, 9}) || mono.Comparable(wall) || wall.Comparable(mono) {
		t.Fatal("kinds compared wrongly")
	}
	for _, bad := range []Stamp{{}, {Mono, 0}, {Wall, -1}, {"boot", 5}} {
		if bad.Valid() || bad.Comparable(bad) {
			t.Fatalf("%+v is valid", bad)
		}
	}
}
