package ops

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func TestWindowsShellSelection(t *testing.T) {
	lookPath := func(found ...string) func(string) (string, error) {
		return func(name string) (string, error) {
			if slices.Contains(found, name) {
				return `C:\Tools\` + name, nil
			}
			return "", exec.ErrNotFound
		}
	}
	sh := selectWindowsShell(lookPath("pwsh.exe", "powershell.exe"), `C:\Windows`)
	if sh.Kind != protocol.ShellPwsh || sh.Path != `C:\Tools\pwsh.exe` || sh.Name != "PowerShell" {
		t.Fatalf("pwsh: %+v", sh)
	}
	sh = selectWindowsShell(lookPath("powershell.exe"), `C:\Windows`)
	if sh.Kind != protocol.ShellPowerShell || sh.Path != `C:\Tools\powershell.exe` || sh.Name != "Windows PowerShell" {
		t.Fatalf("powershell: %+v", sh)
	}
	sh = selectWindowsShell(lookPath(), `D:\WINDOWS`)
	if sh.Path != `D:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe` {
		t.Fatalf("fixed place: %+v", sh)
	}
}

func TestPowerShellInvocation(t *testing.T) {
	command := `Get-ChildItem "C:\Users\ivan\Документы" | Select-Object -First 3`
	args, script := powerShellInvocation(command)
	if script != nil || !slices.Equal(args[:len(args)-2], []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"}) ||
		args[len(args)-2] != "-EncodedCommand" {
		t.Fatalf("args: %v", args)
	}
	raw, err := base64.StdEncoding.DecodeString(args[len(args)-1])
	if err != nil || len(raw)%2 != 0 {
		t.Fatalf("encoded: %v", err)
	}
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8
	}
	source := string(utf16.Decode(units))
	if !strings.HasPrefix(source, "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$OutputEncoding = ") || !strings.HasSuffix(source, "\n"+command) {
		t.Fatalf("source: %q", source)
	}
	long := strings.Repeat("Write-Output 'строка'\n", 2000)
	args, script = powerShellInvocation(long)
	if args[len(args)-1] != "-File" || !bytes.HasPrefix(script, []byte{0xEF, 0xBB, 0xBF}) || !strings.HasSuffix(string(script), long) ||
		!strings.Contains(string(script), "OutputEncoding") {
		t.Fatalf("script: %v %d bytes", args, len(script))
	}
}

// fakeJobs records the job object calls of a process tree.
type fakeJobs struct {
	calls     []string
	assignErr error
}

func (f *fakeJobs) CreateJob() (uintptr, error) {
	f.calls = append(f.calls, "create")
	return 7, nil
}

func (f *fakeJobs) AssignAndResume(job uintptr, pid int) error {
	f.calls = append(f.calls, "assign")
	return f.assignErr
}

func (f *fakeJobs) Terminate(job uintptr) error {
	f.calls = append(f.calls, "terminate")
	return nil
}

func (f *fakeJobs) Close(job uintptr) error {
	f.calls = append(f.calls, "close")
	return nil
}

func TestJobObjectTree(t *testing.T) {
	jobs := &fakeJobs{}
	killed := false
	tree, err := startInJob(jobs, func() (int, error) { return 42, nil }, func() { killed = true })
	if err != nil || killed {
		t.Fatalf("start: %v %v", err, killed)
	}
	tree.Terminate()
	tree.Kill()
	tree.Release()
	tree.Release()
	if strings.Join(jobs.calls, ",") != "create,assign,terminate,terminate,close" {
		t.Fatalf("calls: %v", jobs.calls)
	}

	// A process that cannot join the job is killed: nothing runs outside one.
	jobs = &fakeJobs{assignErr: errors.New("access denied")}
	if _, err := startInJob(jobs, func() (int, error) { return 42, nil }, func() { killed = true }); err == nil || !killed {
		t.Fatalf("assign failure: %v killed=%v", err, killed)
	}
	if strings.Join(jobs.calls, ",") != "create,assign,close" {
		t.Fatalf("calls: %v", jobs.calls)
	}
	jobs = &fakeJobs{}
	if _, err := startInJob(jobs, func() (int, error) { return 0, errors.New("not found") }, nil); err == nil || strings.Join(jobs.calls, ",") != "create,close" {
		t.Fatalf("start failure: %v %v", err, jobs.calls)
	}
}

func TestWindowsNames(t *testing.T) {
	for cp, want := range map[uint32]string{1251: "windows-1251", 1252: "windows-1252", 874: "windows-874", 932: "cp932", 866: "cp866", 65001: "utf-8"} {
		if got := codePageName(cp); got != want || !protocol.EncodingRegexp.MatchString(got) {
			t.Errorf("code page %d: %q", cp, got)
		}
	}
	if got := windowsVersionName(10, 0, 22631, "23H2"); got != "Windows 11 23H2 (10.0.22631)" {
		t.Errorf("11: %q", got)
	}
	if got := windowsVersionName(10, 0, 19045, ""); got != "Windows 10 (10.0.19045)" {
		t.Errorf("10: %q", got)
	}
}
