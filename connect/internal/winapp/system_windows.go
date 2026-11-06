//go:build windows

package winapp

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// SingleInstanceMutex keeps one tray per user session (spec D-12).
const SingleInstanceMutex = `Local\AIQSA-Connect`

// trayClassName is the tray window's class: other instances find the
// running tray by it to open AIQSA or stop it.
const trayClassName = "AIQSAConnectTray"

// WindowsRegistry is HKEY_CURRENT_USER.
type WindowsRegistry struct{}

func (WindowsRegistry) create(key string) (registry.Key, error) {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, key, registry.SET_VALUE)
	return k, err
}

func (r WindowsRegistry) SetString(key, name, value string) error {
	k, err := r.create(key)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, value)
}

func (r WindowsRegistry) SetDWord(key, name string, value uint32) error {
	k, err := r.create(key)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetDWordValue(name, value)
}

func (WindowsRegistry) String(key, name string) (string, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, key, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	defer k.Close()
	value, _, err := k.GetStringValue(name)
	if errors.Is(err, registry.ErrNotExist) {
		return "", ErrNotFound
	}
	return value, err
}

func (WindowsRegistry) DeleteValue(key, name string) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, key, registry.SET_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func (WindowsRegistry) DeleteKey(key string) error {
	if err := registry.DeleteKey(registry.CURRENT_USER, key); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

// WindowsSystem starts and stops the program and opens the browser.
type WindowsSystem struct{}

func (WindowsSystem) Running() bool { return findTray() != 0 }

// StopRunning closes the running tray (it quits as from its menu) and
// waits for its process; one that does not exit in time is ended.
func (WindowsSystem) StopRunning(ctx context.Context) error {
	hwnd := findTray()
	if hwnd == 0 {
		return nil
	}
	var pid uint32
	if _, err := windows.GetWindowThreadProcessId(windows.HWND(hwnd), &pid); err != nil || pid == 0 {
		return fmt.Errorf("cannot find the running AIQSA Connect: %w", err)
	}
	if pid == windows.GetCurrentProcessId() {
		return nil
	}
	process, openErr := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, pid)
	if openErr == nil {
		defer windows.CloseHandle(process)
	}
	postMessage(hwnd, wmClose, 0, 0)
	wait := StopTimeout
	if deadline, ok := ctx.Deadline(); ok {
		wait = min(wait, time.Until(deadline))
	}
	if openErr != nil {
		// Without a process handle, wait for the window to go.
		for end := time.Now().Add(wait); findTray() != 0; time.Sleep(100 * time.Millisecond) {
			if time.Now().After(end) {
				return errors.New("the running AIQSA Connect did not quit")
			}
		}
		return nil
	}
	event, err := windows.WaitForSingleObject(process, uint32(max(wait, 0)/time.Millisecond))
	if err == nil && event == windows.WAIT_OBJECT_0 {
		return nil
	}
	if err := windows.TerminateProcess(process, 1); err != nil {
		return fmt.Errorf("the running AIQSA Connect did not quit: %w", err)
	}
	windows.WaitForSingleObject(process, 5000)
	return nil
}

// Start starts exe detached, in the user's profile folder, so no running
// copy holds the program folder as its current folder.
func (WindowsSystem) Start(exe string, args ...string) error {
	cmd := exec.Command(exe, args...)
	if home, err := os.UserHomeDir(); err == nil && filepath.IsAbs(home) {
		cmd.Dir = home
	} else {
		cmd.Dir = os.TempDir()
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func (WindowsSystem) OpenURL(link string) error { return openURL(link) }

// openURL opens an http(s) address in the default browser. Other schemes
// are refused: ShellExecute would start whatever program they name.
func openURL(link string) error {
	u, err := url.Parse(link)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return errors.New("not a web address")
	}
	return windows.ShellExecute(0, utf16Ptr("open"), utf16Ptr(u.String()), nil, nil, windows.SW_SHOWNORMAL)
}

// WindowsDialogs are message boxes.
type WindowsDialogs struct{}

func messageBox(title, text string, flags uint32) int32 {
	r, _ := windows.MessageBox(0, utf16Ptr(text), utf16Ptr(title), flags|windows.MB_SETFOREGROUND)
	return r
}

func (WindowsDialogs) Confirm(title, text string) bool {
	return messageBox(title, text, windows.MB_OKCANCEL|windows.MB_ICONQUESTION|windows.MB_DEFBUTTON1) == idOK
}

func (WindowsDialogs) Inform(title, text string) {
	messageBox(title, text, windows.MB_OK|windows.MB_ICONINFORMATION)
}

func (WindowsDialogs) Warn(title, text string) {
	messageBox(title, text, windows.MB_OK|windows.MB_ICONWARNING)
}

// AttachParentConsole lets this windowsgui program print to the console
// it was started from (spec D-12). Output already redirected to a file or
// pipe is kept. Without a parent console nothing changes.
func AttachParentConsole() {
	outValid := validStdHandle(windows.STD_OUTPUT_HANDLE)
	errValid := validStdHandle(windows.STD_ERROR_HANDLE)
	if outValid && errValid {
		return
	}
	if r, _, _ := procAttachConsole.Call(uintptr(attachParentProcess)); r == 0 {
		return
	}
	console, err := windows.CreateFile(utf16Ptr("CONOUT$"), windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return
	}
	if !outValid {
		windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, console)
		os.Stdout = os.NewFile(uintptr(console), "/dev/stdout")
	}
	if !errValid {
		windows.SetStdHandle(windows.STD_ERROR_HANDLE, console)
		os.Stderr = os.NewFile(uintptr(console), "/dev/stderr")
	}
}

func validStdHandle(which uint32) bool {
	h, err := windows.GetStdHandle(which)
	return err == nil && h != 0 && h != windows.InvalidHandle
}

// AcquireSingleInstance waits up to wait for the tray's named mutex and
// reports whether this process now owns it; it is held until the process
// exits. It must be called on the thread that lives as long as the process
// (the tray's locked thread): Windows ties a mutex's ownership to a thread.
// The wait lets an updated tray start while the old one is exiting.
func AcquireSingleInstance(wait time.Duration) (bool, error) {
	handle, err := windows.CreateMutex(nil, false, utf16Ptr(SingleInstanceMutex))
	if handle == 0 {
		return false, err
	}
	event, err := windows.WaitForSingleObject(handle, uint32(wait/time.Millisecond))
	if err != nil {
		windows.CloseHandle(handle)
		return false, err
	}
	if event == windows.WAIT_OBJECT_0 || event == windows.WAIT_ABANDONED {
		return true, nil
	}
	windows.CloseHandle(handle)
	return false, nil
}

// smallIconSize is the size Windows draws notification-area icons at.
func smallIconSize() (int32, int32) {
	cx, _, _ := procGetSystemMetrics.Call(smCxSmIcon)
	cy, _, _ := procGetSystemMetrics.Call(smCySmIcon)
	if cx == 0 || cy == 0 {
		return 16, 16
	}
	return int32(cx), int32(cy)
}

// loadIcon loads an icon resource by its id at the small icon size,
// falling back to the standard application icon.
func loadIcon(id uint16) uintptr {
	cx, cy := smallIconSize()
	if icon, _, _ := procLoadImageW.Call(moduleHandle(), uintptr(id), imageIcon, uintptr(cx), uintptr(cy), 0); icon != 0 {
		return icon
	}
	icon, _, _ := procLoadImageW.Call(0, idiApp, imageIcon, 0, 0, lrShared)
	return icon
}
