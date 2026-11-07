package ops

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
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

func (cp1251) MaxCharLen() int { return 1 }

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

// cp932 is a strict stand-in for Windows' ANSI code page 932 (Japanese),
// a double-byte code page: ASCII, the half-width katakana ｱ (0xB1) and
// the characters of cp932Pairs, a lead byte and a trail byte each, both
// 0x40 or above, so a run of them has no byte chunkEnd cuts after. Any
// other byte, and a lead byte that ends the data, is invalid, as
// MultiByteToWideChar with MB_ERR_INVALID_CHARS answers.
type cp932 struct{}

var cp932Pairs = map[string]rune{"\x82\xa0": 'あ', "\x82\xa2": 'い', "\x93\xfa": '日', "\x96\x7b": '本', "\x8c\xea": '語'}

func (cp932) Name() string { return "cp932" }

func (cp932) MaxCharLen() int { return 2 }

func (cp932) Decode(data []byte) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(data); i++ {
		switch c := data[i]; {
		case c < 0x80:
			b.WriteByte(c)
		case c == 0xB1:
			b.WriteRune('ｱ')
		default:
			r, ok := rune(0), false
			if i+1 < len(data) {
				r, ok = cp932Pairs[string(data[i:i+2])]
			}
			if !ok {
				return "", false
			}
			b.WriteRune(r)
			i++
		}
	}
	return b.String(), true
}

func (cp932) Encode(text string) ([]byte, bool) {
	var out []byte
next:
	for _, r := range text {
		switch {
		case r < 0x80:
			out = append(out, byte(r))
			continue
		case r == 'ｱ':
			out = append(out, 0xB1)
			continue
		}
		for pair, pr := range cp932Pairs {
			if pr == r {
				out = append(out, pair...)
				continue next
			}
		}
		return nil, false
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
	// start, when set, starts commands in place of the real Start.
	start func(sys System, cmd *exec.Cmd) (ProcessTree, error)
	// prepare and replace, when set, stand in for the real
	// PrepareReplacement and Replace.
	prepare func(tmp *os.File, path string, info fs.FileInfo) error
	replace func(tmp, path string) error
	// inPlace writes every existing file in place, as on macOS.
	inPlace bool
}

func (s testSystem) WritesInPlace() bool { return s.inPlace || s.System.WritesInPlace() }

func (s testSystem) PrepareReplacement(tmp *os.File, path string, info fs.FileInfo) error {
	if s.prepare != nil {
		return s.prepare(tmp, path, info)
	}
	return s.System.PrepareReplacement(tmp, path, info)
}

func (s testSystem) Replace(tmp, path string) error {
	if s.replace != nil {
		return s.replace(tmp, path)
	}
	return s.System.Replace(tmp, path)
}

func (s testSystem) Start(cmd *exec.Cmd) (ProcessTree, error) {
	if s.start != nil {
		return s.start(s.System, cmd)
	}
	return s.System.Start(cmd)
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
