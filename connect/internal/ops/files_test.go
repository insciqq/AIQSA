package ops

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func TestReadLinesWithOffsetLimitAndLineCap(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	var b strings.Builder
	for i := 1; i <= 10; i++ {
		b.WriteString("line ")
		b.WriteString(strings.Repeat("x", i))
		b.WriteString("\n")
	}
	b.WriteString(strings.Repeat("я", 2500))
	writeTestFile(t, filepath.Join(home, "a.txt"), []byte(b.String()))

	r := mustRun[*protocol.ReadResult](t, e, &protocol.ReadArgs{Path: "a.txt", Cwd: "~", Offset: 3, Limit: 2})
	if r.Content != "line xxx\nline xxxx\n" || r.StartLine != 3 || r.TotalLines != 11 || !r.Truncated || r.LineEnding != protocol.LineEndingLF {
		t.Fatalf("slice: %+v", r)
	}
	r = mustRun[*protocol.ReadResult](t, e, &protocol.ReadArgs{Path: filepath.Join(home, "a.txt"), Cwd: "/", Offset: 11, Limit: 5})
	if r.Content != strings.Repeat("я", protocol.MaxReadLineLength) || !r.Truncated {
		t.Fatalf("long line: %d chars, truncated=%v", len([]rune(r.Content)), r.Truncated)
	}
	r = mustRun[*protocol.ReadResult](t, e, &protocol.ReadArgs{Path: "a.txt", Cwd: home, Offset: 50, Limit: 5})
	if r.Content != "" || r.TotalLines != 11 || r.StartLine != 50 {
		t.Fatalf("past the end: %+v", r)
	}
	writeTestFile(t, filepath.Join(home, "empty.txt"), nil)
	if r := mustRun[*protocol.ReadResult](t, e, &protocol.ReadArgs{Path: "empty.txt", Cwd: home, Offset: 1, Limit: 10}); r.TotalLines != 0 || r.LineEnding != protocol.LineEndingNone {
		t.Fatalf("empty: %+v", r)
	}
}

func TestReadDecodesBOMsUTF16AndTheANSICodePage(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{codePage: cp1251{}})
	utf16le := []byte{0xFF, 0xFE}
	for _, r := range "Отчёт\r\nok\r\n" {
		utf16le = append(utf16le, byte(r), byte(r>>8))
	}
	utf16be := []byte{0xFE, 0xFF}
	for _, r := range "Hi\n" {
		utf16be = append(utf16be, byte(r>>8), byte(r))
	}
	ansi, _ := cp1251{}.Encode("# Отчёт\r\n\tстрока 2\r\n")
	for name, tc := range map[string]struct {
		data              []byte
		content, encoding string
		ending            protocol.LineEnding
	}{
		"utf-16le":  {utf16le, "Отчёт\nok\n", "utf-16le", protocol.LineEndingCRLF},
		"utf-16be":  {utf16be, "Hi\n", "utf-16be", protocol.LineEndingLF},
		"utf-8 bom": {append([]byte{0xEF, 0xBB, 0xBF}, "a\r\nb\n"...), "a\nb\n", "utf-8-bom", protocol.LineEndingMixed},
		"ansi":      {ansi, "# Отчёт\n\tстрока 2\n", "windows-1251", protocol.LineEndingCRLF},
	} {
		writeTestFile(t, filepath.Join(home, name), tc.data)
		r := mustRun[*protocol.ReadResult](t, e, &protocol.ReadArgs{Path: name, Cwd: home, Offset: 1, Limit: 100})
		if r.Content != tc.content || r.Encoding != tc.encoding || r.LineEnding != tc.ending {
			t.Errorf("%s: %+v", name, r)
		}
	}
}

func TestReadRefusals(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	writeTestFile(t, filepath.Join(home, "bin"), []byte("ELF\x00\x01\x02"))
	wantCode(t, e, &protocol.ReadArgs{Path: "bin", Cwd: home, Offset: 1, Limit: 10}, protocol.CodeComputerFileBinary)
	wantCode(t, e, &protocol.ReadArgs{Path: "missing", Cwd: home, Offset: 1, Limit: 10}, protocol.CodeComputerPathNotFound)
	wantCode(t, e, &protocol.ReadArgs{Path: ".", Cwd: home, Offset: 1, Limit: 10}, protocol.CodeComputerIsADirectory)
	previous := maxTextFileBytes
	maxTextFileBytes = 16
	t.Cleanup(func() { maxTextFileBytes = previous })
	writeTestFile(t, filepath.Join(home, "big"), bytes.Repeat([]byte("a"), 17))
	wantCode(t, e, &protocol.ReadArgs{Path: "big", Cwd: home, Offset: 1, Limit: 10}, protocol.CodeComputerFileTooLarge)
	if os.Getuid() != 0 {
		writeTestFile(t, filepath.Join(home, "secret"), []byte("x"))
		os.Chmod(filepath.Join(home, "secret"), 0)
		wantCode(t, e, &protocol.ReadArgs{Path: "secret", Cwd: home, Offset: 1, Limit: 10}, protocol.CodeComputerPermissionDenied)
	}
}

func TestWriteCreatesFoldersAndKeepsCRLFAndBOM(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	w := mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: "a/b/new.txt", Cwd: home, Content: "один\nдва\n"})
	if !w.Created || w.Bytes != int64(len("один\nдва\n")) {
		t.Fatalf("new: %+v", w)
	}
	if got := readTestFile(t, filepath.Join(home, "a/b/new.txt")); string(got) != "один\nдва\n" {
		t.Fatalf("new content: %q", got)
	}
	crlf := filepath.Join(home, "crlf.txt")
	writeTestFile(t, crlf, append([]byte{0xEF, 0xBB, 0xBF}, "old\r\nlines\r\n"...))
	w = mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: crlf, Cwd: home, Content: "new\ntext\n"})
	if w.Created {
		t.Fatalf("replace: %+v", w)
	}
	if got := readTestFile(t, crlf); string(got) != "\xEF\xBB\xBFnew\r\ntext\r\n" {
		t.Fatalf("replaced content: %q", got)
	}
	wantCode(t, e, &protocol.WriteArgs{Path: "a", Cwd: home, Content: "x"}, protocol.CodeComputerIsADirectory)
}

func utf16Bytes(bom []byte, bigEndian bool, text string) []byte {
	out := append([]byte{}, bom...)
	for _, r := range text {
		if bigEndian {
			out = append(out, byte(r>>8), byte(r))
		} else {
			out = append(out, byte(r), byte(r>>8))
		}
	}
	return out
}

// Replacing a file keeps its encoding as edit does; text its code page
// cannot hold writes nothing.
func TestWriteKeepsTheFilesEncoding(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{codePage: cp1251{}})
	ansiOld, _ := cp1251{}.Encode("Договор\r\nсумма\r\n")
	ansiNew, _ := cp1251{}.Encode("Итог\r\nвсего\r\n")
	for name, tc := range map[string]struct {
		old, want []byte
		content   string
	}{
		"utf-16le": {utf16Bytes(bomUTF16LE, false, "Привет\r\n"), utf16Bytes(bomUTF16LE, false, "Пока\r\nвсем\r\n"), "Пока\nвсем\n"},
		"utf-16be": {utf16Bytes(bomUTF16BE, true, "Hi\n"), utf16Bytes(bomUTF16BE, true, "Bye ∑\n"), "Bye ∑\n"},
		// A leading BOM in the content is not written twice.
		"utf-8 bom": {append([]byte{0xEF, 0xBB, 0xBF}, "a\n"...), append([]byte{0xEF, 0xBB, 0xBF}, "b\n"...), "\ufeffb\n"},
		"ansi":      {ansiOld, ansiNew, "Итог\nвсего\n"},
		"utf-8":     {[]byte("old\n"), []byte("новое\n"), "новое\n"},
		// A file that is not text becomes UTF-8.
		"binary": {[]byte("ELF\x00\x01"), []byte("text\n"), "text\n"},
	} {
		path := filepath.Join(home, name)
		writeTestFile(t, path, tc.old)
		w := mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: tc.content})
		if got := readTestFile(t, path); !bytes.Equal(got, tc.want) || w.Created || w.Bytes != int64(len(tc.want)) {
			t.Errorf("%s: % x (%+v)", name, got, w)
		}
	}
	ansi := filepath.Join(home, "ansi")
	wantCode(t, e, &protocol.WriteArgs{Path: ansi, Cwd: home, Content: "Договор №1\n"}, protocol.CodeComputerTextUnencodable)
	if got := readTestFile(t, ansi); !bytes.Equal(got, ansiNew) {
		t.Fatal("a refused write wrote the file")
	}
}

// Without a code page (macOS, Linux) a file that is not UTF-8 has an
// unknown encoding: a write beyond ASCII is refused and leaves it as it was,
// while ASCII, which every such encoding stores alike, is written.
func TestWriteOverAnUnknownEncodingRefusesTextBeyondASCII(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	legacy, _ := cp1251{}.Encode("Сумма: 100\r\n")
	path := filepath.Join(home, "legacy.txt")
	writeTestFile(t, path, legacy)
	wantCode(t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "Сумма: 200\n"}, protocol.CodeComputerTextUnencodable)
	if got := readTestFile(t, path); !bytes.Equal(got, legacy) {
		t.Fatalf("a refused write changed the file: % x", got)
	}
	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "Total: 200\n"})
	if got := readTestFile(t, path); string(got) != "Total: 200\r\n" {
		t.Fatalf("ASCII write: %q", got)
	}
}

// A file too large to load keeps its encoding, BOM and line endings, told
// from its start even where that start ends inside a character; a file
// that cannot be read is not written.
func TestWriteOverAFileTooLargeToLoadKeepsItsEncoding(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{codePage: cp1251{}})
	previous := maxTextFileBytes
	// Odd, so the start read ends inside a UTF-16 code unit.
	maxTextFileBytes = 65
	t.Cleanup(func() { maxTextFileBytes = previous })

	utf16 := filepath.Join(home, "utf16.txt")
	writeTestFile(t, utf16, utf16Bytes(bomUTF16LE, false, strings.Repeat("строка\r\n", 6)))
	w := mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: utf16, Cwd: home, Content: "новое\nвсё\n"})
	want := utf16Bytes(bomUTF16LE, false, "новое\r\nвсё\r\n")
	if got := readTestFile(t, utf16); !bytes.Equal(got, want) || w.Bytes != int64(len(want)) {
		t.Fatalf("utf-16: % x (%+v)", got, w)
	}

	// "Ш" is D0 A8 in UTF-8, both bytes letters of the code page: cut after
	// D0, the start must still read as UTF-8.
	utf8File := filepath.Join(home, "utf8.txt")
	writeTestFile(t, utf8File, []byte(strings.Repeat("Ш", 40)))
	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: utf8File, Cwd: home, Content: "Шов\n"})
	if got := readTestFile(t, utf8File); string(got) != "Шов\n" {
		t.Fatalf("utf-8: % x", got)
	}

	ansi := filepath.Join(home, "ansi.txt")
	ansiOld, _ := cp1251{}.Encode(strings.Repeat("Договор\r\n", 10))
	writeTestFile(t, ansi, ansiOld)
	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: ansi, Cwd: home, Content: "Итог\n"})
	if ansiNew, _ := (cp1251{}).Encode("Итог\r\n"); !bytes.Equal(readTestFile(t, ansi), ansiNew) {
		t.Fatalf("ansi: % x", readTestFile(t, ansi))
	}

	if os.Getuid() != 0 {
		writeOnly := filepath.Join(home, "write-only.txt")
		writeTestFile(t, writeOnly, utf16Bytes(bomUTF16LE, false, "x"))
		if err := os.Chmod(writeOnly, 0o200); err != nil {
			t.Fatal(err)
		}
		wantCode(t, e, &protocol.WriteArgs{Path: writeOnly, Cwd: home, Content: "y"}, protocol.CodeComputerPermissionDenied)
		os.Chmod(writeOnly, 0o600)
		if got := readTestFile(t, writeOnly); !bytes.Equal(got, utf16Bytes(bomUTF16LE, false, "x")) {
			t.Fatalf("a file that could not be read was written: % x", got)
		}
	}
}

// write and edit replace a file through a rename: its mode stays, a link
// still points at it, and nothing is left beside it.
func TestWriteAndEditReplaceAtomically(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	dir := filepath.Join(home, "dir")
	path := filepath.Join(dir, "script.sh")
	writeTestFile(t, path, []byte("echo old\n"))
	if err := os.Chmod(path, 0o750); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(home, "link.sh")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	// A process holding the old file keeps reading the old content.
	held, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	mustRun[*protocol.WriteResult](t, e, &protocol.WriteArgs{Path: link, Cwd: home, Content: "echo new\n"})
	mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: link, Cwd: home, OldString: "new", NewString: "newer"})
	if got := readTestFile(t, path); string(got) != "echo newer\n" {
		t.Fatalf("content: %q", got)
	}
	if old, _ := io.ReadAll(held); string(old) != "echo old\n" {
		t.Fatalf("the old file was written in place: %q", old)
	}
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the link was replaced: %v %v", info.Mode(), err)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o750 {
		t.Fatalf("mode: %v", info.Mode())
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("left files behind: %v", entries)
	}
}

func TestEditKeepsEncodingBOMAndLineEndings(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{codePage: cp1251{}})
	crlf := filepath.Join(home, "crlf.txt")
	writeTestFile(t, crlf, append([]byte{0xEF, 0xBB, 0xBF}, "first\r\nsecond line\r\nthird\r\n"...))
	edit := mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: "crlf.txt", Cwd: home, OldString: "second line\nthird", NewString: "2nd\nline\nthird"})
	if edit.Replacements != 1 {
		t.Fatalf("edit: %+v", edit)
	}
	if got := readTestFile(t, crlf); string(got) != "\xEF\xBB\xBFfirst\r\n2nd\r\nline\r\nthird\r\n" {
		t.Fatalf("crlf: %q", got)
	}

	utf16 := filepath.Join(home, "utf16.txt")
	data := []byte{0xFF, 0xFE}
	for _, r := range "Привет, мир\r\n" {
		data = append(data, byte(r), byte(r>>8))
	}
	writeTestFile(t, utf16, data)
	mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: utf16, Cwd: home, OldString: "мир", NewString: "дом"})
	want := []byte{0xFF, 0xFE}
	for _, r := range "Привет, дом\r\n" {
		want = append(want, byte(r), byte(r>>8))
	}
	if got := readTestFile(t, utf16); !bytes.Equal(got, want) {
		t.Fatalf("utf-16: % x", got)
	}

	ansi := filepath.Join(home, "ansi.txt")
	encoded, _ := cp1251{}.Encode("Договор №\r\n")
	if encoded != nil {
		t.Fatal("№ is outside the test code page")
	}
	encoded, _ = cp1251{}.Encode("Договор 12\r\nсумма\r\n")
	writeTestFile(t, ansi, encoded)
	mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: ansi, Cwd: home, OldString: "сумма", NewString: "итог"})
	wantBytes, _ := cp1251{}.Encode("Договор 12\r\nитог\r\n")
	if got := readTestFile(t, ansi); !bytes.Equal(got, wantBytes) {
		t.Fatalf("ansi: % x", got)
	}
	wantCode(t, e, &protocol.EditArgs{Path: ansi, Cwd: home, OldString: "итог", NewString: "∑"}, protocol.CodeComputerTextUnencodable)
	if got := readTestFile(t, ansi); !bytes.Equal(got, wantBytes) {
		t.Fatal("a refused edit wrote the file")
	}
}

func TestEditMatchRules(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	path := filepath.Join(home, "a.txt")
	writeTestFile(t, path, []byte("x = 1\nx = 1\ny = 2\n"))
	os.Chmod(path, 0o640)
	wantCode(t, e, &protocol.EditArgs{Path: path, Cwd: home, OldString: "x = 1", NewString: "x = 3"}, protocol.CodeComputerEditAmbiguous)
	wantCode(t, e, &protocol.EditArgs{Path: path, Cwd: home, OldString: "z = 9", NewString: "z = 3"}, protocol.CodeComputerEditNoMatch)
	edit := mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: path, Cwd: home, OldString: "x = 1", NewString: "x = 3", ReplaceAll: true})
	if edit.Replacements != 2 || string(readTestFile(t, path)) != "x = 3\nx = 3\ny = 2\n" {
		t.Fatalf("replace all: %+v %q", edit, readTestFile(t, path))
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode changed: %v", info.Mode())
	}
	// Bytes that are not UTF-8 stay as they were around an edit.
	raw := filepath.Join(home, "raw.txt")
	writeTestFile(t, raw, []byte("caf\xe9 \xff\nkey=old\n"))
	mustRun[*protocol.EditResult](t, e, &protocol.EditArgs{Path: raw, Cwd: home, OldString: "key=old", NewString: "key=new"})
	if got := readTestFile(t, raw); string(got) != "caf\xe9 \xff\nkey=new\n" {
		t.Fatalf("raw: %q", got)
	}
	writeTestFile(t, filepath.Join(home, "bin"), []byte("a\x00b"))
	wantCode(t, e, &protocol.EditArgs{Path: "bin", Cwd: home, OldString: "a", NewString: "b"}, protocol.CodeComputerFileBinary)
	wantCode(t, e, &protocol.EditArgs{Path: "missing", Cwd: home, OldString: "a", NewString: "b"}, protocol.CodeComputerPathNotFound)
}

func TestStatAndListDirs(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{hidden: func(info os.FileInfo) bool { return info.Name() == "System Volume Information" }})
	for _, dir := range []string{"Zeta", "alpha", "Beta", ".git", ".hidden", "System Volume Information"} {
		os.MkdirAll(filepath.Join(home, "root", dir), 0o755)
	}
	writeTestFile(t, filepath.Join(home, "root", "file.txt"), []byte("12345"))
	os.Symlink(filepath.Join(home, "root", "alpha"), filepath.Join(home, "root", "link"))
	list := mustRun[*protocol.ListDirsResult](t, e, &protocol.ListDirsArgs{Path: "~/root"})
	if strings.Join(list.Dirs, ",") != "alpha,Beta,link,Zeta" || list.Truncated || *list.Parent != home {
		t.Fatalf("list: %+v", list)
	}
	list = mustRun[*protocol.ListDirsResult](t, e, &protocol.ListDirsArgs{Path: "/"})
	if list.Parent != nil || list.Path != "/" {
		t.Fatalf("root: %+v", list)
	}
	limited, code := e.listDirs(&protocol.ListDirsArgs{Path: filepath.Join(home, "root")}, 2)
	if code != "" || len(limited.(*protocol.ListDirsResult).Dirs) != 2 || !limited.(*protocol.ListDirsResult).Truncated {
		t.Fatalf("bounded: %+v %s", limited, code)
	}
	wantCode(t, e, &protocol.ListDirsArgs{Path: "~/root/file.txt"}, protocol.CodeComputerNotADirectory)
	wantCode(t, e, &protocol.ListDirsArgs{Path: "~/nope"}, protocol.CodeComputerPathNotFound)

	stat := mustRun[*protocol.StatResult](t, e, &protocol.StatArgs{Path: "root/file.txt"})
	if !stat.Exists || *stat.Kind != protocol.StatFile || *stat.Size != 5 || *stat.Path != filepath.Join(home, "root", "file.txt") {
		t.Fatalf("stat file: %+v", stat)
	}
	for _, missing := range []string{"~/nope", "~/root/file.txt/below"} {
		if stat := mustRun[*protocol.StatResult](t, e, &protocol.StatArgs{Path: missing}); stat.Exists {
			t.Fatalf("stat %s: %+v", missing, stat)
		}
	}
}

func TestRecentDirsRememberOpsCwdMostRecentFirst(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	a, b := filepath.Join(home, "a"), filepath.Join(home, "b")
	os.MkdirAll(a, 0o755)
	os.MkdirAll(b, 0o755)
	for _, cwd := range []string{a, b, a, "~/missing"} {
		run(t, e, &protocol.GlobArgs{Pattern: "*", Cwd: cwd})
	}
	recent := mustRun[*protocol.OpRecentDirsResult](t, e, &protocol.RecentDirsArgs{})
	if recent.Home != home || strings.Join(recent.Dirs, ",") != a+","+b {
		t.Fatalf("recent: %+v", recent)
	}
	// Kept across restarts in the state directory.
	again := New(Options{Home: home, RecentFile: e.recent.path, System: e.sys})
	defer again.Close()
	if got := again.recent.list("linux", 20); strings.Join(got, ",") != a+","+b {
		t.Fatalf("reloaded: %v", got)
	}
	os.RemoveAll(a)
	if got := again.recent.list("linux", 20); strings.Join(got, ",") != b {
		t.Fatalf("after removal: %v", got)
	}
}
