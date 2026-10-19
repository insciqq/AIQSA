package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func runArgs(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(&invocation{ctx: context.Background(), args: args, stdin: strings.NewReader(""), stdout: &stdout, stderr: &stderr})
	return code, stdout.String(), stderr.String()
}

func TestVersionPrintsTheStampedVersion(t *testing.T) {
	code, stdout, stderr := runArgs("version")
	if code != 0 || stdout != version+"\n" || stderr != "" {
		t.Fatalf("got %d %q %q", code, stdout, stderr)
	}
	if code, _, _ := runArgs("version", "extra"); code != 2 {
		t.Fatalf("extra argument accepted: %d", code)
	}
}

func TestUsageListsRegisteredCommands(t *testing.T) {
	code, stdout, _ := runArgs("help")
	if code != 0 || !strings.Contains(stdout, "version") {
		t.Fatalf("got %d %q", code, stdout)
	}
	if code, _, stderr := runArgs(); code != 2 || !strings.Contains(stderr, "Usage:") {
		t.Fatalf("no arguments: %d %q", code, stderr)
	}
	if code, _, stderr := runArgs("nope"); code != 2 || !strings.Contains(stderr, `unknown command "nope"`) {
		t.Fatalf("unknown command: %d %q", code, stderr)
	}
}
