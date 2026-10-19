//go:build linux

package monoclock

import (
	"fmt"
	"os"
	"os/exec"
	"testing"
)

// Readings in separate processes are of one clock: a child's stamp falls
// between the parent's readings before and after it.
func TestStampsOfSeparateProcessesAreOrdered(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	before := Now()
	cmd := exec.Command(exe, "-test.run=^$")
	cmd.Env = append(os.Environ(), childEnv+"=1")
	out, err := cmd.Output()
	after := Now()
	if err != nil {
		t.Fatal(err)
	}
	var child Stamp
	if _, err := fmt.Sscanf(string(out), "%s %d", &child.Kind, &child.At); err != nil {
		t.Fatalf("child printed %q: %v", out, err)
	}
	if child.Kind != Mono || !child.Comparable(before) || !(before.At < child.At && child.At < after.At) {
		t.Fatalf("child %+v not between %+v and %+v", child, before, after)
	}
}
