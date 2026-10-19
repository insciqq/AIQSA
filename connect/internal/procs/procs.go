// Package procs walks a process's ancestors: on Linux through
// /proc/<pid>/stat, elsewhere through one `ps` snapshot. It reads process
// ids only, never command lines or environments.
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
	"sync"
	"time"
)

// MaxDepth bounds how many processes FindAncestor looks at.
const MaxDepth = 32

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

// System is this computer's process table. Outside Linux its first lookup
// runs `ps` once, bounded by ctx and psWait.
func System(ctx context.Context) Table {
	if runtime.GOOS == "linux" {
		return ProcFS{Root: "/proc"}
	}
	return &psTable{ctx: ctx}
}

// ProcFS reads parents from a procfs mounted at Root.
type ProcFS struct{ Root string }

func (p ProcFS) Parent(pid int) (int, error) {
	data, err := os.ReadFile(filepath.Join(p.Root, strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, err
	}
	return ParseStatParent(data)
}

var errMalformedStat = errors.New("malformed process stat")

// ParseStatParent reads the parent pid from /proc/<pid>/stat. The command
// name in parentheses may itself contain spaces and parentheses, so the
// fields are read after the last ")".
func ParseStatParent(data []byte) (int, error) {
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return 0, errMalformedStat
	}
	// After the name come the state and then the parent pid.
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 2 {
		return 0, errMalformedStat
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil || ppid < 0 {
		return 0, errMalformedStat
	}
	return ppid, nil
}

// psWait bounds the `ps` snapshot on its own.
const psWait = time.Second

type psTable struct {
	ctx     context.Context
	once    sync.Once
	parents map[int]int
	err     error
}

func (p *psTable) Parent(pid int) (int, error) {
	p.once.Do(func() { p.parents, p.err = snapshotPS(p.ctx) })
	if p.err != nil {
		return 0, p.err
	}
	parent, ok := p.parents[pid]
	if !ok {
		return 0, fmt.Errorf("no process %d", pid)
	}
	return parent, nil
}

func snapshotPS(ctx context.Context) (map[int]int, error) {
	ctx, cancel := context.WithTimeout(ctx, psWait)
	defer cancel()
	bin := "/bin/ps"
	// Agents may give their hooks a short PATH; ps lives in /bin anyway.
	if path, err := exec.LookPath("ps"); err == nil {
		bin = path
	}
	cmd := exec.CommandContext(ctx, bin, "-A", "-o", "pid=", "-o", "ppid=")
	cmd.WaitDelay = 100 * time.Millisecond
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return ParsePS(out)
}

// ParsePS reads `ps -A -o pid= -o ppid=` output, one "pid ppid" per line.
// Lines that are not two numbers are skipped.
func ParsePS(out []byte) (map[int]int, error) {
	parents := map[int]int{}
	for line := range strings.SplitSeq(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil || pid <= 0 || ppid < 0 {
			continue
		}
		parents[pid] = ppid
	}
	if len(parents) == 0 {
		return nil, errors.New("empty process list")
	}
	return parents, nil
}
