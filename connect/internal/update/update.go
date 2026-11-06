// Package update replaces the running aiqsa-connect binary with the version
// its AIQSA server offers: it reads the server's client manifest, downloads
// this computer's binary from the same origin, checks it against the
// server's checksums.txt, makes sure it runs and reports that version, and
// puts it in place of the current binary. On macOS and Linux it renames the
// download over the binary. Windows cannot replace a running program file,
// so there the download lands beside it (NewPath), the running file is
// renamed to <exe>.old and the download takes its name (spec D-14); the
// caller then starts the new file and exits, and the next start removes
// <exe>.old.
package update

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

const (
	maxManifestBytes  = 64 << 10
	maxChecksumsBytes = 4 << 10
	// DownloadTimeout bounds the whole update: manifest, checksums and binary.
	DownloadTimeout = 10 * time.Minute
	versionTimeout  = 15 * time.Second
)

var (
	// ErrNotWritable means the binary's directory cannot hold the new
	// version; the client keeps running the current one.
	ErrNotWritable = errors.New("the directory of aiqsa-connect is not writable")
	// ErrUnsupported means the server offers no binary for this computer.
	ErrUnsupported = errors.New("the AIQSA server offers no aiqsa-connect for this computer")
)

// permanentError is a failure that trying again against the same server
// version cannot fix.
type permanentError struct{ err error }

func (e permanentError) Error() string { return e.err.Error() }
func (e permanentError) Unwrap() error { return e.err }

// Permanent reports whether err from Install repeats on every attempt for
// the same announced server version: an unwritable directory, no binary for
// this computer, a development build, or a server offering or building
// another version than it announces. Other failures (network, timeouts,
// refusals, checksums) may pass on a later attempt.
func Permanent(err error) bool {
	var permanent permanentError
	return errors.As(err, &permanent) || errors.Is(err, ErrNotWritable) || errors.Is(err, ErrUnsupported)
}

// Refusal is a refused manifest or download request.
type Refusal struct {
	Status int
	Code   protocol.ReasonCode
}

func (e *Refusal) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("AIQSA answered %d (%s)", e.Status, e.Code)
	}
	return fmt.Sprintf("AIQSA answered %d", e.Status)
}

// Client downloads updates from one AIQSA origin.
type Client struct {
	// Origin is the normalized AIQSA origin, scheme://host[:port].
	Origin string
	// Version is the running client's version, sent with every request.
	Version string
	// HTTP must not follow redirects (see api.NewHTTPClient).
	HTTP *http.Client
}

// Target is the binary this computer runs: Windows, macOS or Linux on
// amd64 or arm64. Its release file name is protocol.ClientBinaryName, with
// .exe on Windows.
func Target() (protocol.OS, protocol.Arch, error) {
	return targetFor(runtime.GOOS, runtime.GOARCH)
}

// currentTarget is the target Install looks for; tests switch it to
// another system's.
var currentTarget = Target

func targetFor(goosName, goarch string) (protocol.OS, protocol.Arch, error) {
	goos, arch := protocol.OS(goosName), protocol.Arch(goarch)
	for _, known := range protocol.OSValues {
		if known == goos {
			for _, knownArch := range protocol.ArchValues {
				if knownArch == arch {
					return goos, arch, nil
				}
			}
		}
	}
	return "", "", ErrUnsupported
}

func (c *Client) get(ctx context.Context, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Origin+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(protocol.ClientVersionHeader, c.Version)
	// Without it the server answers as to a protocol 1 client, whose
	// manifest lists no Windows binary.
	req.Header.Set(protocol.ProtocolHeader, strconv.Itoa(protocol.ProtocolVersion))
	req.Header.Set("User-Agent", "aiqsa-connect/"+c.Version)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, maxManifestBytes))
		refusal := &Refusal{Status: resp.StatusCode}
		var body protocol.ErrorResponse
		if protocol.Decode(data, &body) == nil {
			refusal.Code = body.Code
		}
		return nil, refusal
	}
	return resp, nil
}

func readBounded(resp *http.Response, limit int64) ([]byte, error) {
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("the AIQSA answer is too large")
	}
	return data, nil
}

// Manifest reads the server's client manifest.
func (c *Client) Manifest(ctx context.Context) (protocol.ClientManifest, error) {
	resp, err := c.get(ctx, protocol.ClientManifestPath)
	if err != nil {
		return protocol.ClientManifest{}, err
	}
	data, err := readBounded(resp, maxManifestBytes)
	if err != nil {
		return protocol.ClientManifest{}, err
	}
	var manifest protocol.ClientManifest
	if err := protocol.Decode(data, &manifest); err != nil {
		return protocol.ClientManifest{}, fmt.Errorf("unexpected client manifest from AIQSA: %w", err)
	}
	return manifest, nil
}

// checksum is the SHA-256 that checksums.txt (sha256sum format) gives name.
func (c *Client) checksum(ctx context.Context, name string) (string, error) {
	resp, err := c.get(ctx, protocol.ClientChecksumsPath)
	if err != nil {
		return "", err
	}
	data, err := readBounded(resp, maxChecksumsBytes)
	if err != nil {
		return "", err
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		sum, file, ok := strings.Cut(scanner.Text(), "  ")
		if ok && file == name && protocol.SHA256Regexp.MatchString(sum) {
			return sum, nil
		}
	}
	return "", fmt.Errorf("checksums.txt from AIQSA has no entry for %s", name)
}

// Result is an installed update.
type Result struct {
	Version string
	Path    string
}

// Install replaces executable with the server's binary for this computer.
// want, when not empty, is the version the server announced: a manifest
// offering another version is refused, so a stale server build cannot make
// the client update in a loop. Nothing is replaced unless the new binary
// matches its checksum, runs, and reports the manifest's version.
func (c *Client) Install(ctx context.Context, executable, want string) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, DownloadTimeout)
	defer cancel()
	osName, arch, err := currentTarget()
	if err != nil {
		return Result{}, err
	}
	manifest, err := c.Manifest(ctx)
	if err != nil {
		return Result{}, err
	}
	if manifest.Version == "dev" {
		return Result{}, permanentError{errors.New("the AIQSA server offers a development build of aiqsa-connect, which is never installed automatically")}
	}
	if want != "" && manifest.Version != want {
		return Result{}, permanentError{fmt.Errorf("the AIQSA server runs %s but offers aiqsa-connect %s", want, manifest.Version)}
	}
	var target *protocol.ClientTarget
	for i := range manifest.Targets {
		if manifest.Targets[i].OS == osName && manifest.Targets[i].Arch == arch {
			target = &manifest.Targets[i]
		}
	}
	if target == nil {
		return Result{}, ErrUnsupported
	}
	name := protocol.ClientBinaryName(osName, arch)
	sum, err := c.checksum(ctx, name)
	if err != nil {
		return Result{}, err
	}
	if sum != target.SHA256 {
		return Result{}, errors.New("the AIQSA server's checksums.txt and client manifest disagree; try again later")
	}

	dir := filepath.Dir(executable)
	tmp, err := createStaging(executable)
	if err != nil {
		if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EROFS) {
			return Result{}, fmt.Errorf("%w: %s", ErrNotWritable, dir)
		}
		return Result{}, err
	}
	tmpName := tmp.Name()
	installed := false
	defer func() {
		if !installed {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	resp, err := c.get(ctx, protocol.ClientDownloadPath(osName, arch))
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	if resp.ContentLength >= 0 && resp.ContentLength != target.Size {
		return Result{}, errors.New("the download has an unexpected size")
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(resp.Body, target.Size+1))
	if err != nil {
		return Result{}, fmt.Errorf("download failed: %w", err)
	}
	if written != target.Size {
		return Result{}, errors.New("the download has an unexpected size")
	}
	if hex.EncodeToString(hash.Sum(nil)) != sum {
		return Result{}, errors.New("the download does not match its SHA-256 checksum")
	}
	if err := tmp.Chmod(0o755); err != nil {
		return Result{}, err
	}
	if err := tmp.Sync(); err != nil {
		return Result{}, err
	}
	if err := tmp.Close(); err != nil {
		return Result{}, err
	}
	if got, err := reportedVersion(ctx, tmpName); err != nil {
		return Result{}, fmt.Errorf("the downloaded aiqsa-connect does not run: %w", err)
	} else if got != manifest.Version {
		return Result{}, permanentError{fmt.Errorf("the downloaded aiqsa-connect reports version %s, not %s", strconv.Quote(got), manifest.Version)}
	}
	if renameAside {
		// A failure here (for example an older .old still running) may pass
		// on a later attempt, so it is not reported as ErrNotWritable.
		if err := SwapIn(tmpName, executable); err != nil {
			return Result{}, err
		}
	} else if err := os.Rename(tmpName, executable); err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return Result{}, fmt.Errorf("%w: %s", ErrNotWritable, dir)
		}
		return Result{}, err
	}
	installed = true
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
	return Result{Version: manifest.Version, Path: executable}, nil
}

// renameAside selects the Windows way of replacing the running binary;
// tests switch it on to check that way on any system.
var renameAside = runtime.GOOS == "windows"

// NewPath is where a Windows update is downloaded: beside the binary, as
// aiqsa-connect.new.exe, so the check that runs it keeps the .exe
// extension Windows starts programs by.
func NewPath(executable string) string {
	if base, ok := strings.CutSuffix(executable, ".exe"); ok {
		return base + ".new.exe"
	}
	return executable + ".new"
}

// OldPath is where a Windows update moves the binary it replaces.
func OldPath(executable string) string { return executable + ".old" }

// createStaging creates the file the download is written to: a private
// temporary file beside the binary, or NewPath on Windows.
func createStaging(executable string) (*os.File, error) {
	if !renameAside {
		return os.CreateTemp(filepath.Dir(executable), ".aiqsa-connect.update-*")
	}
	path := NewPath(executable)
	// A download left by an interrupted attempt is replaced.
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
}

// SwapIn puts newPath in place of executable while executable may be
// running, as Windows requires: executable becomes <exe>.old (a running
// program file can be renamed but not overwritten or removed), then newPath
// takes its name. When the second rename fails, the first is undone. A
// missing executable is simply replaced. A stale <exe>.old is removed first;
// if that fails (an older process still runs from it), nothing changes.
func SwapIn(newPath, executable string) error {
	old := OldPath(executable)
	if err := os.Remove(old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("cannot remove the previous version of aiqsa-connect: %w", err)
	}
	movedAside := true
	if err := os.Rename(executable, old); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("cannot move the running aiqsa-connect aside: %w", err)
		}
		movedAside = false
	}
	if err := os.Rename(newPath, executable); err != nil {
		if movedAside {
			os.Rename(old, executable)
		}
		return fmt.Errorf("cannot put the new aiqsa-connect in place: %w", err)
	}
	if d, err := os.Open(filepath.Dir(executable)); err == nil {
		d.Sync()
		d.Close()
	}
	return nil
}

// RemoveStaleOld removes the <exe>.old a Windows update left behind. It
// fails quietly while the old process still runs from it; the next start
// tries again.
func RemoveStaleOld(executable string) {
	if executable != "" {
		os.Remove(OldPath(executable))
	}
}

func reportedVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, versionTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	cmd.Env = os.Environ()
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	version := strings.TrimSpace(string(out))
	if len(version) > 64 {
		version = version[:64]
	}
	return version, nil
}
