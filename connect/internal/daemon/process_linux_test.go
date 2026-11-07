//go:build linux

package daemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// alive reports whether pid runs (a zombie does not).
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	fields := strings.Fields(string(data))
	return len(fields) < 3 || fields[2] != "Z"
}

const sleepersCommand = "sleep 30 & echo $! > child.pid; echo $$ > parent.pid; wait"

// startSleepers runs a command whose shell and child both sleep, and
// returns their pids once both wrote them.
func startSleepers(t *testing.T, stream *fakeStream, dir, id, run string, background bool) (int, int) {
	t.Helper()
	stream.command(opCommand(id, run, protocol.OpShell, map[string]any{"command": sleepersCommand, "cwd": dir, "timeoutSeconds": 120, "background": background}))
	return sleeperPids(t, dir)
}

// sleeperPids waits until the sleepers in dir wrote their pids.
func sleeperPids(t *testing.T, dir string) (int, int) {
	t.Helper()
	var pids [2]int
	for i, name := range []string{"parent.pid", "child.pid"} {
		for deadline := time.Now().Add(10 * time.Second); pids[i] == 0; time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("%s not written", name)
			}
			data, err := os.ReadFile(filepath.Join(dir, name))
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && convErr == nil {
				pids[i] = pid
			}
		}
	}
	return pids[0], pids[1]
}

func waitGone(t *testing.T, within time.Duration, pids ...int) {
	t.Helper()
	deadline := time.Now().Add(within)
	for _, pid := range pids {
		for alive(pid) {
			if time.Now().After(deadline) {
				t.Fatalf("process still running after %v", within)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

// cancel and run_ended stop a running command and its child within 5 s;
// stopping the client stops every job before Run returns.
func TestCancelAndRunEndedStopTheCommandAndItsChild(t *testing.T) {
	server := newFakeServer(t)
	h := newShHarness(t, server)
	h.start()
	stream := server.nextStream(t)

	dir := t.TempDir()
	parent, child := startSleepers(t, stream, dir, requestN(1), runID, false)
	stream.command(map[string]any{"type": "cancel", "requestId": requestN(1)})
	waitGone(t, 5*time.Second, parent, child)

	dir = t.TempDir()
	parent, child = startSleepers(t, stream, dir, requestN(2), runID, false)
	jobDir := t.TempDir()
	stream.command(opCommand(requestN(3), runID, protocol.OpShell, map[string]any{
		"command": sleepersCommand, "cwd": jobDir, "timeoutSeconds": 120, "background": true,
	}))
	decodeReply(t, server, requestN(3), protocol.OpShell)
	jobParent, jobChild := sleeperPids(t, jobDir)
	otherDir := t.TempDir()
	otherParent, otherChild := startSleepers(t, stream, otherDir, requestN(4), otherRun, true)

	stream.command(map[string]any{"type": "run_ended", "runId": runID})
	reply := server.waitEvent(t, replyFor(requestN(2))).(*protocol.OpReplyEvent)
	if reply.OK || *reply.Code != protocol.CodeComputerCancelled {
		t.Fatalf("reply after run_ended: %+v", reply)
	}
	waitGone(t, 5*time.Second, parent, child, jobParent, jobChild)
	if !alive(otherParent) || !alive(otherChild) {
		t.Fatal("run_ended stopped another run's job")
	}
	// The cancelled op was not answered: the server stopped waiting for it.
	server.mu.Lock()
	for _, event := range server.recorded {
		if reply, ok := event.(*protocol.OpReplyEvent); ok && reply.RequestID == requestN(1) {
			t.Errorf("a cancelled op was answered: %+v", reply)
		}
	}
	server.mu.Unlock()

	// Stopping the client ends the other run's job before Run returns.
	h.stop(t)
	waitGone(t, time.Second, otherParent, otherChild)
}

// When the administrator turns AIQSA Connect off or revokes the device, no
// run_ended can come any more: every op and background job ends at once,
// before the client waits or exits.
func TestDisabledAndRevokedStopEveryJob(t *testing.T) {
	cases := []struct {
		code    protocol.ReasonCode
		revoked bool
	}{
		{protocol.CodeDisabled, false},
		{protocol.CodeUnauthorized, true},
	}
	for _, tc := range cases {
		t.Run(string(tc.code), func(t *testing.T) {
			server := newFakeServer(t)
			h := newShHarness(t, server)
			// A long wait while off: the jobs must end before it, not after.
			h.daemon.timing.DisabledRetry = time.Minute
			h.start()
			stream := server.nextStream(t)
			jobDir := t.TempDir()
			stream.command(opCommand(requestN(1), runID, protocol.OpShell, map[string]any{
				"command": sleepersCommand, "cwd": jobDir, "timeoutSeconds": 120, "background": true,
			}))
			decodeReply(t, server, requestN(1), protocol.OpShell)
			jobParent, jobChild := sleeperPids(t, jobDir)
			opParent, opChild := startSleepers(t, stream, t.TempDir(), requestN(2), otherRun, false)
			stream.send(protocol.StreamEventClosed, map[string]string{"code": string(tc.code)})
			waitGone(t, 5*time.Second, jobParent, jobChild, opParent, opChild)
			if tc.revoked {
				if err := h.wait(t); !errors.Is(err, ErrRevoked) {
					t.Fatalf("got %v", err)
				}
				return
			}
			h.stop(t)
		})
	}
}
