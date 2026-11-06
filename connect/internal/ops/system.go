package ops

import (
	"io/fs"
	"os/exec"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// System is what the executor needs from the operating system. Native()
// is the real one for the build's system; tests replace it, so the logic
// around Windows job objects, code pages and shells runs on Linux too.
type System interface {
	// GOOS is the system the paths and results are for: "windows", "darwin" or "linux".
	GOOS() string
	// DetectShell finds the shell the shell op runs. It is called once.
	DetectShell() Shell
	// ShellCommand prepares command for sh in cwd. cleanup removes anything
	// it wrote (a script file) once the process is gone.
	ShellCommand(sh Shell, command, cwd string) (cmd *exec.Cmd, cleanup func(), err error)
	// Start starts cmd as the root of a process tree the client can end
	// as a whole: a process group on macOS and Linux, a job object on Windows.
	Start(cmd *exec.Cmd) (ProcessTree, error)
	// OutputFallback decodes command output that is not valid UTF-8: from
	// the console's OEM code page on Windows, elsewhere with U+FFFD.
	OutputFallback(data []byte) string
	// TextCodePage is the code page of text files that are not valid UTF-8
	// (Windows' ANSI code page); nil when there is none.
	TextCodePage() CodePage
	// Hidden reports whether a directory entry is hidden beyond a leading
	// dot: the hidden or system attribute on Windows.
	Hidden(info fs.FileInfo) bool
	// OSVersion describes the system for device_info, for example "Ubuntu 24.04.1 LTS".
	OSVersion() string
}

// Shell is the shell the shell op runs.
type Shell struct {
	Kind protocol.ShellKind
	// Name is shown to the agent, for example "Windows PowerShell" or "zsh".
	Name string
	// Path is the executable.
	Path string
	// Version is nil when the client cannot tell.
	Version *string
}

// ProcessTree is a started command with everything it started.
type ProcessTree interface {
	// Terminate asks every process of the tree to stop (SIGTERM to the
	// process group; on Windows it ends the job at once).
	Terminate()
	// Kill ends every process of the tree that is still running.
	Kill()
	// Release frees what the tree holds once nothing of it runs.
	Release()
}

// CodePage converts text between a single- or multi-byte code page and UTF-8.
type CodePage interface {
	// Name is the encoding's name, for example "windows-1251".
	Name() string
	// Decode returns the text; false when data is not valid in the code page.
	Decode(data []byte) (string, bool)
	// Encode returns the bytes; false when the text has a character the
	// code page cannot hold.
	Encode(text string) ([]byte, bool)
}
