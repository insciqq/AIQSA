// Package procs reads one snapshot of this computer's processes: on Linux
// through /proc/<pid>/stat, elsewhere through one `ps` run. It reads process
// ids and command names only, never command lines or environments.
package procs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// MaxDepth bounds how many processes FindAncestor looks at, and how deep
// HasDescendant looks.
const MaxDepth = 32

// maxDescendants bounds how many processes HasDescendant looks at.
const maxDescendants = 1024

// maxProcesses bounds a snapshot.
const maxProcesses = 1 << 16

// Table gives the parent of a process.
type Table interface {
	Parent(pid int) (int, error)
}

// FindAncestor returns the first of pid and its ancestors, nearest first,
// that match accepts. The walk stops at pid 1, after MaxDepth processes, at
// a process it already saw and at the first parent it cannot read.
func FindAncestor(t Table, pid int, match func(pid int) bool) (int, bool) {
	seen := make(map[int]bool, MaxDepth)
	for range MaxDepth {
		if pid <= 1 || seen[pid] {
			return 0, false
		}
		seen[pid] = true
		if match(pid) {
			return pid, true
		}
		parent, err := t.Parent(pid)
		if err != nil {
			return 0, false
		}
		pid = parent
	}
	return 0, false
}

// Process is one entry of a snapshot. Name is the command name: the
// kernel's (at most 15 bytes) on Linux, the executable's base name
// elsewhere.
type Process struct {
	PID, PPID int
	Name      string
}

// Snapshot is the process table at one moment.
type Snapshot struct {
	procs    map[int]Process
	children map[int][]int
}

// NewSnapshot indexes processes; a later entry of the same pid wins.
func NewSnapshot(list []Process) *Snapshot {
	s := &Snapshot{procs: make(map[int]Process, len(list)), children: map[int][]int{}}
	for _, p := range list {
		s.procs[p.PID] = p
	}
	for pid, p := range s.procs {
		s.children[p.PPID] = append(s.children[p.PPID], pid)
	}
	return s
}

// Parent makes a Snapshot a Table.
func (s *Snapshot) Parent(pid int) (int, error) {
	p, ok := s.procs[pid]
	if !ok {
		return 0, fmt.Errorf("no process %d", pid)
	}
	return p.PPID, nil
}

// HasDescendant reports whether pid or one of its descendants, at most
// MaxDepth levels and maxDescendants processes deep, has a name match
// accepts.
func (s *Snapshot) HasDescendant(pid int, match func(name string) bool) bool {
	if pid <= 1 {
		return false
	}
	seen := map[int]bool{pid: true}
	level := []int{pid}
	for depth := 0; depth <= MaxDepth && len(level) > 0; depth++ {
		var next []int
		for _, p := range level {
			if proc, ok := s.procs[p]; ok && match(proc.Name) {
				return true
			}
			for _, child := range s.children[p] {
				if seen[child] {
					continue
				}
				if len(seen) >= maxDescendants {
					return false
				}
				seen[child] = true
				next = append(next, child)
			}
		}
		level = next
	}
	return false
}

// Take reads this computer's process table once. Outside Linux it runs
// `ps` once, bounded by ctx and psWait.
func Take(ctx context.Context) (*Snapshot, error) {
	if runtime.GOOS == "linux" {
		return ProcFS{Root: "/proc"}.Snapshot(ctx)
	}
	return snapshotPS(ctx)
}

// ProcFS reads processes from a procfs mounted at Root.
type ProcFS struct{ Root string }

// Snapshot reads every process's stat; processes that end meanwhile or
// cannot be read are left out.
func (p ProcFS) Snapshot(ctx context.Context) (*Snapshot, error) {
	entries, err := os.ReadDir(p.Root)
	if err != nil {
		return nil, err
	}
	var list []Process
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 || !entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(p.Root, entry.Name(), "stat"))
		if err != nil {
			continue
		}
		ppid, name, err := ParseStat(data)
		if err != nil {
			continue
		}
		list = append(list, Process{PID: pid, PPID: ppid, Name: name})
		if len(list) >= maxProcesses {
			break
		}
	}
	if len(list) == 0 {
		return nil, errors.New("empty process list")
	}
	return NewSnapshot(list), nil
}

var errMalformedStat = errors.New("malformed process stat")

// ParseStat reads the parent pid and the command name from
// /proc/<pid>/stat. The name in parentheses may itself contain spaces and
// parentheses, so it ends at the last ")".
func ParseStat(data []byte) (int, string, error) {
	start := bytes.IndexByte(data, '(')
	end := bytes.LastIndexByte(data, ')')
	if start < 0 || end < start {
		return 0, "", errMalformedStat
	}
	// After the name come the state and then the parent pid.
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 2 {
		return 0, "", errMalformedStat
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil || ppid < 0 {
		return 0, "", errMalformedStat
	}
	return ppid, string(data[start+1 : end]), nil
}

// psWait bounds the `ps` snapshot on its own.
const psWait = time.Second

func snapshotPS(ctx context.Context) (*Snapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, psWait)
	defer cancel()
	bin := "/bin/ps"
	// Agents may give their hooks a short PATH; ps lives in /bin anyway.
	if path, err := exec.LookPath("ps"); err == nil {
		bin = path
	}
	cmd := exec.CommandContext(ctx, bin, "-A", "-o", "pid=", "-o", "ppid=", "-o", "comm=")
	cmd.WaitDelay = 100 * time.Millisecond
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return ParsePS(out)
}

// ParsePS reads `ps -A -o pid= -o ppid= -o comm=` output, one "pid ppid
// command" per line; the command, which may hold spaces, is reduced to its
// base name. Lines that do not start with two numbers are skipped.
func ParsePS(out []byte) (*Snapshot, error) {
	var list []Process
	for line := range strings.SplitSeq(string(out), "\n") {
		pidText, rest := cutField(line)
		ppidText, comm := cutField(rest)
		pid, err1 := strconv.Atoi(pidText)
		ppid, err2 := strconv.Atoi(ppidText)
		if err1 != nil || err2 != nil || pid <= 0 || ppid < 0 {
			continue
		}
		name := ""
		if comm = strings.TrimSpace(comm); comm != "" {
			name = filepath.Base(comm)
		}
		list = append(list, Process{PID: pid, PPID: ppid, Name: name})
		if len(list) >= maxProcesses {
			break
		}
	}
	if len(list) == 0 {
		return nil, errors.New("empty process list")
	}
	return NewSnapshot(list), nil
}

// cutField splits off the first blank-separated field of s.
func cutField(s string) (string, string) {
	s = strings.TrimLeft(s, " \t")
	if i := strings.IndexAny(s, " \t"); i >= 0 {
		return s[:i], s[i:]
	}
	return s, ""
}
