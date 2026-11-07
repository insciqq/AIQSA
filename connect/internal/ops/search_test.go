package ops

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func TestGlobMatcher(t *testing.T) {
	for _, tc := range []struct {
		pattern, path string
		fold, want    bool
	}{
		{"*.go", "main.go", false, true},
		{"*.go", "cmd/main.go", false, false},
		{"**/*.go", "main.go", false, true},
		{"**/*.go", "a/b/c/main.go", false, true},
		{"src/**/test_*.py", "src/x/y/test_a.py", false, true},
		{"src/**/test_*.py", "lib/test_a.py", false, false},
		{"*.{md,txt}", "notes.txt", false, true},
		{"*.{md,txt}", "notes.doc", false, false},
		{"Reports/*.DOCX", "reports/q3.docx", true, true},
		{"Reports/*.DOCX", "reports/q3.docx", false, false},
		{"a?c", "abc", false, true},
		{"[ab]*", "beta", false, true},
	} {
		m, err := compileGlob(tc.pattern, tc.fold)
		if err != nil {
			t.Fatalf("%s: %v", tc.pattern, err)
		}
		if got := m.match(tc.path); got != tc.want {
			t.Errorf("%q ~ %q (fold %v) = %v", tc.pattern, tc.path, tc.fold, got)
		}
	}
	for _, bad := range []string{"[a", "{a,b", strings.Repeat("{a,b}", 8)} {
		if _, err := compileGlob(bad, false); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestGlobNewestFirstSkippingVendorFolders(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	root := filepath.Join(home, "proj")
	now := time.Now()
	for i, name := range []string{"old.go", "pkg/mid.go", "pkg/deep/new.go", "node_modules/x/dep.go", ".git/hooks/h.go", "readme.md"} {
		path := filepath.Join(root, name)
		writeTestFile(t, path, []byte("x"))
		os.Chtimes(path, now, now.Add(time.Duration(i)*time.Minute))
	}
	glob := mustRun[*protocol.GlobResult](t, e, &protocol.GlobArgs{Pattern: "**/*.go", Cwd: root})
	want := []string{filepath.Join(root, "pkg/deep/new.go"), filepath.Join(root, "pkg/mid.go"), filepath.Join(root, "old.go")}
	if strings.Join(glob.Paths, ",") != strings.Join(want, ",") || glob.Truncated {
		t.Fatalf("glob: %v", glob.Paths)
	}
	// Named or searched from inside, the skipped folders count.
	glob = mustRun[*protocol.GlobResult](t, e, &protocol.GlobArgs{Pattern: "node_modules/**/*.go", Cwd: root})
	if len(glob.Paths) != 1 {
		t.Fatalf("named: %v", glob.Paths)
	}
	glob = mustRun[*protocol.GlobResult](t, e, &protocol.GlobArgs{Pattern: "**/*.go", Cwd: root, Path: ptr(".git")})
	if len(glob.Paths) != 1 {
		t.Fatalf("inside .git: %v", glob.Paths)
	}
	glob = mustRun[*protocol.GlobResult](t, e, &protocol.GlobArgs{Pattern: filepath.Join(root, "pkg", "*.go"), Cwd: "/"})
	if len(glob.Paths) != 1 || glob.Paths[0] != filepath.Join(root, "pkg/mid.go") {
		t.Fatalf("absolute pattern: %v", glob.Paths)
	}
	wantCode(t, e, &protocol.GlobArgs{Pattern: "[x", Cwd: root}, protocol.CodeComputerPatternInvalid)
	wantCode(t, e, &protocol.GlobArgs{Pattern: "*", Cwd: filepath.Join(root, "readme.md")}, protocol.CodeComputerNotADirectory)
	wantCode(t, e, &protocol.GlobArgs{Pattern: "*", Cwd: filepath.Join(root, "nope")}, protocol.CodeComputerPathNotFound)
}

func TestGlobIsBounded(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	root := filepath.Join(home, "many")
	os.MkdirAll(root, 0o755)
	for i := range protocol.MaxGlobPaths + 5 {
		os.WriteFile(filepath.Join(root, fmt.Sprintf("f%04d.txt", i)), nil, 0o644)
	}
	glob := mustRun[*protocol.GlobResult](t, e, &protocol.GlobArgs{Pattern: "*.txt", Cwd: root})
	if len(glob.Paths) != protocol.MaxGlobPaths || !glob.Truncated {
		t.Fatalf("bounded: %d %v", len(glob.Paths), glob.Truncated)
	}
}

func TestGrepModesContextAndFilters(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{codePage: cp1251{}})
	root := filepath.Join(home, "docs")
	writeTestFile(t, filepath.Join(root, "a.txt"), []byte("intro\nДоговор №12\nend\n\nДоговор 13\n"))
	ansi, _ := cp1251{}.Encode("старый договор\r\n")
	writeTestFile(t, filepath.Join(root, "old", "b.txt"), ansi)
	writeTestFile(t, filepath.Join(root, "c.md"), []byte("договор\n"))
	writeTestFile(t, filepath.Join(root, "image.bin"), []byte("договор\x00"))
	writeTestFile(t, filepath.Join(root, "node_modules", "d.txt"), []byte("договор\n"))
	os.Chtimes(filepath.Join(root, "c.md"), time.Now(), time.Now().Add(time.Hour))

	files := mustRun[*protocol.GrepResult](t, e, &protocol.GrepArgs{Pattern: "договор", Cwd: root, IgnoreCase: true, Mode: protocol.GrepFiles})
	var paths []string
	for _, m := range files.Matches {
		paths = append(paths, strings.TrimPrefix(m.Path, root+"/"))
	}
	if len(paths) != 3 || paths[0] != "c.md" {
		t.Fatalf("files: %v", paths)
	}
	count := mustRun[*protocol.GrepResult](t, e, &protocol.GrepArgs{Pattern: "Договор", Cwd: root, Mode: protocol.GrepCount, Glob: ptr("*.txt")})
	if len(count.Matches) != 1 || *count.Matches[0].Count != 2 {
		t.Fatalf("count: %+v", count.Matches)
	}
	content := mustRun[*protocol.GrepResult](t, e, &protocol.GrepArgs{Pattern: `№\d+`, Cwd: root, Path: ptr("a.txt"), Mode: protocol.GrepContent, Context: 1})
	var lines []string
	for _, m := range content.Matches {
		lines = append(lines, fmt.Sprintf("%d:%s:%v", *m.Line, *m.Text, m.Context != nil))
	}
	if strings.Join(lines, "|") != "1:intro:true|2:Договор №12:false|3:end:true" {
		t.Fatalf("content: %v", lines)
	}
	inside := mustRun[*protocol.GrepResult](t, e, &protocol.GrepArgs{Pattern: "договор", Cwd: root, Path: ptr("node_modules"), Mode: protocol.GrepFiles})
	if len(inside.Matches) != 1 {
		t.Fatalf("inside node_modules: %+v", inside.Matches)
	}
	wantCode(t, e, &protocol.GrepArgs{Pattern: "(", Cwd: root, Mode: protocol.GrepFiles}, protocol.CodeComputerPatternInvalid)
	wantCode(t, e, &protocol.GrepArgs{Pattern: "x", Cwd: root, Path: ptr("nope"), Mode: protocol.GrepFiles}, protocol.CodeComputerPathNotFound)
}

func TestGrepIsBounded(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	path := filepath.Join(home, "big.txt")
	writeTestFile(t, path, []byte(strings.Repeat("match "+strings.Repeat("x", 3000)+"\n", protocol.MaxGrepMatches+10)))
	grep := mustRun[*protocol.GrepResult](t, e, &protocol.GrepArgs{Pattern: "match", Cwd: home, Mode: protocol.GrepContent})
	if len(grep.Matches) != protocol.MaxGrepMatches || !grep.Truncated || len([]rune(*grep.Matches[0].Text)) != protocol.MaxReadLineLength {
		t.Fatalf("bounded: %d %v", len(grep.Matches), grep.Truncated)
	}
	// The reply carrying it fits the reply bound.
	event, err := fitReply("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", grep, protocol.MaxReplyBytes)
	if err != nil {
		t.Fatal(err)
	}
	if encoded, _ := marshal(event); len(encoded) > protocol.MaxReplyBytes {
		t.Fatalf("reply %d bytes", len(encoded))
	}
}
