//go:build !windows

package ops

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func opID(n int) string { return fmt.Sprintf("a1b2c3d4-e5f6-4a7b-8c9d-%012d", n) }

// startOp runs one op through Start and returns where its reply arrives.
func startOp(e *Executor, id, run string, args protocol.OpArgs, deadlineMs int) <-chan *protocol.OpReplyEvent {
	replies := make(chan *protocol.OpReplyEvent, 1)
	e.Start(&protocol.OpCommand{Type: protocol.CommandOp, RequestID: id, RunID: run, Op: args.ArgsOp(), Args: args, DeadlineMs: deadlineMs},
		func(reply *protocol.OpReplyEvent) { replies <- reply })
	return replies
}

func replyCode(t *testing.T, replies <-chan *protocol.OpReplyEvent) protocol.ReasonCode {
	t.Helper()
	select {
	case reply := <-replies:
		if reply.Code == nil {
			return ""
		}
		return *reply.Code
	case <-time.After(10 * time.Second):
		t.Fatal("no reply")
		return ""
	}
}

// gone waits until pid no longer exists (Wait reaped it).
func gone(t *testing.T, within time.Duration, pids ...int) {
	t.Helper()
	deadline := time.Now().Add(within)
	for _, pid := range pids {
		for syscall.Kill(pid, 0) == nil {
			if time.Now().After(deadline) {
				t.Fatalf("process still running after %v", within)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func running(pid int) bool { return syscall.Kill(pid, 0) == nil }

// pidOf waits for the pid a command wrote to file.
func pidOf(t *testing.T, file string) int {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		data, err := os.ReadFile(file)
		if pid, convErr := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && convErr == nil {
			return pid
		}
	}
	t.Fatalf("%s not written", filepath.Base(file))
	return 0
}

func (e *Executor) jobCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.jobs) + len(e.starting)
}

func (e *Executor) opCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.running)
}

// A run's end, a cancel or the deadline that comes while a background
// job's process starts ends that process; no job remains.
func TestAJobWhoseStartLosesToTheRunsEndLeavesNothing(t *testing.T) {
	cases := []struct {
		name     string
		deadline int
		viaOp    bool
		race     func(e *Executor, id string)
		want     protocol.ReasonCode
		answered bool
	}{
		{"run ended", 60_000, true, func(e *Executor, _ string) { e.EndRun(testRun) }, protocol.CodeComputerCancelled, true},
		{"run ended without an op", 60_000, false, func(e *Executor, _ string) { e.EndRun(testRun) }, protocol.CodeComputerCancelled, true},
		{"cancelled", 60_000, true, func(e *Executor, id string) { e.Cancel(id) }, "", false},
		{"deadline", 200, true, func(*Executor, string) { time.Sleep(400 * time.Millisecond) }, protocol.CodeComputerTimeout, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entered := make(chan int, 1)
			gate := make(chan struct{})
			e, home := newTestExecutor(t, testSystem{start: func(sys System, cmd *exec.Cmd) (ProcessTree, error) {
				tree, err := sys.Start(cmd)
				if err == nil {
					entered <- cmd.Process.Pid
				}
				<-gate
				return tree, err
			}})
			args := &protocol.ShellArgs{Command: "sleep 30", Cwd: home, TimeoutSeconds: 1, Background: true}
			id := opID(1)
			var replies <-chan *protocol.OpReplyEvent
			if tc.viaOp {
				replies = startOp(e, id, testRun, args, tc.deadline)
			} else {
				direct := make(chan *protocol.OpReplyEvent, 1)
				replies = direct
				go func() {
					_, code := e.execute(context.Background(), &protocol.OpCommand{Type: protocol.CommandOp, RunID: testRun, Op: protocol.OpShell, Args: args, DeadlineMs: tc.deadline}, e.currentLimits())
					direct <- protocol.NewOpReplyError(id, code)
				}()
			}
			pid := <-entered
			tc.race(e, id)
			close(gate)
			if tc.answered {
				if code := replyCode(t, replies); code != tc.want {
					t.Fatalf("code %q, want %q", code, tc.want)
				}
			}
			gone(t, 5*time.Second, pid)
			for deadline := time.Now().Add(5 * time.Second); e.opCount() > 0; time.Sleep(10 * time.Millisecond) {
				if time.Now().After(deadline) {
					t.Fatal("the op did not end")
				}
			}
			if n := e.jobCount(); n != 0 {
				t.Fatalf("%d jobs remain", n)
			}
			if !tc.answered {
				select {
				case reply := <-replies:
					t.Fatalf("a cancelled op was answered: %+v", reply)
				default:
				}
			}
		})
	}
}

// StopAll ends every op and job, answers none of them, and new ops run.
func TestStopAllEndsOpsAndJobsAndKeepsTheExecutor(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	jobPid := filepath.Join(home, "job.pid")
	mustRun[*protocol.ShellJobResult](t, e, &protocol.ShellArgs{Command: "echo $$ > job.pid; sleep 30", Cwd: home, TimeoutSeconds: 1, Background: true})
	opPid := filepath.Join(home, "op.pid")
	replies := startOp(e, opID(1), testOther, &protocol.ShellArgs{Command: "echo $$ > op.pid; sleep 30", Cwd: home, TimeoutSeconds: 60}, 60_000)
	job, op := pidOf(t, jobPid), pidOf(t, opPid)
	e.StopAll()
	gone(t, 5*time.Second, job, op)
	if n := e.jobCount(); n != 0 {
		t.Fatalf("%d jobs remain", n)
	}
	for deadline := time.Now().Add(5 * time.Second); e.opCount() > 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the op did not end")
		}
	}
	select {
	case reply := <-replies:
		t.Fatalf("a stopped op was answered: %+v", reply)
	default:
	}
	if code := replyCode(t, startOp(e, opID(2), testRun, &protocol.ShellArgs{Command: "true", Cwd: home, TimeoutSeconds: 10}, 10_000)); code != "" {
		t.Fatalf("after StopAll: %q", code)
	}
}

// A job whose run sent no command for the lease ends; a run that keeps
// sending commands keeps its job.
func TestJobsEndWhenTheirRunsLeaseRunsOut(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	e.lease = 400 * time.Millisecond
	silent := mustRun[*protocol.ShellJobResult](t, e, &protocol.ShellArgs{Command: "echo $$ > silent.pid; sleep 30", Cwd: home, TimeoutSeconds: 1, Background: true})
	reply := <-startOp(e, opID(1), testOther, &protocol.ShellArgs{Command: "echo $$ > busy.pid; sleep 30", Cwd: home, TimeoutSeconds: 1, Background: true}, 10_000)
	var busy protocol.ShellJobResult
	if !reply.OK || protocol.Decode(reply.Result, &busy) != nil {
		t.Fatalf("job start: %+v", reply)
	}
	silentPid, busyPid := pidOf(t, filepath.Join(home, "silent.pid")), pidOf(t, filepath.Join(home, "busy.pid"))
	for n := range 15 {
		if code := replyCode(t, startOp(e, opID(10+n), testOther, &protocol.JobOutputArgs{JobID: busy.JobID}, 10_000)); code != "" {
			t.Fatalf("job_output of the busy run: %q", code)
		}
		time.Sleep(100 * time.Millisecond)
	}
	gone(t, time.Second, silentPid)
	if e.findJob(silent.JobID) != nil {
		t.Fatal("the silent run's job is still known")
	}
	if !running(busyPid) || e.findJob(busy.JobID) == nil {
		t.Fatal("the lease ended a job whose run kept sending commands")
	}
	gone(t, 5*time.Second, busyPid)
	if e.findJob(busy.JobID) != nil {
		t.Fatal("the busy run's job outlived its lease")
	}
}
