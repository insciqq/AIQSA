package winapp

// notifyIconData is NOTIFYICONDATAW (shellapi.h) with the Vista fields, as
// laid out on 64-bit Windows, where shellapi.h keeps natural alignment (it
// packs the structure only for 32-bit builds). AIQSA Connect ships for
// amd64 and arm64 only; TestNotifyIconDataLayout pins the size Windows
// expects in cbSize. Handles are uintptr so the layout is checked on any
// system.
type notifyIconData struct {
	CbSize           uint32
	HWnd             uintptr
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            uintptr
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32 // union with uTimeout
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         [16]byte
	HBalloonIcon     uintptr
}

// notifyIconDataSize is sizeof(NOTIFYICONDATAW) on 64-bit Windows.
const notifyIconDataSize = 976

// copyUTF16 writes s into dst as a zero-terminated UTF-16 string, cut to
// fit without splitting a surrogate pair.
func copyUTF16(dst []uint16, s string) {
	units := utf16Units(truncateUTF16(s, len(dst)-1))
	n := copy(dst, units)
	for i := n; i < len(dst); i++ {
		dst[i] = 0
	}
}
