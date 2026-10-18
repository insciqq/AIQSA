// Package daemon is the main loop of `aiqsa-connect up`: it keeps the
// device stream to AIQSA open, runs server commands against the client's
// tmux sessions, streams PTY views and posts events serially.
package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// Updater is told the server's version and the minimum client version after
// every `hello`, and again when the server refuses this client as outdated
// (then with the values of the last hello, or empty strings when none was
// received). It runs on the stream goroutine and must return quickly,
// starting any download in the background.
type Updater interface {
	OnServerVersion(server, minClient string)
}

// NoopUpdater ignores server versions.
type NoopUpdater struct{}

func (NoopUpdater) OnServerVersion(string, string) {}

var (
	// ErrRevoked means the server no longer accepts this device's token.
	ErrRevoked = errors.New("device revoked — run aiqsa-connect login")
	// ErrReplaced means another process connected as this device.
	ErrReplaced = errors.New("another aiqsa-connect process is connected as this device")
)

// Timing holds the daemon's intervals; zero fields take the defaults.
type Timing struct {
	// IdleTimeout ends a stream that delivered no event for this long.
	IdleTimeout time.Duration
	// BackoffMin and BackoffMax bound the reconnect delay (with jitter).
	BackoffMin, BackoffMax time.Duration
	// StableAfter resets the backoff once a stream stayed up this long.
	StableAfter time.Duration
	// DisabledRetry is the wait after the server reports AIQSA Connect off.
	DisabledRetry time.Duration
	// PollInterval is the tmux snapshot poll.
	PollInterval time.Duration
	// CoalesceDelay is how long output is collected after its first byte.
	CoalesceDelay time.Duration
	// RetryMin and RetryMax bound retries of a failed event POST.
	RetryMin, RetryMax time.Duration
	// MaxPendingViewBytes bounds one view's unsent output.
	MaxPendingViewBytes int
}

// DefaultTiming are the production intervals.
func DefaultTiming() Timing {
	return Timing{
		IdleTimeout:         45 * time.Second,
		BackoffMin:          time.Second,
		BackoffMax:          30 * time.Second,
		StableAfter:         60 * time.Second,
		DisabledRetry:       10 * time.Minute,
		PollInterval:        2 * time.Second,
		CoalesceDelay:       16 * time.Millisecond,
		RetryMin:            250 * time.Millisecond,
		RetryMax:            5 * time.Second,
		MaxPendingViewBytes: 8 << 20,
	}
}

func (t Timing) withDefaults() Timing {
	d := DefaultTiming()
	fill := func(v *time.Duration, def time.Duration) {
		if *v <= 0 {
			*v = def
		}
	}
	fill(&t.IdleTimeout, d.IdleTimeout)
	fill(&t.BackoffMin, d.BackoffMin)
	fill(&t.BackoffMax, d.BackoffMax)
	fill(&t.StableAfter, d.StableAfter)
	fill(&t.DisabledRetry, d.DisabledRetry)
	fill(&t.PollInterval, d.PollInterval)
	fill(&t.CoalesceDelay, d.CoalesceDelay)
	fill(&t.RetryMin, d.RetryMin)
	fill(&t.RetryMax, d.RetryMax)
	if t.MaxPendingViewBytes <= 0 {
		t.MaxPendingViewBytes = d.MaxPendingViewBytes
	}
	return t
}

// coalesceBytes flushes a view's output early once this much is pending.
const coalesceBytes = 32 << 10

// Options configure a Daemon.
type Options struct {
	Credentials config.Credentials
	Paths       config.Paths
	Version     string
	Tmux        *tmux.Manager
	Log         *logx.Logger
	Updater     Updater
	// Notices receives short user-facing lines (stderr for `up`).
	Notices io.Writer
	// HTTPClient replaces the default device API client (tests).
	HTTPClient *http.Client
	// Home is the user's home directory; empty uses os.UserHomeDir.
	Home   string
	Timing Timing
}

// Daemon is one running `up`.
type Daemon struct {
	api     *api.Client
	tmux    *tmux.Manager
	log     *logx.Logger
	updater Updater
	notices io.Writer
	recent  *recentDirs
	home    string
	timing  Timing

	mu        sync.Mutex
	conn      *connection
	lastHello *protocol.Hello

	// reportMu serializes ReportStatus; statusMu guards status, the last
	// status known for each session.
	reportMu sync.Mutex
	statusMu sync.Mutex
	status   map[string]protocol.SessionStatus
}

// New validates the options and returns a Daemon; Run starts it.
func New(opts Options) (*Daemon, error) {
	if err := opts.Credentials.Validate(); err != nil {
		return nil, err
	}
	if opts.Tmux == nil {
		return nil, errors.New("tmux manager required")
	}
	home := opts.Home
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	version := opts.Version
	if version == "" {
		version = "dev"
	}
	client := api.New(opts.Credentials.Origin, opts.Credentials.DeviceToken, version)
	if opts.HTTPClient != nil {
		client.HTTP = opts.HTTPClient
	}
	log := opts.Log
	if log == nil {
		log = logx.Discard()
	}
	updater := opts.Updater
	if updater == nil {
		updater = NoopUpdater{}
	}
	return &Daemon{
		api:     client,
		tmux:    opts.Tmux,
		log:     log,
		updater: updater,
		notices: opts.Notices,
		recent:  &recentDirs{path: opts.Paths.RecentDirsFile()},
		home:    validHome(home),
		timing:  opts.Timing.withDefaults(),
		status:  map[string]protocol.SessionStatus{},
	}, nil
}

// Tmux is the daemon's tmux manager.
func (d *Daemon) Tmux() *tmux.Manager { return d.tmux }

// Log is the daemon's content-free log.
func (d *Daemon) Log() *logx.Logger { return d.log }

func (d *Daemon) notice(format string, args ...any) {
	if d.notices != nil {
		fmt.Fprintf(d.notices, format+"\n", args...)
	}
}

func (d *Daemon) current() *connection {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.conn
}

// Run keeps the device stream connected until ctx ends (nil), the device is
// revoked (ErrRevoked) or another process takes over (ErrReplaced).
func (d *Daemon) Run(ctx context.Context) error {
	d.log.Event("up_start")
	attempt := 0
	disabledNoticed := false
	for {
		result := d.connectOnce(ctx)
		if ctx.Err() != nil {
			d.log.Event("up_stop")
			return nil
		}
		if result.connected {
			disabledNoticed = false
			if result.duration >= d.timing.StableAfter {
				attempt = 0
			}
			if result.kind == outcomeRetry {
				d.notice("Connection to AIQSA lost; reconnecting.")
			}
		}
		switch result.kind {
		case outcomeRevoked:
			d.log.Event("up_stop", "code", protocol.CodeUnauthorized)
			return ErrRevoked
		case outcomeReplaced:
			d.log.Event("up_stop", "reason", "replaced")
			return ErrReplaced
		case outcomeDisabled:
			if !disabledNoticed {
				every := d.timing.DisabledRetry.String()
				if d.timing.DisabledRetry%time.Minute == 0 {
					every = fmt.Sprintf("%d minutes", int(d.timing.DisabledRetry/time.Minute))
				}
				d.notice("AIQSA Connect is turned off on this AIQSA server. Retrying every %s.", every)
				disabledNoticed = true
			}
			attempt = 0
			d.log.Event("reconnect_wait", "code", protocol.CodeDisabled, "delay", d.timing.DisabledRetry)
			if api.Sleep(ctx, d.timing.DisabledRetry) != nil {
				return nil
			}
			continue
		case outcomeOutdated:
			server, minClient := "", ""
			d.mu.Lock()
			if d.lastHello != nil {
				server, minClient = d.lastHello.ServerVersion, d.lastHello.MinClientVersion
			}
			d.mu.Unlock()
			d.updater.OnServerVersion(server, minClient)
		}
		delay := d.backoff(attempt)
		attempt++
		d.log.Event("reconnect_wait", "attempt", attempt, "delay", delay)
		if api.Sleep(ctx, delay) != nil {
			d.log.Event("up_stop")
			return nil
		}
	}
}

// backoff is BackoffMin·2^attempt capped at BackoffMax, with jitter in [d/2, d].
func (d *Daemon) backoff(attempt int) time.Duration {
	delay := d.timing.BackoffMin
	for range min(attempt, 30) {
		delay *= 2
		if delay >= d.timing.BackoffMax {
			delay = d.timing.BackoffMax
			break
		}
	}
	half := delay / 2
	return half + rand.N(half+1)
}

type outcomeKind int

const (
	outcomeRetry outcomeKind = iota
	outcomeRevoked
	outcomeReplaced
	outcomeDisabled
	outcomeOutdated
)

type outcome struct {
	kind      outcomeKind
	connected bool
	duration  time.Duration
}

// Causes a connection ends with.
var (
	errIdle           = errors.New("stream idle")
	errStreamRequired = errors.New("stream required")
	errRevokedCause   = errors.New("revoked")
	errDisabledCause  = errors.New("disabled")
	errOutdatedCause  = errors.New("outdated")
)

func kindOfCode(code protocol.ReasonCode, status int) outcomeKind {
	switch {
	case code == protocol.CodeUnauthorized || status == http.StatusUnauthorized:
		return outcomeRevoked
	case code == protocol.CodeDisabled:
		return outcomeDisabled
	case code == protocol.CodeClientOutdated || status == http.StatusUpgradeRequired:
		return outcomeOutdated
	}
	return outcomeRetry
}

type streamItem struct {
	event api.Event
	err   error
}

// connectOnce runs one stream from open to close.
func (d *Daemon) connectOnce(ctx context.Context) outcome {
	connCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	stream, err := d.api.OpenStream(connCtx)
	if err != nil {
		if apiErr, ok := api.AsError(err); ok {
			d.log.Event("stream_refused", "status", apiErr.Status, "code", apiErr.Code)
			return outcome{kind: kindOfCode(apiErr.Code, apiErr.Status)}
		}
		d.log.Event("stream_failed", "err", err)
		return outcome{kind: outcomeRetry}
	}
	defer stream.Close()
	items := make(chan streamItem)
	go func() {
		for {
			event, err := stream.Next()
			select {
			case items <- streamItem{event: event, err: err}:
			case <-connCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	idle := time.NewTimer(d.timing.IdleTimeout)
	defer idle.Stop()
	var conn *connection
	var connectedAt time.Time
	finish := func(kind outcomeKind) outcome {
		cancel(nil)
		result := outcome{kind: kind}
		if conn != nil {
			d.mu.Lock()
			if d.conn == conn {
				d.conn = nil
			}
			d.mu.Unlock()
			conn.stop()
			result.connected = true
			result.duration = time.Since(connectedAt)
			d.log.Event("stream_closed", "seconds", int(result.duration.Seconds()))
		}
		return result
	}
	for {
		select {
		case <-connCtx.Done():
			switch context.Cause(connCtx) {
			case errRevokedCause:
				return finish(outcomeRevoked)
			case errDisabledCause:
				return finish(outcomeDisabled)
			case errOutdatedCause:
				return finish(outcomeOutdated)
			case errStreamRequired:
				d.log.Event("stream_reconnect", "code", protocol.CodeStreamRequired)
			case errIdle:
				d.log.Event("stream_idle")
			}
			return finish(outcomeRetry)
		case <-idle.C:
			cancel(errIdle)
		case item := <-items:
			if item.err != nil {
				d.log.Event("stream_ended", "err", item.err)
				return finish(outcomeRetry)
			}
			idle.Reset(d.timing.IdleTimeout)
			if conn == nil {
				hello, ok := d.decodeHello(item.event)
				if !ok {
					return finish(outcomeRetry)
				}
				conn = newConnection(d, connCtx, cancel, hello.Limits)
				connectedAt = time.Now()
				d.mu.Lock()
				d.conn = conn
				d.lastHello = hello
				d.mu.Unlock()
				d.log.Event("stream_open", "max_views", hello.Limits.MaxViews, "max_events", hello.Limits.MaxEventsPerPost)
				d.notice("Connected to %s.", d.api.Origin)
				d.updater.OnServerVersion(hello.ServerVersion, hello.MinClientVersion)
				conn.start()
				continue
			}
			if kind, done := d.handleStreamEvent(conn, item.event); done {
				return finish(kind)
			}
		}
	}
}

func (d *Daemon) decodeHello(event api.Event) (*protocol.Hello, bool) {
	if event.Name != protocol.StreamEventHello {
		d.log.Event("stream_protocol_error", "reason", "hello_expected")
		return nil, false
	}
	var hello protocol.Hello
	if err := protocol.Decode(event.Data, &hello); err != nil {
		d.log.Event("stream_protocol_error", "reason", "hello_invalid")
		return nil, false
	}
	return &hello, true
}

// handleStreamEvent handles one event after hello; done ends the stream.
func (d *Daemon) handleStreamEvent(conn *connection, event api.Event) (outcomeKind, bool) {
	switch event.Name {
	case protocol.StreamEventCommand:
		conn.handleCommand(event.Data)
	case protocol.StreamEventPing:
	case protocol.StreamEventHello:
		d.log.Event("stream_hello_repeated")
	case protocol.StreamEventReplaced:
		d.log.Event("stream_replaced")
		return outcomeReplaced, true
	case protocol.StreamEventClosed:
		var closed protocol.DeviceStreamClosed
		if err := protocol.Decode(event.Data, &closed); err != nil {
			d.log.Event("stream_closed_by_server", "code", "invalid")
			return outcomeRetry, true
		}
		d.log.Event("stream_closed_by_server", "code", closed.Code)
		return kindOfCode(closed.Code, 0), true
	default:
		d.log.Event("stream_event_ignored")
	}
	return outcomeRetry, false
}
