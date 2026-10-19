package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"unicode/utf8"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

func init() {
	register(command{
		name:    "login",
		usage:   "login <origin> [--name <name>]",
		summary: "Connect this computer to an AIQSA installation",
		run:     runLogin,
	})
}

// loginPairOptions lets tests replace the poll clock.
var loginPairOptions api.PairOptions

const loginUsage = "Usage: aiqsa-connect login <AIQSA address, e.g. https://ai.example.com> [--name <computer name>]"

func parseLoginArgs(args []string) (origin, name string, err error) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--name" || arg == "-name":
			if i+1 >= len(args) {
				return "", "", errors.New("--name needs a value")
			}
			i++
			name = args[i]
		case strings.HasPrefix(arg, "--name="):
			name = strings.TrimPrefix(arg, "--name=")
		case strings.HasPrefix(arg, "-"):
			return "", "", fmt.Errorf("unknown option %s", arg)
		case origin == "":
			origin = arg
		default:
			return "", "", errors.New("too many arguments")
		}
	}
	if origin == "" {
		return "", "", errors.New("the AIQSA address is missing")
	}
	return origin, name, nil
}

// platform maps this build's target to the contract's values.
func platform() (protocol.OS, protocol.Arch, error) {
	os, arch := protocol.OS(runtime.GOOS), protocol.Arch(runtime.GOARCH)
	if (os != protocol.OSDarwin && os != protocol.OSLinux) || (arch != protocol.ArchAMD64 && arch != protocol.ArchARM64) {
		return "", "", fmt.Errorf("aiqsa-connect supports macOS and Linux (including WSL) on amd64 and arm64; this computer is %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	return os, arch, nil
}

func deviceNames(requested string) (name, hostname string, err error) {
	raw, _ := os.Hostname()
	hostname = tmux.SanitizeText(raw, protocol.MaxHostnameLength)
	if hostname == "" {
		hostname = "computer"
	}
	if requested == "" {
		return tmux.SanitizeText(hostname, protocol.MaxDeviceNameLength), hostname, nil
	}
	name = strings.TrimSpace(requested)
	if name == "" || tmux.SanitizeText(name, protocol.MaxDeviceNameLength+1) != name {
		return "", "", errors.New("the computer name must be plain text without control characters")
	}
	if utf8.RuneCountInString(name) > protocol.MaxDeviceNameLength {
		return "", "", fmt.Errorf("the computer name must be at most %d characters", protocol.MaxDeviceNameLength)
	}
	return name, hostname, nil
}

func runLogin(inv *invocation) int {
	rawOrigin, requestedName, err := parseLoginArgs(inv.args)
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect login: %v\n%s\n", err, loginUsage)
		return 2
	}
	origin, err := config.NormalizeOrigin(rawOrigin)
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect login: %v\n", err)
		return 2
	}
	paths, err := config.ResolvePaths()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect login: %v\n", err)
		return 1
	}
	osName, arch, err := platform()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect login: %v\n", err)
		return 1
	}
	name, hostname, err := deviceNames(requestedName)
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect login: %v\n", err)
		return 2
	}
	client := api.New(origin, "", version)
	pairing, err := client.CreatePairing(inv.ctx, protocol.PairingCreateRequest{
		Name: name, Hostname: hostname, OS: osName, Arch: arch, ClientVersion: version,
	})
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect login: %s\n", describeAPIError(origin, err))
		return 1
	}
	if config.IsUnencryptedOrigin(origin) {
		fmt.Fprintln(inv.stderr, "aiqsa-connect login: warning: http:// sends this computer's token and the terminal unencrypted; use it only on a network you trust. Browsers also turn off notifications and dictation without https://.")
	}
	fmt.Fprintf(inv.stdout, "Open %s and approve this computer. Code: %s\n", pairing.VerificationURI, pairing.UserCode)
	fmt.Fprintln(inv.stdout, "Waiting for approval…")
	approved, err := client.WaitForApproval(inv.ctx, pairing, loginPairOptions)
	if err != nil {
		if inv.ctx.Err() != nil {
			fmt.Fprintln(inv.stderr, "aiqsa-connect login: cancelled")
			return 1
		}
		if errors.Is(err, api.ErrPairingDenied) || errors.Is(err, api.ErrPairingExpired) {
			fmt.Fprintf(inv.stderr, "aiqsa-connect login: %v\n", err)
		} else {
			fmt.Fprintf(inv.stderr, "aiqsa-connect login: %s\n", describeAPIError(origin, err))
		}
		return 1
	}
	creds := config.Credentials{Origin: origin, DeviceID: approved.DeviceID, DeviceToken: approved.DeviceToken}
	if err := paths.SaveCredentials(creds); err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect login: cannot save credentials: %v\n", err)
		return 1
	}
	fmt.Fprintf(inv.stdout, "This computer is connected to %s as %q.\nStart the client with: aiqsa-connect up\n", origin, name)
	return 0
}

// describeAPIError explains a failed device API call without echoing the server's body.
func describeAPIError(origin string, err error) string {
	if errors.Is(err, api.ErrPlainHTTPNotLocal) {
		return fmt.Sprintf("%s: %v", origin, err)
	}
	apiErr, ok := api.AsError(err)
	if !ok {
		return fmt.Sprintf("cannot reach AIQSA at %s: %v", origin, err)
	}
	switch apiErr.Code {
	case protocol.CodeDisabled:
		return "AIQSA Connect is turned off on this AIQSA server; ask its administrator to turn it on"
	case protocol.CodeRateLimited:
		return "too many attempts; try again in a few minutes"
	case protocol.CodeUnauthorized:
		return "device revoked — run aiqsa-connect login"
	case protocol.CodeClientOutdated:
		return "this aiqsa-connect is too old for the server; install it again from AIQSA → AIQSA Connect"
	}
	return fmt.Sprintf("AIQSA at %s refused the request (%s)", origin, apiErr.LogCode())
}
