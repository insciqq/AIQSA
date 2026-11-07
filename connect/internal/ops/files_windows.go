//go:build windows

package ops

import (
	"fmt"
	"io/fs"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

// fileID names the file at path by its volume serial number and file
// index, which every name of it shares (a hard link, another case, a short
// 8.3 name); false when it does not exist or cannot be opened, so the
// lock of its case-folded path holds it.
func fileID(path string) (string, bool) {
	name, err := windows.UTF16PtrFromString(winLongPath(path))
	if err != nil {
		return "", false
	}
	// No access rights: only the file's identity is read, and no sharing
	// mode of another handle refuses that.
	h, err := windows.CreateFile(name, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(h)
	return handleID(h)
}

// openFileID is fileID of an open file.
func openFileID(f *os.File) (string, bool) {
	return handleID(windows.Handle(f.Fd()))
}

func handleID(h windows.Handle) (string, bool) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return "", false
	}
	return fmt.Sprintf("id:%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), true
}

// foldPath is how a path keys a lock: in lower case, as Windows volumes
// ignore case.
func foldPath(path string) string { return strings.ToLower(path) }

// canKeepSpecialBits is true: files on Windows have no setuid, setgid or
// sticky bits.
func canKeepSpecialBits(fs.FileInfo) bool { return true }
