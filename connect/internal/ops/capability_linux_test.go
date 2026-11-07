//go:build linux

package ops

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// A file with Linux file capabilities that only an in-place write could
// change is refused before anything changes: the kernel would remove its
// capabilities on the write and the process could not set them again.
func TestWriteInPlaceRefusesAFileWithCapabilities(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can copy the capability, so the replacement keeps it")
	}
	e, home := newTestExecutor(t, testSystem{inPlace: true})
	path := filepath.Join(home, "tool")
	old := []byte("old content\n")
	writeTestFile(t, path, old)
	if err := exec.Command("unshare", "--user", "--map-root-user", "setcap", "cap_net_bind_service=ep", path).Run(); err != nil {
		t.Skipf("cannot set a file capability here: %v", err)
	}
	if !hasFileCapabilities(path) {
		t.Skip("the file system kept no capability")
	}
	wantCode(t, e, &protocol.WriteArgs{Path: path, Cwd: home, Content: "new content\n"}, protocol.CodeComputerPermissionDenied)
	wantCode(t, e, &protocol.EditArgs{Path: path, Cwd: home, OldString: "old", NewString: "new"}, protocol.CodeComputerPermissionDenied)
	if got := readTestFile(t, path); !bytes.Equal(got, old) || !hasFileCapabilities(path) {
		t.Fatalf("a refused write changed the file: %q, capabilities kept: %v", got, hasFileCapabilities(path))
	}
}
