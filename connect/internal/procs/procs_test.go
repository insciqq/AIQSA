package procs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

func TestParseStatReadsTheNameAndTheParent(t *testing.T) {
	cases := map[string]struct {
		ppid int
		name string
	}{
		"1234 (codex) S 1200 1234 1200 0 -1":            {1200, "codex"},
		"1234 (a) (b) c) R 77 1 1 0":                    {77, "a) (b) c"},
		"1234 (we ird) ) (x) S 4321 1234 1 34816 1234 ": {4321, "we ird) ) (x"},
		"1234 () S 5 1 1":                               {5, ""},
	}
	for stat, want := range cases {
		ppid, name, err := ParseStat([]byte(stat))
		if err != nil || ppid != want.ppid || name != want.name {
			t.Errorf("%q: %d %q %v, want %+v", stat, ppid, name, err, want)
		}
	}
	for _, bad := range []string{"", "1234 codex S 1", "1234 (codex)", "1234 (codex) S", "1234 (codex) S x", "1 (a) S -3", "1 )a( S 1"} {
		if _, _, err := ParseStat([]byte(bad)); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestProcFSReadsAFakeProcTree(t *testing.T) {
	root := t.TempDir()
	for pid, stat := range map[string]string{
		"42": "42 (sh) S 7 42 42 0", "7": "7 (tmux: server) S 1 7 7 0", "50": "50 (codex) S 42 50 42 0", "60": "garbage",
	} {
		os.MkdirAll(filepath.Join(root, pid), 0o700)
		os.WriteFile(filepath.Join(root, pid, "stat"), []byte(stat), 0o600)
	}
	os.MkdirAll(filepath.Join(root, "self"), 0o700)
	os.WriteFile(filepath.Join(root, "uptime"), []byte("1 1"), 0o600)
	snap, err := ProcFS{Root: root}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got, err := snap.Parent(42); err != nil || got != 7 {
		t.Fatalf("42: %d %v", got, err)
	}
	for _, missing := range []int{5, 60} {
		if _, err := snap.Parent(missing); err == nil {
			t.Fatalf("process %d has a parent", missing)
		}
	}
	isCodex := func(name string) bool { return name == "codex" }
	if !snap.HasDescendant(7, isCodex) || !snap.HasDescendant(50, isCodex) || snap.HasDescendant(5, isCodex) {
		t.Fatal("descendants")
	}
	if _, err := (ProcFS{Root: t.TempDir()}).Snapshot(context.Background()); err == nil {
		t.Fatal("an empty proc tree is a snapshot")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (ProcFS{Root: root}).Snapshot(ctx); err == nil {
		t.Fatal("a cancelled snapshot succeeded")
	}
}

func TestHasDescendantIsBoundedAndSafeOnCycles(t *testing.T) {
	codex := func(name string) bool { return name == "codex" }
	// 10 -> 11 -> 12 (codex); 20 <-> 21 cycle; a chain deeper than MaxDepth.
	list := []Process{{10, 1, "sh"}, {11, 10, "node"}, {12, 11, "codex"}, {20, 21, "sh"}, {21, 20, "sh"}, {100, 1, "sh"}}
	for pid := 100; pid < 100+MaxDepth+5; pid++ {
		list = append(list, Process{pid + 1, pid, "sh"})
	}
	list = append(list, Process{100 + MaxDepth + 10, 100 + MaxDepth + 5, "codex"})
	snap := NewSnapshot(list)
	if !snap.HasDescendant(10, codex) || !snap.HasDescendant(12, codex) || snap.HasDescendant(11, func(string) bool { return false }) {
		t.Fatal("chain")
	}
	if snap.HasDescendant(20, codex) {
		t.Fatal("cycle")
	}
	if snap.HasDescendant(100, codex) {
		t.Fatal("looked past MaxDepth")
	}
	if snap.HasDescendant(1, func(string) bool { return true }) || snap.HasDescendant(0, func(string) bool { return true }) {
		t.Fatal("pid 1 or 0 is a root")
	}
	// A pane with a huge process tree under it stops after maxDescendants.
	wide := []Process{{2, 1, "sh"}}
	for pid := 3; pid < 3+2*maxDescendants; pid++ {
		wide = append(wide, Process{pid, 2, "sh"})
	}
	looked := 0
	NewSnapshot(wide).HasDescendant(2, func(string) bool { looked++; return false })
	if looked > maxDescendants {
		t.Fatalf("looked at %d processes", looked)
	}
}

func TestParsePSKeepsTheBaseNameOfTheCommand(t *testing.T) {
	snap, err := ParsePS([]byte("  PID  PPID COMM\n    1     0 /sbin/launchd\n  501     1 /Applications/My App.app/Contents/MacOS/My App\n garbage\n 600 501 codex\n 700 501\n 800\n"))
	if err != nil {
		t.Fatal(err)
	}
	for pid, want := range map[int]Process{1: {1, 0, "launchd"}, 501: {501, 1, "My App"}, 600: {600, 501, "codex"}, 700: {700, 501, ""}} {
		if got := snap.procs[pid]; got != want {
			t.Errorf("%d: %+v, want %+v", pid, got, want)
		}
	}
	if len(snap.procs) != 4 {
		t.Fatalf("%d processes", len(snap.procs))
	}
	if _, err := ParsePS([]byte("\n")); err == nil {
		t.Fatal("empty list accepted")
	}
}

// The real tables know this test's own parent and its name.
func TestTakeFindsThisProcess(t *testing.T) {
	ps, err := snapshotPS(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	taken, err := Take(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// Linux cuts command names to 15 bytes.
	base := filepath.Base(self)
	for name, snap := range map[string]*Snapshot{"take": taken, "ps": ps} {
		if got, err := snap.Parent(os.Getpid()); err != nil || got != os.Getppid() {
			t.Errorf("%s: %d %v, want %d", name, got, err, os.Getppid())
		}
		if got := snap.procs[os.Getpid()].Name; got == "" || !strings.HasPrefix(base, got) {
			t.Errorf("%s: name %q, executable %q", name, got, base)
		}
	}
}
