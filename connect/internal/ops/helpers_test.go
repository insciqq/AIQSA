package ops

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

const (
	testRun   = "11111111-2222-4333-8444-555555555555"
	testOther = "11111111-2222-4333-8444-666666666666"
)

// cp1251 is a stand-in for Windows' ANSI code page 1251 (Cyrillic): ASCII,
// А..я and Ё ё. Other high bytes are invalid.
type cp1251 struct{}

func (cp1251) Name() string { return "windows-1251" }

func (cp1251) Decode(data []byte) (string, bool) {
	var b strings.Builder
	for _, c := range data {
		switch {
		case c < 0x80:
			b.WriteByte(c)
		case c >= 0xC0:
			b.WriteRune(rune(0x410 + int(c) - 0xC0))
		case c == 0xA8:
			b.WriteRune('Ё')
		case c == 0xB8:
			b.WriteRune('ё')
		default:
			return "", false
		}
	}
	return b.String(), true
}

func (cp1251) Encode(text string) ([]byte, bool) {
	var out []byte
	for _, r := range text {
		switch {
		case r < 0x80:
			out = append(out, byte(r))
		case r >= 0x410 && r <= 0x44F:
			out = append(out, byte(r-0x410+0xC0))
		case r == 'Ё':
			out = append(out, 0xA8)
		case r == 'ё':
			out = append(out, 0xB8)
		default:
			return nil, false
		}
	}
	return out, true
}

// cp866Fallback decodes the Cyrillic of OEM code page 866 (А..п at 0x80,
// р..я at 0xE0).
func cp866Fallback(data []byte) string {
	var b strings.Builder
	for _, c := range data {
		switch {
		case c < 0x80:
			b.WriteByte(c)
		case c <= 0xAF:
			b.WriteRune(rune(0x410 + int(c) - 0x80))
		case c >= 0xE0 && c <= 0xEF:
			b.WriteRune(rune(0x440 + int(c) - 0xE0))
		default:
			b.WriteRune(utf8.RuneError)
		}
	}
	return b.String()
}

// testSystem is the real system with /bin/sh as the shell and, when set,
// a code page and an output fallback like Windows has.
type testSystem struct {
	System
	codePage CodePage
	fallback func([]byte) string
	hidden   func(fs.FileInfo) bool
}

func (s testSystem) DetectShell() Shell {
	return Shell{Kind: protocol.ShellPOSIX, Name: "sh", Path: "/bin/sh"}
}

func (s testSystem) TextCodePage() CodePage { return s.codePage }

func (s testSystem) OutputFallback(data []byte) string {
	if s.fallback != nil {
		return s.fallback(data)
	}
	return s.System.OutputFallback(data)
}

func (s testSystem) Hidden(info fs.FileInfo) bool {
	if s.hidden != nil {
		return s.hidden(info)
	}
	return false
}

func newTestExecutor(t *testing.T, sys testSystem) (*Executor, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	sys.System = Native()
	e := New(Options{Home: home, RecentFile: filepath.Join(t.TempDir(), "recent-dirs.json"), System: sys})
	t.Cleanup(e.Close)
	return e, home
}

func writeTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readTestFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// run executes one op synchronously and returns its result or code.
func run(t *testing.T, e *Executor, args protocol.OpArgs) (protocol.Validator, protocol.ReasonCode) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, code := e.execute(ctx, &protocol.OpCommand{Type: protocol.CommandOp, RunID: testRun, Op: args.ArgsOp(), Args: args, DeadlineMs: 30_000}, e.currentLimits())
	if code == "" {
		if err := result.Validate(); err != nil {
			t.Fatalf("%s result invalid: %v", args.ArgsOp(), err)
		}
	}
	return result, code
}

func mustRun[T protocol.Validator](t *testing.T, e *Executor, args protocol.OpArgs) T {
	t.Helper()
	result, code := run(t, e, args)
	if code != "" {
		t.Fatalf("%s: %s", args.ArgsOp(), code)
	}
	return result.(T)
}

func wantCode(t *testing.T, e *Executor, args protocol.OpArgs, want protocol.ReasonCode) {
	t.Helper()
	if _, code := run(t, e, args); code != want {
		t.Fatalf("%s: code %q, want %q", args.ArgsOp(), code, want)
	}
}

func ptr[T any](v T) *T { return &v }
