//go:build windows

package ops

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type nativeSystem struct{}

// Native is the system the client runs on.
func Native() System { return nativeSystem{} }

func (nativeSystem) GOOS() string { return "windows" }

// DetectShell prefers pwsh on PATH, else Windows PowerShell 5.1.
func (nativeSystem) DetectShell() Shell {
	sh := selectWindowsShell(exec.LookPath, os.Getenv("SystemRoot"))
	sh.Version = powerShellVersion(sh.Path)
	return sh
}

var shellVersionPattern = regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,63}$`)

// powerShellVersion asks PowerShell for its version; nil when it cannot tell.
func powerShellVersion(path string) *string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	args := append(append([]string{}, powerShellFlags...), "-Command", "$PSVersionTable.PSVersion.ToString()")
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	version := strings.TrimSpace(string(out))
	if !shellVersionPattern.MatchString(version) {
		return nil
	}
	return &version
}

// ShellCommand runs command through PowerShell: from -EncodedCommand, or
// from a temporary script file when it is too long for a command line.
func (nativeSystem) ShellCommand(sh Shell, command, _ string) (*exec.Cmd, func(), error) {
	args, script := powerShellInvocation(command)
	cleanup := func() {}
	if script != nil {
		f, err := os.CreateTemp("", "aiqsa-connect-*.ps1")
		if err != nil {
			return nil, nil, err
		}
		name := f.Name()
		_, err = f.Write(script)
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			os.Remove(name)
			return nil, nil, err
		}
		args = append(args, name)
		cleanup = func() { os.Remove(name) }
	}
	return exec.Command(sh.Path, args...), cleanup, nil
}

// Start starts cmd suspended and without a console window, puts it into a
// job object that kills its processes when closed, and resumes it.
func (nativeSystem) Start(cmd *exec.Cmd) (ProcessTree, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_SUSPENDED,
		HideWindow:    true,
	}
	return startInJob(winJobs{},
		func() (int, error) {
			if err := cmd.Start(); err != nil {
				return 0, err
			}
			return cmd.Process.Pid, nil
		},
		func() {
			cmd.Process.Kill()
			cmd.Wait()
		})
}

type winJobs struct{}

func (winJobs) CreateJob() (uintptr, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return uintptr(job), nil
}

func (winJobs) AssignAndResume(job uintptr, pid int) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	err = windows.AssignProcessToJobObject(windows.Handle(job), process)
	windows.CloseHandle(process)
	if err != nil {
		return err
	}
	return resumeThreads(uint32(pid))
}

// resumeThreads resumes the threads of a process started suspended.
func resumeThreads(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	resumed := 0
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(thread)
		windows.CloseHandle(thread)
		if err != nil {
			return err
		}
		resumed++
	}
	if resumed == 0 {
		return fmt.Errorf("no thread to resume")
	}
	return nil
}

func (winJobs) Terminate(job uintptr) error {
	return windows.TerminateJobObject(windows.Handle(job), 1)
}
func (winJobs) Close(job uintptr) error { return windows.CloseHandle(windows.Handle(job)) }

var (
	kernel32                = windows.NewLazySystemDLL("kernel32.dll")
	procGetOEMCP            = kernel32.NewProc("GetOEMCP")
	procWideCharToMultiByte = kernel32.NewProc("WideCharToMultiByte")
	procReplaceFileW        = kernel32.NewProc("ReplaceFileW")
)

const (
	mbErrInvalidChars = 0x8
	wcNoBestFitChars  = 0x400
)

// OutputFallback decodes console output from the OEM code page (cp866 on
// Russian Windows).
func (nativeSystem) OutputFallback(data []byte) string {
	cp, _, _ := procGetOEMCP.Call()
	if text, ok := decodeCodePage(uint32(cp), data, 0); ok {
		return text
	}
	return replacementFallback(data)
}

var (
	ansiOnce sync.Once
	ansi     CodePage
)

// TextCodePage is the ANSI code page (cp1251 on Russian Windows); nil when
// it is UTF-8 already.
func (nativeSystem) TextCodePage() CodePage {
	ansiOnce.Do(func() {
		if cp := windows.GetACP(); cp != 65001 {
			ansi = winCodePage(cp)
		}
	})
	return ansi
}

type winCodePage uint32

func (c winCodePage) Name() string { return codePageName(uint32(c)) }

func (c winCodePage) Decode(data []byte) (string, bool) {
	return decodeCodePage(uint32(c), data, mbErrInvalidChars)
}

func (c winCodePage) Encode(text string) ([]byte, bool) {
	if text == "" {
		return []byte{}, true
	}
	units := utf16.Encode([]rune(text))
	var usedDefault int32
	call := func(out []byte) int {
		var outPtr uintptr
		if len(out) > 0 {
			outPtr = uintptr(unsafe.Pointer(&out[0]))
		}
		n, _, _ := procWideCharToMultiByte.Call(uintptr(c), wcNoBestFitChars,
			uintptr(unsafe.Pointer(&units[0])), uintptr(len(units)), outPtr, uintptr(len(out)), 0,
			uintptr(unsafe.Pointer(&usedDefault)))
		return int(n)
	}
	size := call(nil)
	if size <= 0 {
		return nil, false
	}
	out := make([]byte, size)
	if call(out) != size || usedDefault != 0 {
		return nil, false
	}
	return out, true
}

func decodeCodePage(cp uint32, data []byte, flags uint32) (string, bool) {
	if len(data) == 0 {
		return "", true
	}
	n, err := windows.MultiByteToWideChar(cp, flags, &data[0], int32(len(data)), nil, 0)
	if err != nil || n <= 0 {
		return "", false
	}
	buf := make([]uint16, n)
	if _, err := windows.MultiByteToWideChar(cp, flags, &data[0], int32(len(data)), &buf[0], n); err != nil {
		return "", false
	}
	return string(utf16.Decode(buf)), true
}

// Hidden is the hidden or system attribute.
func (nativeSystem) Hidden(info fs.FileInfo) bool {
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return ok && data.FileAttributes&(windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM) != 0
}

// OSVersion is "Windows 11 23H2 (10.0.22631)".
func (nativeSystem) OSVersion() string {
	v := windows.RtlGetVersion()
	release := ""
	if key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE); err == nil {
		release, _, _ = key.GetStringValue("DisplayVersion")
		key.Close()
	}
	return windowsVersionName(v.MajorVersion, v.MinorVersion, v.BuildNumber, release)
}

func isNotDirError(err error) bool {
	return errors.Is(err, windows.ERROR_DIRECTORY) || errors.Is(err, syscall.ENOTDIR)
}

func isIsDirError(err error) bool { return errors.Is(err, syscall.EISDIR) }

// isNoSpaceError is a full disk, a disk quota or a file too large for the
// volume.
func isNoSpaceError(err error) bool {
	for _, code := range []syscall.Errno{windows.ERROR_DISK_FULL, windows.ERROR_HANDLE_DISK_FULL,
		windows.ERROR_DISK_QUOTA_EXCEEDED, windows.ERROR_FILE_TOO_LARGE, syscall.ENOSPC, syscall.EFBIG} {
		if errors.Is(err, code) {
			return true
		}
	}
	return false
}

// WritesInPlace is false: ReplaceFileW keeps what is attached to the file
// (Replace).
func (nativeSystem) WritesInPlace() bool { return false }

// PrepareReplacement gives a replacement file the hidden, system, archive
// and not-indexed attributes of the file it replaces; ReplaceFileW keeps
// the rest (Replace). Read-only is not copied: a read-only file cannot be
// replaced, and ReplaceFileW refuses it.
func (nativeSystem) PrepareReplacement(tmp *os.File, _ string, info fs.FileInfo) error {
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return nil
	}
	const kept = windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM | windows.FILE_ATTRIBUTE_ARCHIVE | windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
	attributes := data.FileAttributes & kept
	if attributes == 0 {
		return nil
	}
	name, err := windows.UTF16PtrFromString(tmp.Name())
	if err != nil {
		return err
	}
	return windows.SetFileAttributes(name, attributes)
}

// Replace moves tmp over path with ReplaceFileW, which keeps the replaced
// file's ACL, owner, attributes, creation time and alternate data streams
// (replaceWindowsFile).
func (nativeSystem) Replace(tmp, path string) error {
	return replaceWindowsFile(winFileAPI{}, tmp, path)
}

type winFileAPI struct{}

// ReplaceFile calls ReplaceFileW without flags: errors merging the ACL or
// attributes are failures, not ignored.
func (winFileAPI) ReplaceFile(replaced, replacement, backup string) error {
	replacedPtr, err := windows.UTF16PtrFromString(replaced)
	if err != nil {
		return err
	}
	replacementPtr, err := windows.UTF16PtrFromString(replacement)
	if err != nil {
		return err
	}
	backupPtr, err := windows.UTF16PtrFromString(backup)
	if err != nil {
		return err
	}
	ok, _, callErr := procReplaceFileW.Call(uintptr(unsafe.Pointer(replacedPtr)), uintptr(unsafe.Pointer(replacementPtr)),
		uintptr(unsafe.Pointer(backupPtr)), 0, 0, 0)
	if ok != 0 {
		return nil
	}
	if errno, isErrno := callErr.(syscall.Errno); isErrno && errno != 0 {
		return &os.LinkError{Op: "replace", Old: replacement, New: replaced, Err: errno}
	}
	return &os.LinkError{Op: "replace", Old: replacement, New: replaced, Err: syscall.EINVAL}
}

func (winFileAPI) Rename(from, to string) error { return os.Rename(from, to) }
func (winFileAPI) Remove(path string) error     { return os.Remove(path) }
func (winFileAPI) Exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
