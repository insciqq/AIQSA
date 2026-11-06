package main

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func runHookArgs(stdin io.Reader, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(&invocation{ctx: context.Background(), args: append([]string{"hook"}, args...), stdin: stdin, stdout: &stdout, stderr: &stderr})
	return code, stdout.String(), stderr.String()
}

// blockingReader never ends, like an agent that keeps the pipe open.
type blockingReader struct{}

func (blockingReader) Read([]byte) (int, error) {
	time.Sleep(time.Hour)
	return 0, io.EOF
}

func TestHookIsSilentAndExitsZeroWhateverItGets(t *testing.T) {
	isolate(t)
	inputs := []io.Reader{
		strings.NewReader(`{"session_id":"abc","hook_event_name":"SessionEnd","cwd":"/tmp"}`),
		strings.NewReader("not json at all"),
		strings.NewReader(""),
		bytes.NewReader(bytes.Repeat([]byte("x"), 1<<20)),
	}
	for _, args := range [][]string{{"claude"}, {"codex"}, {}, {"bell", "ac-abc123"}, {"claude", "extra", "--flag"}} {
		for _, input := range inputs {
			if code, stdout, stderr := runHookArgs(input, args...); code != 0 || stdout != "" || stderr != "" {
				t.Fatalf("hook %v: %d %q %q", args, code, stdout, stderr)
			}
		}
	}
	started := time.Now()
	if code, _, _ := runHookArgs(blockingReader{}, "claude"); code != 0 || time.Since(started) > 5*time.Second {
		t.Fatalf("an endless input held the hook: %d after %s", code, time.Since(started))
	}
}
