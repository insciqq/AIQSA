//go:build windows

package winapp

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// WindowsShortcuts writes shell links through the Shell's ShellLink COM
// object (IShellLinkW and IPersistFile), without third-party libraries.
type WindowsShortcuts struct{}

var (
	ole32                = windows.NewLazySystemDLL("ole32.dll")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")

	clsidShellLink  = windows.GUID{Data1: 0x00021401, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIShellLinkW  = windows.GUID{Data1: 0x000214F9, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIPersistFile = windows.GUID{Data1: 0x0000010B, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
)

// Vtable slots (ShObjIdl_core.h, ObjIdl.h): IUnknown takes 0-2.
const (
	vtQueryInterface = 0
	vtRelease        = 2

	// IShellLinkW
	vtSetDescription      = 7
	vtSetWorkingDirectory = 9
	vtSetArguments        = 11
	vtSetIconLocation     = 17
	vtSetPath             = 20

	// IPersistFile (after IPersist::GetClassID at 3)
	vtSave = 6
)

// Create writes link (Shortcuts.Create). COM runs on a thread of its own,
// initialized apartment-threaded and ended with the goroutine, so no other
// code inherits its COM state.
func (WindowsShortcuts) Create(link, target, workDir, description string) error {
	done := make(chan error, 1)
	go func() {
		// The thread stays locked: it ends with this goroutine.
		runtime.LockOSThread()
		done <- createShortcut(link, target, workDir, description)
	}()
	return <-done
}

func createShortcut(link, target, workDir, description string) error {
	linkPtr, err := windows.UTF16PtrFromString(link)
	if err != nil {
		return err
	}
	targetPtr, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	dirPtr, err := windows.UTF16PtrFromString(workDir)
	if err != nil {
		return err
	}
	descPtr, err := windows.UTF16PtrFromString(description)
	if err != nil {
		return err
	}
	argsPtr, _ := windows.UTF16PtrFromString("")

	switch err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE); err {
	case nil, syscall.Errno(windows.S_FALSE):
		defer windows.CoUninitialize()
	default:
		return fmt.Errorf("CoInitializeEx failed: %w", err)
	}

	var shellLink unsafe.Pointer
	r, _, _ := syscall.SyscallN(procCoCreateInstance.Addr(),
		uintptr(unsafe.Pointer(&clsidShellLink)), 0, windows.CLSCTX_INPROC_SERVER,
		uintptr(unsafe.Pointer(&iidIShellLinkW)), uintptr(unsafe.Pointer(&shellLink)))
	if err := hresult("CoCreateInstance", r); err != nil {
		return err
	}
	if shellLink == nil {
		return fmt.Errorf("CoCreateInstance returned no object")
	}
	defer comRelease(shellLink)

	steps := []struct {
		name string
		slot int
		args []uintptr
	}{
		{"SetPath", vtSetPath, []uintptr{uintptr(unsafe.Pointer(targetPtr))}},
		{"SetArguments", vtSetArguments, []uintptr{uintptr(unsafe.Pointer(argsPtr))}},
		{"SetWorkingDirectory", vtSetWorkingDirectory, []uintptr{uintptr(unsafe.Pointer(dirPtr))}},
		{"SetDescription", vtSetDescription, []uintptr{uintptr(unsafe.Pointer(descPtr))}},
		{"SetIconLocation", vtSetIconLocation, []uintptr{uintptr(unsafe.Pointer(targetPtr)), 0}},
	}
	for _, step := range steps {
		if err := hresult(step.name, comCall(shellLink, step.slot, step.args...)); err != nil {
			return err
		}
	}

	var persistFile unsafe.Pointer
	if err := hresult("QueryInterface", comCall(shellLink, vtQueryInterface,
		uintptr(unsafe.Pointer(&iidIPersistFile)), uintptr(unsafe.Pointer(&persistFile)))); err != nil {
		return err
	}
	if persistFile == nil {
		return fmt.Errorf("QueryInterface returned no object")
	}
	defer comRelease(persistFile)
	err = hresult("Save", comCall(persistFile, vtSave, uintptr(unsafe.Pointer(linkPtr)), 1))
	// The strings were handed to COM as integers; keep them until it is done.
	runtime.KeepAlive(linkPtr)
	runtime.KeepAlive(targetPtr)
	runtime.KeepAlive(dirPtr)
	runtime.KeepAlive(descPtr)
	runtime.KeepAlive(argsPtr)
	return err
}

// comCall calls the method in vtable slot of the COM object obj, which is
// passed as the method's this.
func comCall(obj unsafe.Pointer, slot int, args ...uintptr) uintptr {
	vtable := *(*unsafe.Pointer)(obj)
	method := *(*uintptr)(unsafe.Add(vtable, uintptr(slot)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(method, append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

func comRelease(obj unsafe.Pointer) { comCall(obj, vtRelease) }

// hresult is the error of a failed HRESULT (its sign bit set); nil for
// S_OK and other success codes.
func hresult(call string, r uintptr) error {
	if int32(uint32(r)) >= 0 {
		return nil
	}
	return fmt.Errorf("%s failed: %w", call, syscall.Errno(uint32(r)))
}
