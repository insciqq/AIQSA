package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/update"
)

func init() {
	register(command{
		name:    "update",
		usage:   "update",
		summary: "Install the client version your AIQSA server offers",
		run:     runUpdate,
	})
	updater = &autoUpdater{}
}

// updateExec replaces the process with the updated binary; tests replace it.
var updateExec = syscall.Exec

// newUpdateClient is the update source for an origin; tests replace it.
var newUpdateClient = func(origin string) updateSource {
	return &update.Client{Origin: origin, Version: version, HTTP: api.NewHTTPClient()}
}

type updateSource interface {
	Manifest(ctx context.Context) (protocol.ClientManifest, error)
	Install(ctx context.Context, executable, want string) (update.Result, error)
}

func runUpdate(inv *invocation) int {
	if len(inv.args) > 0 {
		fmt.Fprintln(inv.stderr, "Usage: aiqsa-connect update")
		return 2
	}
	if version == "dev" {
		fmt.Fprintln(inv.stderr, "aiqsa-connect update: this is a development build; reinstall with the install command shown in AIQSA → AIQSA Connect.")
		return 1
	}
	paths, err := config.ResolvePaths()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect update: %v\n", err)
		return 1
	}
	creds, err := paths.LoadCredentials()
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect update: %v\n", err)
		return 1
	}
	source := newUpdateClient(creds.Origin)
	manifest, err := source.Manifest(inv.ctx)
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect update: %v\n", err)
		return 1
	}
	if manifest.Version == version {
		fmt.Fprintf(inv.stdout, "aiqsa-connect %s is the version %s offers.\n", version, creds.Origin)
		return 0
	}
	executable := selfExecutable()
	if executable == "" {
		fmt.Fprintln(inv.stderr, "aiqsa-connect update: cannot find this program's own file")
		return 1
	}
	result, err := source.Install(inv.ctx, executable, manifest.Version)
	if err != nil {
		fmt.Fprintf(inv.stderr, "aiqsa-connect update: %s\n", updateFailure(err))
		return 1
	}
	fmt.Fprintf(inv.stdout, "Updated aiqsa-connect from %s to %s (%s).\n", version, result.Version, result.Path)
	fmt.Fprintln(inv.stdout, "A running aiqsa-connect up keeps the old version until it restarts; aiqsa-connect service install restarts the service.")
	return 0
}

func updateFailure(err error) string {
	if errors.Is(err, update.ErrNotWritable) {
		return fmt.Sprintf("%v; reinstall aiqsa-connect into a directory you own with the install command shown in AIQSA → AIQSA Connect", err)
	}
	return err.Error()
}

// upBinder is the part of the updater `up` drives: it learns the origin and
// how to stop the daemon, and after the daemon stopped for an installed
// update it re-executes the new binary.
type upBinder interface {
	bindUp(ctx context.Context, stop context.CancelFunc, origin string, log *logx.Logger, notices io.Writer)
	restartUpdated(stderr io.Writer) (code int, restarted bool)
}

// autoUpdater makes the client follow its server's version, older or newer:
// after a hello announcing another version it installs that version in the
// background, stops the daemon and re-executes itself with the same
// arguments. tmux sessions keep running; browser views reconnect. A
// development build never updates itself or installs a development build.
type autoUpdater struct {
	mu        sync.Mutex
	ctx       context.Context
	stop      context.CancelFunc
	source    updateSource
	log       *logx.Logger
	notices   io.Writer
	now       func() time.Time
	attempts  map[string]updateAttempts
	busy      bool
	installed string
}

// updateAttempts is what the updater remembers about one announced server
// version: a permanent failure ends the attempts, any other failure delays
// the next one.
type updateAttempts struct {
	permanent bool
	failures  int
	retryAt   time.Time
}

// Pauses before an automatic update is tried again after a failure that may
// pass (network, timeouts, refusals): doubling from updateRetryMin up to
// updateRetryMax and never giving up, so a client its server refuses as
// outdated catches up once the server answers again.
const (
	updateRetryMin = 5 * time.Minute
	updateRetryMax = time.Hour
)

func updateRetryDelay(failures int) time.Duration {
	delay := updateRetryMin
	for i := 1; i < failures && delay < updateRetryMax; i++ {
		delay *= 2
	}
	return min(delay, updateRetryMax)
}

func (u *autoUpdater) bindUp(ctx context.Context, stop context.CancelFunc, origin string, log *logx.Logger, notices io.Writer) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.ctx, u.stop, u.log, u.notices = ctx, stop, log, notices
	u.source = newUpdateClient(origin)
	u.attempts = map[string]updateAttempts{}
	if u.now == nil {
		u.now = time.Now
	}
}

// OnServerVersion runs on the stream goroutine; the download runs in the
// background. It is called after every hello and every outdated refusal, so
// a failed attempt is retried on a later call once its pause is over.
func (u *autoUpdater) OnServerVersion(server, minClient string) {
	if version == "dev" || server == "dev" || server == version {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	// server is empty after an outdated refusal without a hello: the manifest names the version.
	if u.source == nil || u.busy || u.installed != "" {
		return
	}
	if previous := u.attempts[server]; previous.permanent || u.now().Before(previous.retryAt) {
		return
	}
	u.busy = true
	ctx, source, log := u.ctx, u.source, u.log
	go func() {
		executable := selfExecutable()
		var result update.Result
		var err error
		if executable == "" {
			err = errors.New("cannot find this program's own file")
		} else {
			log.Event("update_start")
			result, err = source.Install(ctx, executable, server)
		}
		u.mu.Lock()
		defer u.mu.Unlock()
		u.busy = false
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			attempts := u.attempts[server]
			attempts.permanent = executable == "" || update.Permanent(err)
			log.Event("update_failed", "not_writable", errors.Is(err, update.ErrNotWritable), "permanent", attempts.permanent)
			if attempts.permanent {
				u.notice("aiqsa-connect could not update itself: %s. It keeps running version %s.", updateFailure(err), version)
			} else {
				attempts.failures++
				delay := updateRetryDelay(attempts.failures)
				attempts.retryAt = u.now().Add(delay)
				u.notice("aiqsa-connect could not update itself: %s. It keeps running version %s and tries again in %d minutes.",
					updateFailure(err), version, int(delay/time.Minute))
			}
			u.attempts[server] = attempts
			return
		}
		log.Event("update_installed")
		u.notice("Updated aiqsa-connect from %s to %s; restarting.", version, result.Version)
		u.installed = result.Path
		u.stop()
	}()
}

func (u *autoUpdater) notice(format string, args ...any) {
	if u.notices != nil {
		fmt.Fprintf(u.notices, format+"\n", args...)
	}
}

// restartUpdated re-executes the installed update with this process's
// arguments and environment; it returns only when there is none or exec
// failed (then a service manager starts the new file).
func (u *autoUpdater) restartUpdated(stderr io.Writer) (int, bool) {
	u.mu.Lock()
	path := u.installed
	u.mu.Unlock()
	if path == "" {
		return 0, false
	}
	err := updateExec(path, append([]string{path}, os.Args[1:]...), os.Environ())
	fmt.Fprintf(stderr, "aiqsa-connect: cannot restart the updated client: %v\n", err)
	return 1, true
}
