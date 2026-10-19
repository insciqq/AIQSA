package procs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeTable map[int]int

func (f fakeTable) Parent(pid int) (int, error) {
	parent, ok := f[pid]
	if !ok {
		return 0, errors.New("gone")
	}
	return parent, nil
}

func TestFindAncestorWalksNearestFirstAndStops(t *testing.T) {
	// 100 -> 90 -> 80 -> 70 -> 1
	table := fakeTable{100: 90, 90: 80, 80: 70, 70: 1}
	is := func(want ...int) func(int) bool {
		return func(pid int) bool {
			for _, w := range want {
				if pid == w {
					return true
				}
			}
			return false
		}
	}
	cases := []struct {
		name  string
		table Table
		start int
		match func(int) bool
		want  int
		found bool
	}{
		{"depth 1", table, 90, is(90), 90, true},
		{"depth 3", table, 90, is(70), 70, true},
		{"nearest wins", table, 90, is(70, 80), 80, true},
		{"no match", table, 90, is(5), 0, false},
		{"pid 1 never matches", table, 90, is(1), 0, false},
		{"unreadable parent", fakeTable{90: 80}, 90, is(70), 0, false},
		{"cycle", fakeTable{90: 80, 80: 90}, 90, is(70), 0, false},
	}
	for _, c := range cases {
		got, found := FindAncestor(c.table, c.start, c.match)
		if got != c.want || found != c.found {
			t.Errorf("%s: %d %v, want %d %v", c.name, got, found, c.want, c.found)
		}
	}
}

func TestFindAncestorIsBounded(t *testing.T) {
	// A chain far longer than MaxDepth, ending in the only match.
	table := fakeTable{}
	for pid := 1000; pid < 1100; pid++ {
		table[pid] = pid + 1
	}
	looked := 0
	_, found := FindAncestor(table, 1000, func(pid int) bool {
		looked++
		return pid == 1100
	})
	if found || looked != MaxDepth {
		t.Fatalf("found %v after %d processes", found, looked)
	}
}

func TestParseStatParentReadsAfterTheLastParenthesis(t *testing.T) {
	cases := map[string]int{
		"1234 (codex) S 1200 1234 1200 0 -1":            1200,
		"1234 (a) (b) c) R 77 1 1 0":                    77,
		"1234 (we ird) ) (x) S 4321 1234 1 34816 1234 ": 4321,
	}
	for stat, want := range cases {
		if got, err := ParseStatParent([]byte(stat)); err != nil || got != want {
			t.Errorf("%q: %d %v, want %d", stat, got, err, want)
		}
	}
	for _, bad := range []string{"", "1234 codex S 1", "1234 (codex)", "1234 (codex) S", "1234 (codex) S x", "1 (a) S -3"} {
		if _, err := ParseStatParent([]byte(bad)); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestProcFSReadsAFakeProcTree(t *testing.T) {
	root := t.TempDir()
	for pid, stat := range map[string]string{"42": "42 (sh) S 7 42 42 0", "7": "7 (tmux: server) S 1 7 7 0"} {
		os.MkdirAll(filepath.Join(root, pid), 0o700)
		os.WriteFile(filepath.Join(root, pid, "stat"), []byte(stat), 0o600)
	}
	table := ProcFS{Root: root}
	if got, err := table.Parent(42); err != nil || got != 7 {
		t.Fatalf("42: %d %v", got, err)
	}
	if _, err := table.Parent(5); err == nil {
		t.Fatal("missing process has a parent")
	}
}

func TestParsePSSkipsWhatIsNotAPair(t *testing.T) {
	got, err := ParsePS([]byte("  PID  PPID\n    1     0\n  501     1\n garbage\n 600 501 extra\n 700 501\n"))
	if err != nil || len(got) != 3 || got[501] != 1 || got[700] != 501 {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := ParsePS([]byte("\n")); err == nil {
		t.Fatal("empty list accepted")
	}
}

// The real tables know this test's own parent.
func TestSystemFindsThisProcessesParent(t *testing.T) {
	tables := map[string]Table{"system": System(context.Background()), "ps": &psTable{ctx: context.Background()}}
	for name, table := range tables {
		if got, err := table.Parent(os.Getpid()); err != nil || got != os.Getppid() {
			t.Errorf("%s: %d %v, want %d", name, got, err, os.Getppid())
		}
	}
}
