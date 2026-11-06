package ops

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func TestShellRunsInCwdWithTheEnvironmentAndClosedStdin(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	os.MkdirAll(filepath.Join(home, "work"), 0o755)
	r := mustRun[*protocol.ShellResult](t, e, &protocol.ShellArgs{
		Command: `pwd; echo "$PAGER $GIT_PAGER $NO_COLOR $TERM"; cat; echo "[$?]"; cd /; echo moved`, Cwd: "~/work", TimeoutSeconds: 30,
	})
	want := filepath.Join(home, "work") + "\ncat cat 1 dumb\n[0]\nmoved\n"
	if r.ExitCode != 0 || r.Stdout != want || r.Stderr != "" || r.DurationMs < 0 {
		t.Fatalf("shell: %+v", r)
	}
	// `cd` does not carry over to the next command; a relative cwd is from home.
	r = mustRun[*protocol.ShellResult](t, e, &protocol.ShellArgs{Command: "pwd", Cwd: "work", TimeoutSeconds: 30})
	if r.Stdout != filepath.Join(home, "work")+"\n" {
		t.Fatalf("second: %q", r.Stdout)
	}
	wantCode(t, e, &protocol.ShellArgs{Command: "true", Cwd: "~/nope", TimeoutSeconds: 30}, protocol.CodeComputerPathNotFound)
	writeTestFile(t, filepath.Join(home, "f"), nil)
	wantCode(t, e, &protocol.ShellArgs{Command: "true", Cwd: "~/f", TimeoutSeconds: 30}, protocol.CodeComputerNotADirectory)
}

func TestShellOutputKeepsHeadAndTail(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	// 200 000 bytes: "A" lines first, "Z" lines last.
	r := mustRun[*protocol.ShellResult](t, e, &protocol.ShellArgs{
		Command: `i=0; while [ $i -lt 1000 ]; do echo "A$(printf '%098d' $i)"; i=$((i+1)); done; ` +
			`i=0; while [ $i -lt 1000 ]; do echo "Z$(printf '%098d' $i)"; i=$((i+1)); done; echo err >&2`,
		Cwd: home, TimeoutSeconds: 60,
	})
	if !r.Truncated || r.StdoutBytes != 200_000 || r.StderrBytes != 4 || r.Stderr != "err\n" {
		t.Fatalf("sizes: truncated=%v %d %d %q", r.Truncated, r.StdoutBytes, r.StderrBytes, r.Stderr)
	}
	if len(r.Stdout) > protocol.MaxStreamOutputBytes || !strings.HasPrefix(r.Stdout, "A"+strings.Repeat("0", 98)+"\n") ||
		!strings.HasSuffix(r.Stdout, "Z"+strings.Repeat("0", 95)+"999\n") || !strings.Contains(r.Stdout, truncationMarker) {
		t.Fatalf("stdout: %d bytes, head %q, tail %q", len(r.Stdout), r.Stdout[:20], r.Stdout[len(r.Stdout)-20:])
	}
}

func TestShellOutputThatIsNotUTF8UsesTheFallback(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{fallback: cp866Fallback})
	// "Привет" in code page 866, as an old console program prints it.
	r := mustRun[*protocol.ShellResult](t, e, &protocol.ShellArgs{Command: `printf '\217\340\250\242\245\342\n'; printf 'ok\n' >&2`, Cwd: home, TimeoutSeconds: 30})
	if r.Stdout != "Привет\n" || r.Stderr != "ok\n" {
		t.Fatalf("decoded: %q %q", r.Stdout, r.Stderr)
	}
	plain, _ := newTestExecutor(t, testSystem{})
	r = mustRun[*protocol.ShellResult](t, plain, &protocol.ShellArgs{Command: `printf 'a\377b\n'`, Cwd: home, TimeoutSeconds: 30})
	if r.Stdout != "a\uFFFDb\n" {
		t.Fatalf("replacement: %q", r.Stdout)
	}
}

func TestShellTimeoutStopsTheTree(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	started := time.Now()
	wantCode(t, e, &protocol.ShellArgs{Command: "sleep 30 & wait", Cwd: home, TimeoutSeconds: 1}, protocol.CodeComputerTimeout)
	if time.Since(started) > 6*time.Second {
		t.Fatalf("timeout took %v", time.Since(started))
	}
}

func TestJobLifecycleAndLimits(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	e.SetLimits(func() protocol.HelloV2Limits { l := protocol.DefaultHelloV2Limits; l.MaxJobs = 2; return l }())
	job := mustRun[*protocol.ShellJobResult](t, e, &protocol.ShellArgs{
		Command: "echo first; sleep 0.3; echo second >&2; sleep 30", Cwd: home, TimeoutSeconds: 1, Background: true,
	})
	out := mustRun[*protocol.JobOutputResult](t, e, &protocol.JobOutputArgs{JobID: job.JobID, WaitSeconds: 5})
	if !out.Running || out.ExitCode != nil || out.Stdout != "first\n" {
		t.Fatalf("first read: %+v", out)
	}
	out = mustRun[*protocol.JobOutputResult](t, e, &protocol.JobOutputArgs{JobID: job.JobID, WaitSeconds: 5})
	if !out.Running || out.Stdout != "" || out.Stderr != "second\n" {
		t.Fatalf("second read: %+v", out)
	}
	// The job outlives its shell timeout; a third may not start beyond MaxJobs.
	mustRun[*protocol.ShellJobResult](t, e, &protocol.ShellArgs{Command: "sleep 30", Cwd: home, TimeoutSeconds: 1, Background: true})
	wantCode(t, e, &protocol.ShellArgs{Command: "sleep 30", Cwd: home, TimeoutSeconds: 1, Background: true}, protocol.CodeComputerLimit)
	stop := mustRun[*protocol.JobStopResult](t, e, &protocol.JobStopArgs{JobID: job.JobID})
	if !stop.Stopped {
		t.Fatalf("stop: %+v", stop)
	}
	out = mustRun[*protocol.JobOutputResult](t, e, &protocol.JobOutputArgs{JobID: job.JobID, WaitSeconds: 5})
	if out.Running || out.ExitCode == nil {
		t.Fatalf("after stop: %+v", out)
	}
	// A slot is free again.
	mustRun[*protocol.ShellJobResult](t, e, &protocol.ShellArgs{Command: "exit 4", Cwd: home, TimeoutSeconds: 1, Background: true})
	wantCode(t, e, &protocol.JobOutputArgs{JobID: "job-unknown1"}, protocol.CodeComputerJobNotFound)
	wantCode(t, e, &protocol.JobStopArgs{JobID: "job-unknown1"}, protocol.CodeComputerJobNotFound)
	// run_ended forgets the run's jobs.
	e.EndRun(testRun)
	wantCode(t, e, &protocol.JobOutputArgs{JobID: job.JobID}, protocol.CodeComputerJobNotFound)
}

func TestJobOutputRingDropsTheOldest(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	job := mustRun[*protocol.ShellJobResult](t, e, &protocol.ShellArgs{
		Command: `head -c 900000 /dev/zero | tr '\0' a; echo; echo end`, Cwd: home, TimeoutSeconds: 1, Background: true,
	})
	var out *protocol.JobOutputResult
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		e.mu.Lock()
		j := e.jobs[job.JobID]
		e.mu.Unlock()
		j.mu.Lock()
		ended := j.ended
		j.mu.Unlock()
		if ended {
			break
		}
	}
	out = mustRun[*protocol.JobOutputResult](t, e, &protocol.JobOutputArgs{JobID: job.JobID})
	if out.Running || !out.Truncated || !strings.HasSuffix(out.Stdout, "a\nend\n") || len(out.Stdout) > protocol.MaxStreamOutputBytes {
		t.Fatalf("ring: running=%v truncated=%v %d bytes", out.Running, out.Truncated, len(out.Stdout))
	}
}

// An op beyond MaxConcurrentOps answers computer_limit; deadlines answer
// computer_timeout; cancel answers nothing; run_ended computer_cancelled.
func TestExecutorLimitsDeadlinesAndCancel(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	limits := protocol.DefaultHelloV2Limits
	limits.MaxConcurrentOps = 2
	e.SetLimits(limits)
	var mu sync.Mutex
	replies := map[string]*protocol.OpReplyEvent{}
	got := make(chan string, 16)
	reply := func(event *protocol.OpReplyEvent) {
		mu.Lock()
		replies[event.RequestID] = event
		mu.Unlock()
		got <- event.RequestID
	}
	start := func(id, run, command string, deadlineMs int) {
		e.Start(&protocol.OpCommand{
			Type: protocol.CommandOp, RequestID: id, RunID: run, Op: protocol.OpShell, DeadlineMs: deadlineMs,
			Args: &protocol.ShellArgs{Command: command, Cwd: home, TimeoutSeconds: 60},
		}, reply)
	}
	codeOf := func(id string) protocol.ReasonCode {
		t.Helper()
		for {
			select {
			case got := <-got:
				if got != id {
					continue
				}
				mu.Lock()
				defer mu.Unlock()
				if replies[id].Code == nil {
					return ""
				}
				return *replies[id].Code
			case <-time.After(10 * time.Second):
				t.Fatalf("no reply to %s", id)
				return ""
			}
		}
	}
	const (
		a = "a1b2c3d4-e5f6-4a7b-8c9d-000000000001"
		b = "a1b2c3d4-e5f6-4a7b-8c9d-000000000002"
		c = "a1b2c3d4-e5f6-4a7b-8c9d-000000000003"
		d = "a1b2c3d4-e5f6-4a7b-8c9d-000000000004"
	)
	start(a, testRun, "sleep 30", 60_000)
	start(b, testOther, "sleep 30", 60_000)
	start(c, testRun, "true", 60_000)
	if code := codeOf(c); code != protocol.CodeComputerLimit {
		t.Fatalf("third op: %q", code)
	}
	e.Cancel(b)
	e.EndRun(testRun)
	if code := codeOf(a); code != protocol.CodeComputerCancelled {
		t.Fatalf("run_ended: %q", code)
	}
	start(d, testRun, "sleep 30", 300)
	if code := codeOf(d); code != protocol.CodeComputerTimeout {
		t.Fatalf("deadline: %q", code)
	}
	e.Close()
	mu.Lock()
	defer mu.Unlock()
	if _, answered := replies[b]; answered {
		t.Fatal("a cancelled op was answered")
	}
}

func TestLargeResultsShrinkToTheReplyBound(t *testing.T) {
	big := strings.Repeat("\x01", 100_000) // six bytes each in JSON
	result := &protocol.ShellResult{Stdout: big, Stderr: big, StdoutBytes: 100_000, StderrBytes: 100_000}
	event, err := fitReply("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", result, 64_000)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(event)
	var back protocol.ShellResult
	if len(encoded) > 64_000 || protocol.Decode(event.Result, &back) != nil || !back.Truncated {
		t.Fatalf("shrunk to %d bytes, truncated=%v", len(encoded), back.Truncated)
	}
	read := &protocol.ReadResult{Content: strings.Repeat("line of text\n", 20_000), StartLine: 1, TotalLines: 20_000, Encoding: "utf-8", LineEnding: protocol.LineEndingLF}
	event, err = fitReply("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", read, 64_000)
	if err != nil || !strings.HasSuffix(read.Content, "\n") || !read.Truncated || len(event.Result) > 64_000 {
		t.Fatalf("read: %v %v", err, read.Truncated)
	}
	if _, err := fitReply("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", &protocol.StatResult{}, 10); err == nil {
		t.Fatal("an unshrinkable result fit 10 bytes")
	}
}

func TestDeviceInfoDescribesTheComputer(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	info := e.DeviceInfo()
	if err := info.Validate(); err != nil {
		t.Fatal(err)
	}
	if info.Home != home || info.Shell.Name != "sh" || info.OS != protocol.OS(runtime.GOOS) {
		t.Fatalf("info: %+v", info)
	}
	if got := validHome("linux", "relative"); got != "/" {
		t.Fatalf("relative home: %q", got)
	}
	if got := validHome("windows", `c:/Users/ivan/`); got != `C:\Users\ivan` {
		t.Fatalf("windows home: %q", got)
	}
}
