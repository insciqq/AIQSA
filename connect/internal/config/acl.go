package config

// The Windows check of a private file reads its owner and access list into
// a fileACL; the decision is here, apart from the system calls, so it is
// tested on every system.

// Who an access-allowed entry of a file's access list names.
type aclTrustee int

const (
	// trusteeOther is any account or group that is not broad: the user,
	// SYSTEM, Administrators or another named account.
	trusteeOther aclTrustee = iota
	// trusteeBroad is a group most accounts belong to: Everyone, Users,
	// Authenticated Users, Interactive, Anonymous or Guests.
	trusteeBroad
)

// aclEntry is one access-allowed entry: whom it names and the access it gives.
type aclEntry struct {
	Trustee aclTrustee
	Mask    uint32
}

// fileACL is what the check needs of a file's security descriptor.
type fileACL struct {
	// OwnerIsUser is whether the file's owner is the current user.
	OwnerIsUser bool
	// NullDACL means there is no access list at all: everyone has full access.
	NullDACL bool
	// Allowed are the access-allowed entries; denied entries never open access.
	Allowed []aclEntry
}

// checkPrivateACL refuses a file of another owner, a file without an
// access list and one that grants a broad group any access.
func checkPrivateACL(acl fileACL, path string) error {
	if !acl.OwnerIsUser {
		return errOtherOwner(path)
	}
	if acl.NullDACL {
		return &InsecureCredentialsError{Path: path, ACL: true}
	}
	for _, entry := range acl.Allowed {
		if entry.Trustee == trusteeBroad && entry.Mask != 0 {
			return &InsecureCredentialsError{Path: path, ACL: true}
		}
	}
	return nil
}
