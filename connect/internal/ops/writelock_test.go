package ops

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
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

// writersWaiting counts the goroutines blocked in lockWrites, waiting for
// their turn.
func writersWaiting() int {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	count := 0
	for _, g := range bytes.Split(buf, []byte("\n\n")) {
		if bytes.Contains(g, []byte(" [select")) && bytes.Contains(g, []byte(").lockWrites(")) {
			count++
		}
	}
	return count
}

// awaitWriter waits until an op waits in lockWrites, or done answers: then
// it returns that outcome, as the op did not wait.
func awaitWriter(t *testing.T, done <-chan opOutcome) *opOutcome {
	t.Helper()
	for waited := time.Now(); writersWaiting() == 0; time.Sleep(time.Millisecond) {
		select {
		case outcome := <-done:
			return &outcome
		default:
		}
		if time.Since(waited) > 20*time.Second {
			t.Fatal("the op neither waited nor finished")
		}
	}
	return nil
}

// writeLockFree reports whether no op holds the executor's write lock.
func writeLockFree(e *Executor) bool { return len(e.writing) == 0 }

// The review's reproduction: a write in place stopped between writing its
// data and cutting the file, while a second write of the same file through
// a hard link writes and cuts it, ended with the second's data followed by
// NUL bytes, and both succeeded. Writes now take turns, through any name
// of the file and whether it is written in place or replaced: the second
// waits, and the file ends with exactly one write's content, the one that
// finished last, and both succeed.
func TestWritesOfOneFileTakeTurns(t *testing.T) {
	const first, second = "the first write, longer than the second\n", "second\n"
	for _, tc := range []struct {
		name    string
		inPlace bool
		// alias gives the file at dir/notes.txt another name.
		alias func(t *testing.T, home, dir string) string
	}{
		{"in place, through a hard link", true, func(t *testing.T, home, dir string) string {
			alias := filepath.Join(home, "alias.txt")
			if err := os.Link(filepath.Join(dir, "notes.txt"), alias); err != nil {
				t.Skipf("no hard links here: %v", err)
			}
			return alias
		}},
		{"replaced, through a symbolic link", false, func(t *testing.T, home, dir string) string {
			alias := filepath.Join(home, "alias.txt")
			if err := os.Symlink(filepath.Join(dir, "notes.txt"), alias); err != nil {
				t.Skipf("no symbolic links here: %v", err)
			}
			return alias
		}},
		{"in place, through a linked folder", true, func(t *testing.T, home, dir string) string {
			alias := filepath.Join(home, "alias")
			if err := os.Symlink(dir, alias); err != nil {
				t.Skipf("no symbolic links here: %v", err)
			}
			return filepath.Join(alias, "notes.txt")
		}},
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
			alias := tc.alias(t, home, dir)

			firstDone := goOp(e, &protocol.WriteArgs{Path: path, Cwd: home, Content: first})
			receive(t, paused, "the first write's pause")
			secondDone := goOp(e, &protocol.WriteArgs{Path: alias, Cwd: home, Content: second})
			// The second write waits for the first, or, without turns, finishes.
			secondFirst := awaitWriter(t, secondDone)
			close(resume)
			a := receive(t, firstDone, "the first write")
			var b opOutcome
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
			if !writeLockFree(e) {
				t.Fatal("the write lock outlived its ops")
			}
		})
	}
}

// A write or edit waiting for its turn stops at its deadline
// (computer_timeout), when it is cancelled (computer_cancelled) or when the
// client stops (no reply), having changed nothing. That holds for a file
// that does not exist yet too, through a linked folder whose subfolder
// does not exist either: the review's reproduction, where such a path
// took a lock of its own and its write went ahead.
func TestWaitingForTheWriteLockEndsWithTheOp(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	path := filepath.Join(home, "notes.txt")
	writeTestFile(t, path, []byte("old\n"))
	real := filepath.Join(home, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(home, "alias")); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	unlock, code := e.lockWrites(context.Background())
	if code != "" {
		t.Fatal(code)
	}
	for _, args := range []protocol.OpArgs{
		&protocol.WriteArgs{Path: path, Cwd: home, Content: "new\n"},
		&protocol.EditArgs{Path: "notes.txt", Cwd: home, OldString: "old", NewString: "new"},
		&protocol.WriteArgs{Path: filepath.Join("alias", "new", "file.txt"), Cwd: home, Content: "new\n"},
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
	if _, err := os.Lstat(filepath.Join(real, "new")); err == nil {
		t.Fatal("a write that did not get its turn created the file's folder")
	}
	unlock()
	if !writeLockFree(e) {
		t.Fatal("the write lock outlived its ops")
	}
	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "new\n"})
	if got := readTestFile(t, path); string(got) != "new\n" {
		t.Fatalf("content %q", got)
	}

	// Close ends the wait of an op the client runs; it is not answered.
	if _, code := e.lockWrites(context.Background()); code != "" {
		t.Fatal(code)
	}
	var replied atomic.Bool
	e.Start(&protocol.OpCommand{Type: protocol.CommandOp, RequestID: "33333333-2222-4333-8444-555555555555", RunID: testRun,
		Op: protocol.OpWrite, Args: &protocol.WriteArgs{Path: path, Cwd: home, Content: "newer\n"}, DeadlineMs: 30_000},
		func(*protocol.OpReplyEvent) { replied.Store(true) })
	for waited := time.Now(); writersWaiting() == 0; time.Sleep(time.Millisecond) {
		if time.Since(waited) > 20*time.Second {
			t.Fatal("the op did not wait for its turn")
		}
	}
	closed := make(chan struct{})
	go func() {
		e.Close()
		close(closed)
	}()
	receive(t, closed, "Close")
	if replied.Load() {
		t.Fatal("an op stopped by Close was answered")
	}
	if got := readTestFile(t, path); string(got) != "new\n" {
		t.Fatalf("an op stopped by Close changed the file: %q", got)
	}
}

// The lock is given back whatever a write or edit ends with, and a file
// moved away while its write waited does not hold up its writes under the
// new name (the review's reproduction, where an identity lock of the moved
// file leaked and every later write of it timed out).
func TestTheWriteLockIsReleasedWhateverTheOpEndsWith(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	writeTestFile(t, filepath.Join(home, "notes.txt"), []byte("old\n"))
	writeTestFile(t, filepath.Join(home, "data.bin"), []byte{0, 1, 2})
	writeTestFile(t, filepath.Join(home, "legacy.txt"), []byte("caf\xe9\n"))
	if err := os.Mkdir(filepath.Join(home, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		args protocol.OpArgs
		code protocol.ReasonCode
	}{
		{&protocol.WriteArgs{Path: "new.txt", Cwd: home, Content: "x"}, ""},
		{&protocol.WriteArgs{Path: "notes.txt", Cwd: home, Content: "new\n"}, ""},
		{&protocol.WriteArgs{Path: "folder", Cwd: home, Content: "x"}, protocol.CodeComputerIsADirectory},
		{&protocol.WriteArgs{Path: "legacy.txt", Cwd: home, Content: "Итог\n"}, protocol.CodeComputerTextUnencodable},
		{&protocol.EditArgs{Path: "notes.txt", Cwd: home, OldString: "new", NewString: "newer"}, ""},
		{&protocol.EditArgs{Path: "notes.txt", Cwd: home, OldString: "absent", NewString: "x"}, protocol.CodeComputerEditNoMatch},
		{&protocol.EditArgs{Path: "missing.txt", Cwd: home, OldString: "a", NewString: "b"}, protocol.CodeComputerPathNotFound},
		{&protocol.EditArgs{Path: "data.bin", Cwd: home, OldString: "a", NewString: "b"}, protocol.CodeComputerFileBinary},
	} {
		if _, code := run(t, e, tc.args); code != tc.code {
			t.Fatalf("%s %+v: code %q, want %q", tc.args.ArgsOp(), tc.args, code, tc.code)
		}
		if !writeLockFree(e) {
			t.Fatalf("%s %+v kept the write lock", tc.args.ArgsOp(), tc.args)
		}
	}

	path, moved := filepath.Join(home, "notes.txt"), filepath.Join(home, "moved.txt")
	unlock, code := e.lockWrites(context.Background())
	if code != "" {
		t.Fatal(code)
	}
	done := goOp(e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "written after the move\n"})
	if outcome := awaitWriter(t, done); outcome != nil {
		t.Fatalf("the write did not wait for its turn: %+v", *outcome)
	}
	if err := os.Rename(path, moved); err != nil {
		t.Fatal(err)
	}
	unlock()
	if outcome := receive(t, done, "the write"); outcome.code != "" || !outcome.result.(*protocol.WriteResult).Created {
		t.Fatalf("the write after the move: %+v", outcome)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, code := e.write(ctx, &protocol.WriteArgs{Path: moved, Cwd: home, Content: "moved, then written\n"}); code != "" {
		t.Fatalf("a write of the moved file: %q", code)
	}
	if got := readTestFile(t, moved); string(got) != "moved, then written\n" {
		t.Fatalf("the moved file: %q", got)
	}
	if got := readTestFile(t, path); string(got) != "written after the move\n" {
		t.Fatalf("the new file: %q", got)
	}
}

// A new file is created only where none is: a file another program
// created since the write looked is not cut, and the write replaces it
// instead.
func TestCreateNeverCutsAFileThatAppeared(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	path := filepath.Join(home, "new.txt")
	writeTestFile(t, path, []byte("written by another program\n"))
	if _, code, exists := create(path, []byte("x")); !exists || code != "" {
		t.Fatalf("exists %v, code %q", exists, code)
	}
	if got := readTestFile(t, path); string(got) != "written by another program\n" {
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
