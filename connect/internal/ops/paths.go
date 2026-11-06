package ops

import (
	"path"
	"strings"
)

// Paths from the agent are absolute or relative to the op's cwd; `~` is the
// home directory; on Windows `\` and `/` both separate, and drive (`C:\`)
// and UNC (`\\server\share`) paths are absolute. The functions take the
// target system, so the Windows rules are tested on every system.

// resolvePath returns the absolute, cleaned form of p. cwd is resolved the
// same way against home first.
func resolvePath(goos, home, cwd, p string) string {
	base := resolveAgainst(goos, home, home, cwd)
	return resolveAgainst(goos, home, base, p)
}

func resolveAgainst(goos, home, base, p string) string {
	if goos != "windows" {
		switch {
		case p == "~":
			return path.Clean(home)
		case strings.HasPrefix(p, "~/"):
			return path.Clean(home + "/" + p[2:])
		case strings.HasPrefix(p, "/"):
			return path.Clean(p)
		case p == "":
			return path.Clean(base)
		}
		return path.Clean(base + "/" + p)
	}
	switch {
	case p == "~":
		return winClean(home)
	case strings.HasPrefix(p, `~\`) || strings.HasPrefix(p, "~/"):
		return winClean(home + `\` + p[2:])
	case winIsAbs(p):
		return winClean(p)
	case p == "":
		return winClean(base)
	case p[0] == '\\' || p[0] == '/':
		// Rooted without a drive: the root of base's drive.
		volume, _ := winVolume(winSlashes(base))
		return winClean(volume + p)
	case len(p) >= 2 && isDriveLetter(p[0]) && p[1] == ':':
		// `C:name` means a path on drive C; taken from its root.
		return winClean(p[:2] + `\` + p[2:])
	}
	return winClean(base + `\` + p)
}

// isAbsPath reports whether p is absolute on goos.
func isAbsPath(goos, p string) bool {
	if goos != "windows" {
		return strings.HasPrefix(p, "/")
	}
	return winIsAbs(p)
}

// parentPath returns the parent of the absolute, cleaned path p; false at a root.
func parentPath(goos, p string) (string, bool) {
	if goos != "windows" {
		if p == "/" {
			return "", false
		}
		return path.Dir(p), true
	}
	volume, rest := winVolume(p)
	rest = strings.TrimSuffix(rest, `\`)
	if rest == "" {
		return "", false
	}
	i := strings.LastIndexByte(rest, '\\')
	if i <= 0 {
		return volume + `\`, true
	}
	return volume + rest[:i], true
}

func isDriveLetter(c byte) bool { return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' }

func winSlashes(p string) string { return strings.ReplaceAll(p, "/", `\`) }

func winIsAbs(p string) bool {
	p = winSlashes(p)
	if strings.HasPrefix(p, `\\`) {
		// A UNC path names a server and a share.
		parts := strings.SplitN(p[2:], `\`, 3)
		return len(parts) >= 2 && parts[0] != "" && parts[1] != ""
	}
	return len(p) >= 3 && isDriveLetter(p[0]) && p[1] == ':' && p[2] == '\\'
}

// winVolume splits p (with backslashes) into its volume, `C:` or
// `\\server\share`, and the rest.
func winVolume(p string) (volume, rest string) {
	if len(p) >= 2 && isDriveLetter(p[0]) && p[1] == ':' {
		return strings.ToUpper(p[:1]) + ":", p[2:]
	}
	if strings.HasPrefix(p, `\\`) {
		parts := strings.SplitN(p[2:], `\`, 3)
		switch len(parts) {
		case 1:
			return p, ""
		case 2:
			return p, ""
		}
		return `\\` + parts[0] + `\` + parts[1], `\` + parts[2]
	}
	return "", p
}

// winClean is filepath.Clean of Windows: one separator `\`, `.` and `..`
// resolved, no trailing separator except at a root.
func winClean(p string) string {
	volume, rest := winVolume(winSlashes(p))
	var parts []string
	for _, part := range strings.Split(rest, `\`) {
		switch part {
		case "", ".":
		case "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		default:
			parts = append(parts, part)
		}
	}
	return volume + `\` + strings.Join(parts, `\`)
}
