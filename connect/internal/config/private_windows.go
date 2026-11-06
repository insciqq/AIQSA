//go:build windows

package config

import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// openNoFollow opens path for reading and refuses a symbolic link or other
// reparse point.
func openNoFollow(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		windows.CloseHandle(handle)
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(handle)
		return nil, fmt.Errorf("%s is a link", path)
	}
	return os.NewFile(uintptr(handle), path), nil
}

// checkPrivateFile refuses a file whose owner is not the current user or
// whose access list lets a broad group in. Windows keeps no mode bits.
func checkPrivateFile(f *os.File, _ os.FileInfo, path string) error {
	acl, err := readFileACL(windows.Handle(f.Fd()))
	if err != nil {
		return fmt.Errorf("cannot check who can read %s: %w", path, err)
	}
	return checkPrivateACL(acl, path)
}

func readFileACL(handle windows.Handle) (fileACL, error) {
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fileACL{}, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return fileACL{}, err
	}
	var acl fileACL
	owner, _, err := sd.Owner()
	if err != nil {
		return fileACL{}, err
	}
	acl.OwnerIsUser = owner != nil && owner.Equals(user.User.Sid)
	dacl, _, err := sd.DACL()
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) || err == nil && dacl == nil {
		acl.NullDACL = true
		return acl, nil
	}
	if err != nil {
		return fileACL{}, err
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return fileACL{}, err
		}
		switch ace.Header.AceType {
		case windows.ACCESS_DENIED_ACE_TYPE, aceTypeDeniedObject, aceTypeDeniedCallback, aceTypeDeniedCallbackObject:
			continue
		case windows.ACCESS_ALLOWED_ACE_TYPE:
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			acl.Allowed = append(acl.Allowed, aclEntry{Trustee: trusteeOf(sid), Mask: uint32(ace.Mask)})
		default:
			// An entry whose trustee this check does not read counts as broad.
			acl.Allowed = append(acl.Allowed, aclEntry{Trustee: trusteeBroad, Mask: uint32(ace.Mask)})
		}
	}
	return acl, nil
}

// Denying entry types winnt.h defines beside ACCESS_DENIED_ACE_TYPE.
const (
	aceTypeDeniedObject         = 6
	aceTypeDeniedCallback       = 10
	aceTypeDeniedCallbackObject = 12
)

var broadSIDs = []windows.WELL_KNOWN_SID_TYPE{
	windows.WinWorldSid, windows.WinBuiltinUsersSid, windows.WinAuthenticatedUserSid,
	windows.WinInteractiveSid, windows.WinAnonymousSid, windows.WinBuiltinGuestsSid,
}

func trusteeOf(sid *windows.SID) aclTrustee {
	for _, broad := range broadSIDs {
		if sid.IsWellKnown(broad) {
			return trusteeBroad
		}
	}
	return trusteeOther
}

// tightenDir gives a directory the client created a protected access list
// for the user, SYSTEM and Administrators only, inherited by its files: the
// Windows form of mode 0700.
func tightenDir(dir string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// syncDir has nothing to do on Windows: a rename is durable once it returns.
func syncDir(string) {}
