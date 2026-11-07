package ops

import (
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// The Windows parts the executor decides itself: which PowerShell runs a
// command and how, how a job object holds a process tree, how code pages
// are named and how a file is replaced. The system calls are in system_windows.go; this file
// builds everywhere so its logic is tested on Linux.

// selectWindowsShell prefers PowerShell 7+ (pwsh) on PATH, else Windows
// PowerShell 5.1 from PATH or its fixed place under systemRoot.
func selectWindowsShell(lookPath func(string) (string, error), systemRoot string) Shell {
	if path, err := lookPath("pwsh.exe"); err == nil {
		return Shell{Kind: protocol.ShellPwsh, Name: "PowerShell", Path: path}
	}
	path, err := lookPath("powershell.exe")
	if err != nil {
		if systemRoot == "" {
			systemRoot = `C:\Windows`
		}
		path = systemRoot + `\System32\WindowsPowerShell\v1.0\powershell.exe`
	}
	return Shell{Kind: protocol.ShellPowerShell, Name: "Windows PowerShell", Path: path}
}

// powerShellFlags start PowerShell without a logo, profile or prompts, and
// with scripts allowed for this process only.
var powerShellFlags = []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"}

// powerShellPrelude makes the command's output UTF-8, whatever the
// console's code page, and silences progress bars.
const powerShellPrelude = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" +
	"$OutputEncoding = [System.Text.Encoding]::UTF8\n" +
	"$ProgressPreference = 'SilentlyContinue'\n"

// maxEncodedCommandChars keeps a command line well under Windows' 32767
// characters; a longer command runs from a script file.
const maxEncodedCommandChars = 30_000

// powerShellInvocation returns the arguments that run command. When the
// command is too long for the command line, script is the content of a
// .ps1 file (UTF-8 with a BOM, which Windows PowerShell needs) whose path
// goes after the returned arguments.
func powerShellInvocation(command string) (args []string, script []byte) {
	source := powerShellPrelude + command
	units := utf16.Encode([]rune(source))
	raw := make([]byte, 2*len(units))
	for i, unit := range units {
		raw[2*i], raw[2*i+1] = byte(unit), byte(unit>>8)
	}
	if encoded := base64.StdEncoding.EncodeToString(raw); len(encoded) <= maxEncodedCommandChars {
		return append(append([]string{}, powerShellFlags...), "-EncodedCommand", encoded), nil
	}
	return append(append([]string{}, powerShellFlags...), "-File"), append(append([]byte{}, bomUTF8...), source...)
}

// jobAPI is what a job object tree needs from Windows.
type jobAPI interface {
	// CreateJob creates a job object that kills its processes when its
	// last handle closes.
	CreateJob() (uintptr, error)
	// AssignAndResume puts the suspended process pid into job, then lets
	// its threads run, so everything it starts is in the job too.
	AssignAndResume(job uintptr, pid int) error
	// Terminate ends every process of the job.
	Terminate(job uintptr) error
	// Close closes the job's handle.
	Close(job uintptr) error
}

// jobTree is a process tree held by a job object.
type jobTree struct {
	api  jobAPI
	job  uintptr
	once sync.Once
}

// startInJob starts a process suspended with start, puts it into a new job
// and resumes it. On failure the process is killed with kill and nothing
// stays behind.
func startInJob(api jobAPI, start func() (pid int, err error), kill func()) (*jobTree, error) {
	job, err := api.CreateJob()
	if err != nil {
		return nil, err
	}
	pid, err := start()
	if err != nil {
		api.Close(job)
		return nil, err
	}
	if err := api.AssignAndResume(job, pid); err != nil {
		kill()
		api.Close(job)
		return nil, err
	}
	return &jobTree{api: api, job: job}, nil
}

// Terminate ends the job at once: Windows has no polite stop for a tree.
func (t *jobTree) Terminate() { t.api.Terminate(t.job) }

func (t *jobTree) Kill() { t.api.Terminate(t.job) }

// Release closes the job, which kills anything still in it.
func (t *jobTree) Release() { t.once.Do(func() { t.api.Close(t.job) }) }

// codePageName names a Windows code page the way read reports encodings.
func codePageName(cp uint32) string {
	switch {
	case cp == 874 || cp >= 1250 && cp <= 1258:
		return "windows-" + strconv.FormatUint(uint64(cp), 10)
	case cp == 65001:
		return "utf-8"
	}
	return "cp" + strconv.FormatUint(uint64(cp), 10)
}

// windowsVersionName describes Windows 10 and 11 from the kernel's version
// numbers and the release name (for example "23H2"), when known.
func windowsVersionName(major, minor, build uint32, release string) string {
	name := "Windows"
	switch {
	case major == 10 && build >= 22000:
		name = "Windows 11"
	case major == 10:
		name = "Windows 10"
	}
	if release != "" {
		name += " " + release
	}
	return name + " (" + strconv.FormatUint(uint64(major), 10) + "." + strconv.FormatUint(uint64(minor), 10) + "." +
		strconv.FormatUint(uint64(build), 10) + ")"
}

// Windows error codes that mean a volume cannot replace files with
// ReplaceFileW (some network shares and file systems answer so).
var replaceUnsupportedErrors = []syscall.Errno{
	1,   // ERROR_INVALID_FUNCTION
	50,  // ERROR_NOT_SUPPORTED
	87,  // ERROR_INVALID_PARAMETER
	120, // ERROR_CALL_NOT_IMPLEMENTED
}

// winFiles is what replaceWindowsFile needs from Windows.
type winFiles interface {
	// ReplaceFile is ReplaceFileW: replacement takes the place, name and
	// ACL, owner, attributes, creation time and streams of replaced, which
	// is moved to backup.
	ReplaceFile(replaced, replacement, backup string) error
	Rename(from, to string) error
	Remove(path string) error
	Exists(path string) bool
}

// replaceWindowsFile moves the replacement tmp over path with ReplaceFileW.
// The replaced file is moved to a backup beside tmp, not dropped, so a
// failure in the middle (ERROR_UNABLE_TO_MOVE_REPLACEMENT_2) can put it
// back; the backup is removed once the replacement is in place. A volume
// that cannot replace files answers errWriteInPlace, but only while the
// original is still at path. The caller removes tmp on an error.
func replaceWindowsFile(files winFiles, tmp, path string) error {
	backup := tmp + ".old"
	err := files.ReplaceFile(winLongPath(path), winLongPath(tmp), winLongPath(backup))
	if err == nil {
		files.Remove(backup)
		return nil
	}
	if files.Exists(backup) {
		if files.Exists(path) {
			// Not a state ReplaceFileW documents; nothing is moved.
			return err
		}
		if files.Rename(backup, path) != nil {
			// The original stays under the backup name, whole.
			return err
		}
	}
	for _, unsupported := range replaceUnsupportedErrors {
		if errors.Is(err, unsupported) && files.Exists(path) {
			return errWriteInPlace
		}
	}
	return err
}

// winLongPath gives an absolute path of 248 characters or more the \\?\
// prefix (\\?\UNC\ for a share), which the os package adds itself but a
// direct call of a Win32 function needs. Other paths stay as they are.
func winLongPath(path string) string {
	if len(path) < 248 || strings.HasPrefix(path, `\\?\`) || strings.Contains(path, "/") {
		return path
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + path[2:]
	}
	if len(path) >= 3 && path[1] == ':' && path[2] == '\\' {
		return `\\?\` + path
	}
	return path
}
