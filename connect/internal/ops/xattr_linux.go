package ops

import "golang.org/x/sys/unix"

// errNoXattr is what getxattr answers for an attribute the file lacks.
const errNoXattr = unix.ENODATA
