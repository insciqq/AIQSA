package logx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEventKeepsCodesAndHidesContent(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf)
	l.Event("view_closed", "reason", "session_ended", "count", 3, "ok", true, "wait", 1500*time.Millisecond,
		"title", "My secret title", "path", "/home/user/project", "data", "echo hi\r", "err", fmt.Errorf("open /home/user: %w", os.ErrNotExist))
	line := buf.String()
	for _, want := range []string{" view_closed ", "reason=session_ended", "count=3", "ok=true", "wait=1.5s", "title=?", "path=?", "data=?", "err=not_found"} {
		if !strings.Contains(line, want) {
			t.Errorf("missing %q in %q", want, line)
		}
	}
	for _, leak := range []string{"secret", "/home", "echo"} {
		if strings.Contains(line, leak) {
			t.Errorf("leaked %q in %q", leak, line)
		}
	}
	type code string
	buf.Reset()
	l.Event("named", "code", code("connect_disabled"))
	if !strings.Contains(buf.String(), "code=connect_disabled") {
		t.Errorf("named string type: %q", buf.String())
	}
	buf.Reset()
	l.Event("Bad Name With Spaces", "Key With Space", 1)
	if !strings.Contains(buf.String(), " ? ?=1") {
		t.Errorf("unsafe name or key kept: %q", buf.String())
	}
}

func TestErrKind(t *testing.T) {
	if ErrKind(context.Canceled) != "canceled" || ErrKind(context.DeadlineExceeded) != "timeout" || ErrKind(errors.New("x /tmp")) != "error" {
		t.Fatal("unexpected kinds")
	}
}

func TestFileRotates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.log")
	file, err := openRotating(path, 100)
	if err != nil {
		t.Fatal(err)
	}
	l := New(file)
	l.file = file
	for range 10 {
		l.Event("tick", "n", 1)
	}
	l.Close()
	info, err := os.Stat(path)
	if err != nil || info.Size() > 100 || info.Mode().Perm() != 0o600 {
		t.Fatalf("current file: %v %v", info, err)
	}
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("rotated file: %v", err)
	}
}
