package ops

import (
	"os"
	"runtime"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// validHome returns home, cleaned, when it is an absolute path the contract
// accepts; otherwise the system's root.
func validHome(goos, home string) string {
	if home != "" && isAbsPath(goos, home) {
		home = resolvePath(goos, "/", home, home)
		if validDevicePath(home) {
			return home
		}
	}
	if goos == "windows" {
		return `C:\`
	}
	return "/"
}

// Home is the home directory ops resolve `~` and relative paths against.
func (e *Executor) Home() string { return e.home }

// DeviceInfo describes this computer for the device_info event. It may
// take a few seconds the first time (it asks the shell for its version).
func (e *Executor) DeviceInfo() *protocol.DeviceInfoEvent {
	raw, _ := os.Hostname()
	hostname := config.SanitizeText(raw, protocol.MaxHostnameLength)
	if hostname == "" {
		hostname = "computer"
	}
	osVersion := config.SanitizeText(e.sys.OSVersion(), protocol.MaxOSVersionLength)
	if osVersion == "" {
		osVersion = e.goos
	}
	sh := e.Shell()
	shell := protocol.DeviceShell{Kind: sh.Kind, Name: config.SanitizeText(sh.Name, protocol.MaxShellNameLength)}
	if shell.Name == "" {
		shell.Name = string(sh.Kind)
	}
	if sh.Version != nil {
		if version := config.SanitizeText(*sh.Version, protocol.MaxShellVersionLength); version != "" {
			shell.Version = &version
		}
	}
	return &protocol.DeviceInfoEvent{
		Type:      protocol.EventDeviceInfo,
		OS:        protocol.OS(e.goos),
		OSVersion: osVersion,
		Arch:      protocol.Arch(runtime.GOARCH),
		Hostname:  hostname,
		Home:      e.home,
		Shell:     shell,
	}
}
