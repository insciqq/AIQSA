//go:build windows

package winapp

import (
	"errors"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/insciqq/AIQSA/connect/internal/state"
)

// Icon resource ids in the program's resources (connect/assets/windows):
// the AIQSA icon with a status dot.
const (
	iconResourceConnected    = 11
	iconResourceWaiting      = 12
	iconResourceDisconnected = 13
)

// trayIconID is the uID of the program's only notification icon.
const trayIconID = 1

// Tray is the notification-area icon and its menu, drawn with
// Shell_NotifyIcon on a hidden window (spec O-06, D-12). It implements UI:
// Show, Notify and Exit post to the window and never block; Confirm shows
// a message box.
type Tray struct {
	// Choose receives the menu's commands on the tray's thread; it must
	// not block (Controller.Choose).
	Choose func(MenuID)
	// AppItems gives the installed program's menu lines when the menu
	// opens (Controller.AppItems); nil shows none.
	AppItems func() AppItems
	// Version is the running program's version, in the tooltip and the
	// menu; set it before Run.
	Version string

	hwnd           atomic.Uintptr
	taskbarCreated uint32
	icons          [3]uintptr
	added          bool

	mu      sync.Mutex
	state   state.State
	view    View
	notice  string
	exiting bool
}

// activeTray is the process's tray; the window procedure reaches it here.
var activeTray atomic.Pointer[Tray]

var wndProcCallback = sync.OnceValue(func() uintptr { return windows.NewCallback(trayWndProc) })

// Show updates the icon, tooltip and menu.
func (t *Tray) Show(s state.State) {
	t.mu.Lock()
	t.state, t.view = s, ViewOf(s, AppItems{Version: t.Version})
	t.mu.Unlock()
	postMessage(t.hwnd.Load(), wmTrayUpdate, 0, 0)
}

// Notify shows text in a notification beside the icon; a newer text
// replaces one not shown yet.
func (t *Tray) Notify(text string) {
	t.mu.Lock()
	t.notice = text
	t.mu.Unlock()
	postMessage(t.hwnd.Load(), wmTrayNotify, 0, 0)
}

func (t *Tray) Confirm(title, text string) bool { return WindowsDialogs{}.Confirm(title, text) }

func (t *Tray) Warn(title, text string) { WindowsDialogs{}.Warn(title, text) }

func (t *Tray) OpenURL(link string) error { return openURL(link) }

// Exit removes the icon and ends Run.
func (t *Tray) Exit() {
	t.mu.Lock()
	t.exiting = true
	t.mu.Unlock()
	postMessage(t.hwnd.Load(), wmTrayExit, 0, 0)
}

// Run creates the icon and runs the window's message loop on the calling
// goroutine, locked to its thread, until Exit. ready runs on that thread
// once the window exists (acquire the single-instance mutex there); when
// it returns false, Run returns at once. start runs after the icon is
// added (Controller.Start); when the taskbar is not there yet, notices
// wait until the icon is.
func (t *Tray) Run(ready func() bool, start func()) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if !activeTray.CompareAndSwap(nil, t) {
		return errors.New("the tray runs already")
	}
	defer activeTray.Store(nil)
	if ready != nil && !ready() {
		return nil
	}
	instance := moduleHandle()
	className := utf16Ptr(trayClassName)
	class := wndClassEx{WndProc: wndProcCallback(), Instance: instance, ClassName: className}
	class.Size = uint32(unsafe.Sizeof(class))
	if r, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class))); r == 0 {
		return err
	}
	hwnd, _, err := procCreateWindowExW.Call(wsExToolWin, uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(utf16Ptr(AppName))), 0, 0, 0, 0, 0, 0, 0, instance, 0)
	if hwnd == 0 {
		return err
	}
	t.hwnd.Store(hwnd)
	t.taskbarCreated = registerWindowMessage("TaskbarCreated")
	t.icons = [3]uintptr{
		IconDisconnected: loadIcon(iconResourceDisconnected),
		IconWaiting:      loadIcon(iconResourceWaiting),
		IconConnected:    loadIcon(iconResourceConnected),
	}
	t.mu.Lock()
	if t.view.Status == "" {
		t.state = state.State{Kind: state.Stopped}
		t.view = ViewOf(t.state, AppItems{Version: t.Version})
	}
	t.mu.Unlock()
	// At sign-in the taskbar may not exist yet; TaskbarCreated adds the icon then.
	t.addIcon()
	if start != nil {
		start()
	}
	var m winMsg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	for _, icon := range t.icons {
		if icon != 0 {
			procDestroyIcon.Call(icon)
		}
	}
	return nil
}

func registerWindowMessage(name string) uint32 {
	r, _, _ := procRegisterWindowMessageW.Call(uintptr(unsafe.Pointer(utf16Ptr(name))))
	return uint32(r)
}

func trayWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	t := activeTray.Load()
	if t == nil {
		r, _, _ := procDefWindowProcW.Call(hwnd, msg, wparam, lparam)
		return r
	}
	switch uint32(msg) {
	case wmTrayCallback:
		switch uint32(lparam & 0xffff) {
		case wmContextMenu, ninSelect, ninKeySelect:
			t.showMenu(hwnd)
		}
		return 0
	case wmTrayUpdate:
		t.updateIcon()
		return 0
	case wmTrayNotify:
		t.showNotice()
		return 0
	case wmTrayExit:
		t.deleteIcon()
		procDestroyWindow.Call(hwnd)
		return 0
	case wmClose:
		// Another instance asks this one to quit (install, switch, uninstall).
		t.mu.Lock()
		exiting := t.exiting
		t.mu.Unlock()
		if !exiting && t.Choose != nil {
			t.Choose(MenuQuit)
		}
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	if t.taskbarCreated != 0 && uint32(msg) == t.taskbarCreated {
		t.added = false
		t.addIcon()
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return r
}

func (t *Tray) iconData() (notifyIconData, View) {
	t.mu.Lock()
	view := t.view
	t.mu.Unlock()
	data := notifyIconData{HWnd: t.hwnd.Load(), UID: trayIconID}
	data.CbSize = uint32(unsafe.Sizeof(data))
	data.UFlags = nifMessage | nifIcon | nifTip | nifShowTip
	data.UCallbackMessage = wmTrayCallback
	data.HIcon = t.icons[view.Icon]
	copyUTF16(data.SzTip[:], view.Tooltip)
	return data, view
}

func (t *Tray) addIcon() {
	data, _ := t.iconData()
	if !shellNotifyIcon(nimAdd, &data) {
		return
	}
	data.UVersion = notifyIconVersion4
	shellNotifyIcon(nimSetVersion, &data)
	t.added = true
	// A notice that came before the icon existed shows now.
	t.showNotice()
}

func (t *Tray) updateIcon() {
	if !t.added {
		t.addIcon()
		return
	}
	data, _ := t.iconData()
	shellNotifyIcon(nimModify, &data)
}

func (t *Tray) deleteIcon() {
	if !t.added {
		return
	}
	data := notifyIconData{HWnd: t.hwnd.Load(), UID: trayIconID}
	data.CbSize = uint32(unsafe.Sizeof(data))
	shellNotifyIcon(nimDelete, &data)
	t.added = false
}

// showNotice shows the pending notice. Without an icon (at sign-in the
// taskbar may not exist yet) the notice stays pending until addIcon
// succeeds, so a notice from the start, such as the update notice, is not
// lost.
func (t *Tray) showNotice() {
	if !t.added {
		return
	}
	t.mu.Lock()
	text := t.notice
	t.notice = ""
	t.mu.Unlock()
	if text == "" {
		return
	}
	data := notifyIconData{HWnd: t.hwnd.Load(), UID: trayIconID, UFlags: nifInfo, DwInfoFlags: niifInfo | niifNoSound}
	data.CbSize = uint32(unsafe.Sizeof(data))
	copyUTF16(data.SzInfoTitle[:], AppName)
	copyUTF16(data.SzInfo[:], text)
	shellNotifyIcon(nimModify, &data)
}

// showMenu shows the menu at the pointer and hands the chosen command to
// Choose. The window must be in the foreground for the menu to close when
// the user clicks elsewhere. The installed program's lines are read now,
// so the check mark follows the registry.
func (t *Tray) showMenu(hwnd uintptr) {
	var app AppItems
	if t.AppItems != nil {
		app = t.AppItems()
	}
	app.Version = t.Version
	t.mu.Lock()
	view := ViewOf(t.state, app)
	t.mu.Unlock()
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)
	for _, item := range view.Menu {
		if item.ID == MenuSeparator {
			procAppendMenuW.Call(menu, mfSeparator, 0, 0)
			continue
		}
		flags := uintptr(mfString)
		if !item.Enabled {
			flags |= mfGrayed
		}
		if item.Checked {
			flags |= mfChecked
		}
		label := strings.ReplaceAll(item.Label, "&", "&&")
		procAppendMenuW.Call(menu, flags, uintptr(item.ID), uintptr(unsafe.Pointer(utf16Ptr(label))))
	}
	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	procSetForegroundWindow.Call(hwnd)
	chosen, _, _ := procTrackPopupMenu.Call(menu, tpmRightButton|tpmBottomAlign|tpmNoNotify|tpmReturnCmd,
		uintptr(pt.X), uintptr(pt.Y), 0, hwnd, 0)
	postMessage(hwnd, wmNull, 0, 0)
	if chosen != 0 && MenuID(chosen) != MenuStatus && t.Choose != nil {
		t.Choose(MenuID(chosen))
	}
}
