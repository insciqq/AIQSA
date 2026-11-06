package main

import (
	"bytes"
	"debug/pe"
	"testing"
)

// The committed resources (connect/assets/windows/generate.sh) are COFF
// objects for the right machine, each with the icons, version and manifest.
func TestWindowsResourcesAreCommittedForBothArchitectures(t *testing.T) {
	for file, machine := range map[string]uint16{
		"rsrc_windows_amd64.syso": pe.IMAGE_FILE_MACHINE_AMD64,
		"rsrc_windows_arm64.syso": pe.IMAGE_FILE_MACHINE_ARM64,
	} {
		f, err := pe.Open(file)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		defer f.Close()
		if f.Machine != machine {
			t.Errorf("%s: machine %#x, want %#x", file, f.Machine, machine)
		}
		section := f.Section(".rsrc")
		if section == nil {
			t.Fatalf("%s: no .rsrc section", file)
		}
		data, err := section.Data()
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{`level="asInvoker"`, "permonitorv2", "{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}", "Microsoft.Windows.Common-Controls"} {
			if !bytes.Contains(data, []byte(want)) {
				t.Errorf("%s: manifest lacks %s", file, want)
			}
		}
	}
}
