package winapp

import (
	"testing"
	"unsafe"
)

func TestNotifyIconDataLayout(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("the Windows client ships for 64-bit systems only")
	}
	var data notifyIconData
	if size := unsafe.Sizeof(data); size != notifyIconDataSize {
		t.Fatalf("sizeof(NOTIFYICONDATAW) = %d, want %d", size, notifyIconDataSize)
	}
	offsets := map[string][2]uintptr{
		"hWnd":         {unsafe.Offsetof(data.HWnd), 8},
		"hIcon":        {unsafe.Offsetof(data.HIcon), 32},
		"szTip":        {unsafe.Offsetof(data.SzTip), 40},
		"szInfo":       {unsafe.Offsetof(data.SzInfo), 304},
		"uVersion":     {unsafe.Offsetof(data.UVersion), 816},
		"szInfoTitle":  {unsafe.Offsetof(data.SzInfoTitle), 820},
		"dwInfoFlags":  {unsafe.Offsetof(data.DwInfoFlags), 948},
		"guidItem":     {unsafe.Offsetof(data.GuidItem), 952},
		"hBalloonIcon": {unsafe.Offsetof(data.HBalloonIcon), 968},
	}
	for name, got := range offsets {
		if got[0] != got[1] {
			t.Errorf("offset of %s = %d, want %d", name, got[0], got[1])
		}
	}
}

func TestCopyUTF16TerminatesAndCuts(t *testing.T) {
	dst := []uint16{9, 9, 9, 9}
	copyUTF16(dst, "ab😀")
	if dst[0] != 'a' || dst[1] != 'b' || dst[2] != 0 || dst[3] != 0 {
		t.Fatalf("dst = %v", dst)
	}
	copyUTF16(dst, "abcde")
	if dst[2] != 'c' || dst[3] != 0 {
		t.Fatalf("dst = %v", dst)
	}
}
