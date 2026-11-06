// Package winapp is AIQSA Connect as a Windows application: the downloaded
// exe installs itself for the current user without administrator rights,
// starts at sign-in, lives in the notification area (tray), pairs through
// the browser and uninstalls from Windows Apps (spec O-05, O-06, §9).
//
// The flows (install, switch, uninstall, the tray's connection) are plain Go
// over small interfaces (Registry, System, Dialogs, the device API and the
// daemon) so they are tested on any system; the Win32 implementations of
// those interfaces live in the _windows.go files.
package winapp

import (
	"errors"
	"regexp"
	"strings"

	"github.com/insciqq/AIQSA/connect/internal/config"
)

// ErrUnrecognizedFileName means the program's file name does not carry an
// AIQSA address: it was renamed, or downloaded from somewhere else.
var ErrUnrecognizedFileName = errors.New("the file name does not name an AIQSA address")

// FileNamePrefix starts the name of every downloaded Windows client.
const FileNamePrefix = "AIQSA Connect - "

// downloadNameRegexp splits "AIQSA Connect - <address>[ (N)].exe". The
// suffix is what browsers add to a repeated download: " (1)" in Chrome and
// Edge, "(1)" in Firefox.
var downloadNameRegexp = regexp.MustCompile(`(?i)^AIQSA Connect - (.+?)(?: ?\([0-9]{1,4}\))?\.exe$`)

// hostRegexp is a DNS name or a dotted IPv4 address. IPv6 addresses are not
// put into file names (spec D-13), and underscores never occur in host names,
// so the last underscore separates the port.
var hostRegexp = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$`)

var portRegexp = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)

// OriginFromFileName reads the AIQSA origin from the name of the downloaded
// program (spec §9 step 1, D-13):
//
//	AIQSA Connect - ai.example.com.exe          → https://ai.example.com
//	AIQSA Connect - ai.example.com_8443.exe     → https://ai.example.com:8443
//	AIQSA Connect - http_192.168.1.5_3000.exe   → http://192.168.1.5:3000
//	AIQSA Connect - ai.example.com (1).exe      → https://ai.example.com
//
// The result passes config.NormalizeOrigin, so plain http is accepted only
// where `aiqsa-connect login` accepts it. name may be a full path.
func OriginFromFileName(name string) (string, error) {
	if i := strings.LastIndexAny(name, `\/`); i >= 0 {
		name = name[i+1:]
	}
	match := downloadNameRegexp.FindStringSubmatch(name)
	if match == nil {
		return "", ErrUnrecognizedFileName
	}
	address := strings.ToLower(match[1])
	scheme := "https"
	if rest, ok := strings.CutPrefix(address, "http_"); ok {
		scheme, address = "http", rest
	}
	host, port := address, ""
	if i := strings.LastIndexByte(address, '_'); i >= 0 {
		host, port = address[:i], address[i+1:]
		if !portRegexp.MatchString(port) {
			return "", ErrUnrecognizedFileName
		}
	}
	if len(host) > 253 || !hostRegexp.MatchString(host) {
		return "", ErrUnrecognizedFileName
	}
	raw := scheme + "://" + host
	if port != "" {
		raw += ":" + port
	}
	origin, err := config.NormalizeOrigin(raw)
	if err != nil {
		return "", ErrUnrecognizedFileName
	}
	return origin, nil
}
