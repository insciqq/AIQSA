package ops

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// pausingFiles is osFiles whose first opened file stops in Truncate, with
// its data written and before it is cut to its length, until resume is
// closed.
type pausingFiles struct {
	osFiles
	opened         atomic.Bool
	paused, resume chan struct{}
}

func (p *pausingFiles) Open(path string) (inPlaceFile, error) {
	f, err := p.osFiles.Open(path)
	if err != nil || p.opened.Swap(true) {
		return f, err
	}
	return pausingFile{f.(*os.File), p}, nil
}

type pausingFile struct {
	*os.File
	files *pausingFiles
}

func (f pausingFile) Truncate(size int64) error {
	close(f.files.paused)
	<-f.files.resume
	return f.File.Truncate(size)
}

type opOutcome struct {
	result protocol.Validator
	code   protocol.ReasonCode
}

// goOp runs one op in the background.
func goOp(e *Executor, args protocol.OpArgs) <-chan opOutcome {
	done := make(chan opOutcome, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, code := e.execute(ctx, &protocol.OpCommand{Type: protocol.CommandOp, RunID: testRun, Op: args.ArgsOp(), Args: args, DeadlineMs: 30_000}, e.currentLimits())
		done <- opOutcome{result, code}
	}()
	return done
}

func receive[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(20 * time.Second):
		t.Fatalf("%s: timed out", what)
	}
	panic("unreachable")
}

// fileLockWaited reports whether an op waits for a file lock another holds.
func fileLockWaited(e *Executor) bool {
	e.fileLocks.mu.Lock()
	defer e.fileLocks.mu.Unlock()
	for _, lock := range e.fileLocks.locks {
		if lock.users > 1 {
			return true
		}
	}
	return false
}

func fileLockCount(e *Executor) int {
	e.fileLocks.mu.Lock()
	defer e.fileLocks.mu.Unlock()
	return len(e.fileLocks.locks)
}

// The review's reproduction: a write in place stopped between writing its
// data and cutting the file, while a second write of the same file through
// a hard link writes and cuts it, ended with the second's data followed by
// NUL bytes, and both succeeded. Writes of one file now take turns, through
// any of its names and whether the file is written in place or replaced: the
// second waits, and the file ends with exactly one write's content, the
// one that finished last, and both succeed.
func TestWritesOfOneFileTakeTurns(t *testing.T) {
	const first, second = "the first write, longer than the second\n", "second\n"
	for _, tc := range []struct {
		name    string
		inPlace bool
		alias   func(path, aliasPath string) error
	}{
		{"in place, through a hard link", true, os.Link},
		{"replaced, through a symbolic link", false, os.Symlink},
	} {
		t.Run(tc.name, func(t *testing.T) {
			paused, resume := make(chan struct{}), make(chan struct{})
			var prepared atomic.Bool
			e, home := newTestExecutor(t, testSystem{
				inPlace: tc.inPlace,
				prepare: func(tmp *os.File, path string, info fs.FileInfo) error {
					if !prepared.Swap(true) {
						close(paused)
						<-resume
					}
					return Native().PrepareReplacement(tmp, path, info)
				},
			})
			e.inPlace = &pausingFiles{paused: paused, resume: resume}
			backups := t.TempDir()
			t.Setenv("TMPDIR", backups)
			dir := filepath.Join(home, "dir")
			path := filepath.Join(dir, "notes.txt")
			writeTestFile(t, path, []byte("the original\n"))
			alias := filepath.Join(home, "alias.txt")
			if err := tc.alias(path, alias); err != nil {
				t.Skipf("no such link here: %v", err)
			}

			firstDone := goOp(e, &protocol.WriteArgs{Path: path, Cwd: home, Content: first})
			receive(t, paused, "the first write's pause")
			secondDone := goOp(e, &protocol.WriteArgs{Path: alias, Cwd: home, Content: second})
			// The second write waits for the first, or, without turns, finishes.
			var secondFirst *opOutcome
			for waited := time.Now(); !fileLockWaited(e); time.Sleep(time.Millisecond) {
				select {
				case outcome := <-secondDone:
					secondFirst = &outcome
				default:
				}
				if secondFirst != nil {
					break
				}
				if time.Since(waited) > 20*time.Second {
					t.Fatal("the second write neither waited nor finished")
				}
			}
			close(resume)
			a := receive(t, firstDone, "the first write")
			b := opOutcome{}
			if secondFirst != nil {
				b = *secondFirst
			} else {
				b = receive(t, secondDone, "the second write")
			}

			if a.code != "" || b.code != "" {
				t.Fatalf("codes %q and %q", a.code, b.code)
			}
			got := string(readTestFile(t, path))
			if got != first && got != second {
				t.Fatalf("the writes interleaved: %q", got)
			}
			if secondFirst != nil {
				t.Fatalf("the second write did not wait for the first (content %q)", got)
			}
			if got != second {
				t.Fatalf("content %q: the second write finished last", got)
			}
			if viaAlias := string(readTestFile(t, alias)); viaAlias != got {
				t.Fatalf("through the other name: %q", viaAlias)
			}
			for _, outcome := range []opOutcome{a, b} {
				if w := outcome.result.(*protocol.WriteResult); w.Created {
					t.Fatalf("a write of an existing file says it created it: %+v", w)
				}
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 1 {
				t.Fatalf("left files behind: %v", entries)
			}
			if entries, _ := os.ReadDir(backups); len(entries) != 0 {
				t.Fatalf("left backups behind: %v", entries)
			}
			if n := fileLockCount(e); n != 0 {
				t.Fatalf("%d locks outlived their ops", n)
			}
		})
	}
}

// A write or edit waiting for a file another op holds stops at its
// deadline (computer_timeout) or when it is cancelled
// (computer_cancelled), having changed nothing; no lock outlives its ops.
func TestWaitingForAFileEndsWithTheOp(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	path := filepath.Join(home, "notes.txt")
	writeTestFile(t, path, []byte("old\n"))
	id, ok := fileID(path)
	if !ok {
		t.Fatal("the file has no identity")
	}
	unlock, err := e.fileLocks.lock(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range []protocol.OpArgs{
		&protocol.WriteArgs{Path: path, Cwd: home, Content: "new\n"},
		&protocol.EditArgs{Path: "notes.txt", Cwd: home, OldString: "old", NewString: "new"},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		_, code := e.execute(ctx, &protocol.OpCommand{Type: protocol.CommandOp, RunID: testRun, Op: args.ArgsOp(), Args: args, DeadlineMs: 50}, e.currentLimits())
		cancel()
		if code != protocol.CodeComputerTimeout {
			t.Fatalf("%s: code %q", args.ArgsOp(), code)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, code := e.write(ctx, &protocol.WriteArgs{Path: path, Cwd: home, Content: "new\n"}); code != protocol.CodeComputerCancelled {
		t.Fatalf("cancelled: code %q", code)
	}
	if got := readTestFile(t, path); string(got) != "old\n" {
		t.Fatalf("a write that did not get its turn changed the file: %q", got)
	}
	unlock()
	if n := fileLockCount(e); n != 0 {
		t.Fatalf("%d locks outlived their ops", n)
	}
	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "new\n"})
	if got := readTestFile(t, path); string(got) != "new\n" {
		t.Fatalf("content %q", got)
	}
}

// A new file is created only where none is: a file another name of it
// created since the write looked is not cut, and the write replaces it
// instead.
func TestCreateNeverCutsAFileThatAppeared(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	path := filepath.Join(home, "new.txt")
	held, code := e.lockFile(context.Background(), path)
	if code != "" {
		t.Fatal(code)
	}
	writeTestFile(t, path, []byte("written by another name\n"))
	if _, code, exists := create(context.Background(), held, []byte("x")); !exists || code != "" {
		t.Fatalf("exists %v, code %q", exists, code)
	}
	held.release()
	if got := readTestFile(t, path); string(got) != "written by another name\n" {
		t.Fatalf("the file was cut: %q", got)
	}

	// Through a dangling symbolic link, the file is created at its target.
	target := filepath.Join(home, "target", "file.txt")
	link := filepath.Join(home, "dangling.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("no symbolic links: %v", err)
	}
	w := mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: link, Cwd: home, Content: "через ссылку\n"})
	if !w.Created || string(readTestFile(t, target)) != "через ссылку\n" {
		t.Fatalf("through a dangling link: %+v %q", w, readTestFile(t, target))
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link was replaced: %v", err)
	}
}
