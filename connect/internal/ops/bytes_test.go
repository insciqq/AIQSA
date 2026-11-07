package ops

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func decodeBytesChunk(t *testing.T, r *protocol.ReadBytesResult) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(r.Data)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestReadBytesChunksAFile(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	content := make([]byte, 1000)
	for i := range content {
		content[i] = byte(i * 7)
	}
	content[10] = 0
	path := filepath.Join(home, "docs", "scan.pdf")
	writeTestFile(t, path, content)
	modified := time.UnixMilli(1_762_500_000_123)
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}

	var got []byte
	for offset := int64(0); ; offset += 300 {
		r := mustRun[*protocol.ReadBytesResult](t, e, &protocol.ReadBytesArgs{Path: "docs/scan.pdf", Cwd: "~", Offset: offset, Length: 300})
		if r.Size != 1000 || r.ModifiedMs != 1_762_500_000_123 {
			t.Fatalf("chunk at %d: size %d, modified %d", offset, r.Size, r.ModifiedMs)
		}
		got = append(got, decodeBytesChunk(t, r)...)
		if r.EOF != (offset+300 >= 1000) {
			t.Fatalf("chunk at %d: eof %v", offset, r.EOF)
		}
		if r.EOF {
			break
		}
	}
	if !bytes.Equal(got, content) {
		t.Fatal("the chunks differ from the file")
	}

	// At and past the end: an empty chunk with eof.
	for _, offset := range []int64{1000, 5000} {
		r := mustRun[*protocol.ReadBytesResult](t, e, &protocol.ReadBytesArgs{Path: path, Cwd: "/", Offset: offset, Length: 10})
		if r.Data != "" || !r.EOF || r.Size != 1000 {
			t.Fatalf("past the end at %d: %+v", offset, r)
		}
	}
	writeTestFile(t, filepath.Join(home, "empty"), nil)
	if r := mustRun[*protocol.ReadBytesResult](t, e, &protocol.ReadBytesArgs{Path: "empty", Cwd: home, Offset: 0, Length: 10}); r.Data != "" || !r.EOF || r.Size != 0 {
		t.Fatalf("empty file: %+v", r)
	}
	// Read-only: not even a recent folder is recorded.
	if dirs := e.recent.list(e.goos, protocol.MaxRecentDirs); len(dirs) != 0 {
		t.Fatalf("recent folders: %v", dirs)
	}
}

func TestReadBytesRefusals(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	args := func(path string) *protocol.ReadBytesArgs {
		return &protocol.ReadBytesArgs{Path: path, Cwd: home, Offset: 0, Length: 10}
	}
	wantCode(t, e, args("missing"), protocol.CodeComputerPathNotFound)
	wantCode(t, e, args("."), protocol.CodeComputerIsADirectory)
	writeTestFile(t, filepath.Join(home, "file"), []byte("x"))
	wantCode(t, e, args("file/inside"), protocol.CodeComputerNotADirectory)
	previous := maxTransferBytes
	maxTransferBytes = 16
	t.Cleanup(func() { maxTransferBytes = previous })
	writeTestFile(t, filepath.Join(home, "big"), bytes.Repeat([]byte{0xFF}, 17))
	wantCode(t, e, args("big"), protocol.CodeComputerFileTooLarge)
	if os.Getuid() != 0 {
		writeTestFile(t, filepath.Join(home, "secret"), []byte("x"))
		os.Chmod(filepath.Join(home, "secret"), 0)
		wantCode(t, e, args("secret"), protocol.CodeComputerPermissionDenied)
	}
}

// A full chunk always fits the contract's reply limit unshrunk, and a reply
// that would not fit fails rather than cut the base64.
func TestReadBytesFullChunkFitsReply(t *testing.T) {
	e, home := newTestExecutor(t, testSystem{})
	content := bytes.Repeat([]byte{0xFB, 0xFF, 0xBF}, protocol.MaxBytesChunk)
	writeTestFile(t, filepath.Join(home, "large.bin"), content)
	r := mustRun[*protocol.ReadBytesResult](t, e, &protocol.ReadBytesArgs{Path: "large.bin", Cwd: home, Offset: 1, Length: protocol.MaxBytesChunk})
	want := base64.StdEncoding.EncodeToString(content[1 : 1+protocol.MaxBytesChunk])
	if r.Data != want || len(r.Data) != protocol.MaxBytesChunkBase64 || r.EOF {
		t.Fatalf("full chunk: %d base64 characters, eof %v", len(r.Data), r.EOF)
	}
	event, err := fitReply("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", r, protocol.MaxReplyBytes)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > protocol.MaxReplyBytes {
		t.Fatalf("reply of %d bytes", len(encoded))
	}
	decoded, err := protocol.DecodeDeviceEventV2(encoded)
	if err != nil {
		t.Fatal(err)
	}
	chunk, err := protocol.DecodeOpResult(protocol.OpReadBytes, decoded.(*protocol.OpReplyEvent).Result)
	if err != nil || chunk.(*protocol.ReadBytesResult).Data != want {
		t.Fatalf("the reply changed the chunk: %v", err)
	}
	if _, err := fitReply("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", r, 200_000); err == nil {
		t.Fatal("a chunk too large for the reply was shrunk instead of failing")
	}
	if r.Data != want {
		t.Fatal("fitReply cut the chunk")
	}
}
