//go:build windows

package winapp

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// Win32 calls golang.org/x/sys/windows does not wrap. Every call happens on
// the tray's locked OS thread unless noted.
var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procRegisterClassExW       = user32.NewProc("RegisterClassExW")
	procCreateWindowExW        = user32.NewProc("CreateWindowExW")
	procDefWindowProcW         = user32.NewProc("DefWindowProcW")
	procDestroyWindow          = user32.NewProc("DestroyWindow")
	procGetMessageW            = user32.NewProc("GetMessageW")
	procTranslateMessage       = user32.NewProc("TranslateMessage")
	procDispatchMessageW       = user32.NewProc("DispatchMessageW")
	procPostMessageW           = user32.NewProc("PostMessageW") // any thread
	procPostQuitMessage        = user32.NewProc("PostQuitMessage")
	procCreatePopupMenu        = user32.NewProc("CreatePopupMenu")
	procAppendMenuW            = user32.NewProc("AppendMenuW")
	procTrackPopupMenu         = user32.NewProc("TrackPopupMenu")
	procDestroyMenu            = user32.NewProc("DestroyMenu")
	procSetForegroundWindow    = user32.NewProc("SetForegroundWindow")
	procGetCursorPos           = user32.NewProc("GetCursorPos")
	procLoadImageW             = user32.NewProc("LoadImageW")
	procDestroyIcon            = user32.NewProc("DestroyIcon")
	procRegisterWindowMessageW = user32.NewProc("RegisterWindowMessageW")
	procFindWindowW            = user32.NewProc("FindWindowW") // any thread
	procGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	procShellNotifyIconW       = shell32.NewProc("Shell_NotifyIconW")
	procAttachConsole          = kernel32.NewProc("AttachConsole")
	procGetModuleHandleW       = kernel32.NewProc("GetModuleHandleW")
)

const (
	wmNull        = 0x0000
	wmDestroy     = 0x0002
	wmClose       = 0x0010
	wmContextMenu = 0x007B
	wmUser        = 0x0400
	wmApp         = 0x8000

	// Messages of the tray window.
	wmTrayCallback = wmApp + 1
	wmTrayUpdate   = wmApp + 2
	wmTrayNotify   = wmApp + 3
	wmTrayExit     = wmApp + 4

	ninSelect    = wmUser + 0
	ninKeySelect = wmUser + 1

	nimAdd        = 0x0
	nimModify     = 0x1
	nimDelete     = 0x2
	nimSetVersion = 0x4

	nifMessage  = 0x01
	nifIcon     = 0x02
	nifTip      = 0x04
	nifInfo     = 0x10
	nifShowTip  = 0x80
	niifInfo    = 0x01
	niifNoSound = 0x10

	notifyIconVersion4 = 4

	mfString    = 0x0000
	mfGrayed    = 0x0001
	mfSeparator = 0x0800

	tpmRightButton = 0x0002
	tpmBottomAlign = 0x0020
	tpmNoNotify    = 0x0080
	tpmReturnCmd   = 0x0100

	imageIcon   = 1
	lrShared    = 0x8000
	idiApp      = 32512
	smCxSmIcon  = 49
	smCySmIcon  = 50
	wsExToolWin = 0x00000080

	idOK = 1

	attachParentProcess = ^uint32(0)
)

type point struct{ X, Y int32 }

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
	Private uint32
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

func utf16Ptr(s string) *uint16 {
	p, err := windows.UTF16PtrFromString(s)
	if err != nil {
		p, _ = windows.UTF16PtrFromString("")
	}
	return p
}

func postMessage(hwnd uintptr, msg uint32, wparam, lparam uintptr) bool {
	r, _, _ := procPostMessageW.Call(hwnd, uintptr(msg), wparam, lparam)
	return r != 0
}

func shellNotifyIcon(message uint32, data *notifyIconData) bool {
	r, _, _ := procShellNotifyIconW.Call(uintptr(message), uintptr(unsafe.Pointer(data)))
	return r != 0
}

func moduleHandle() uintptr {
	r, _, _ := procGetModuleHandleW.Call(0)
	return r
}

// findTray is the tray window of a running instance, or 0.
func findTray() uintptr {
	r, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(utf16Ptr(trayClassName))), 0)
	return r
}
