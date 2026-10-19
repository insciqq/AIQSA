// Package update replaces the running aiqsa-connect binary with the version
// its AIQSA server offers: it reads the server's client manifest, downloads
// this computer's binary from the same origin, checks it against the
// server's checksums.txt, makes sure it runs and reports that version, and
// renames it over the current binary.
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

// Target is the binary this computer runs.
func Target() (protocol.OS, protocol.Arch, error) {
	goos, arch := protocol.OS(runtime.GOOS), protocol.Arch(runtime.GOARCH)
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
	osName, arch, err := Target()
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
	tmp, err := os.CreateTemp(dir, ".aiqsa-connect.update-*")
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
	if err := os.Rename(tmpName, executable); err != nil {
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
