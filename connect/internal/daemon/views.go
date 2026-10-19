package daemon

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// viewInputQueue bounds the input chunks waiting for one PTY.
const viewInputQueue = 256

// view is one browser view: a `tmux attach` client in its own PTY.
type view struct {
	c         *connection
	id        string
	sessionID string
	// agent is set for Claude Code and Codex sessions, whose status
	// describes agent turns; input marks only those running.
	agent bool
	cmd   *exec.Cmd
	pty   *os.File
	input chan []byte
	done  chan struct{}
	// closing is set once the client closes the view or it exited.
	closing atomic.Bool
	// replies tells typing from the browser terminal's own replies; only
	// viewInput, on the stream goroutine, uses it.
	replies replyFilter

	mu      sync.Mutex
	pending []byte
	timer   *time.Timer
	seq     uint64

	// claim asks claimLoop to give this view's client the window size.
	claim chan struct{}
	// clientName is the tmux name of the attach client once found; only
	// claimLoop uses it.
	clientName string
	// claimed counts the claims done, so tests can order input after them.
	claimed atomic.Uint64
}

func (c *connection) viewByID(id string) *view {
	c.viewsMu.Lock()
	defer c.viewsMu.Unlock()
	return c.views[id]
}

// openView starts a PTY attached to the session at the browser's size.
func (c *connection) openView(m *protocol.ViewOpen) {
	c.viewsMu.Lock()
	_, duplicate := c.views[m.ViewID]
	full := len(c.views) >= c.limits.MaxViews
	c.viewsMu.Unlock()
	if duplicate {
		c.d.log.Event("view_open_ignored", "reason", "duplicate")
		return
	}
	if full {
		c.d.log.Event("view_open_refused", "reason", protocol.ViewClosedLimit)
		c.pushViewClosed(m.ViewID, protocol.ViewClosedLimit)
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	program, err := c.d.tmux.Option(ctx, m.SessionID, tmux.OptionProgram)
	cancel()
	if err != nil {
		reason := protocol.ViewClosedError
		if errors.Is(err, tmux.ErrSessionNotFound) {
			reason = protocol.ViewClosedSessionEnded
		}
		c.d.log.Event("view_open_refused", "reason", reason)
		c.pushViewClosed(m.ViewID, reason)
		return
	}
	cmd := c.d.tmux.AttachCommand(m.SessionID)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(m.Cols), Rows: uint16(m.Rows)})
	if err != nil {
		c.d.log.Event("view_open_refused", "reason", protocol.ViewClosedError, "err", err)
		c.pushViewClosed(m.ViewID, protocol.ViewClosedError)
		return
	}
	v := &view{
		c:         c,
		id:        m.ViewID,
		sessionID: m.SessionID,
		agent:     isAgent(protocol.Program(program)),
		cmd:       cmd,
		pty:       ptmx,
		input:     make(chan []byte, viewInputQueue),
		done:      make(chan struct{}),
		claim:     make(chan struct{}, 1),
	}
	c.viewsMu.Lock()
	if c.ctx.Err() != nil {
		c.viewsMu.Unlock()
		v.closing.Store(true)
		go v.readLoop()
		v.terminate()
		return
	}
	c.views[v.id] = v
	open := len(c.views)
	c.viewsMu.Unlock()
	go v.readLoop()
	go v.writeLoop()
	go v.claimLoop()
	v.claimWindowSize()
	c.d.log.Event("view_open", "views", open)
	c.kickSnapshot()
}

func (c *connection) viewInput(m *protocol.ViewInput) {
	v := c.viewByID(m.ViewID)
	if v == nil || v.closing.Load() {
		return
	}
	data := []byte(m.Data)
	select {
	case v.input <- data:
	default:
		c.d.log.Event("view_input_overflow")
		c.closeView(v, protocol.ViewClosedError)
		return
	}
	// Every byte goes to tmux, which asked for the replies; only typing
	// starts an agent turn. An answer strip shown while the agent waits for
	// approval must survive the view attaching or the mouse moving.
	if v.agent && v.replies.userInput(data) {
		c.d.reportInput(v.sessionID)
	}
}

func isAgent(program protocol.Program) bool {
	return program == protocol.ProgramClaude || program == protocol.ProgramCodex
}

func (c *connection) viewResize(m *protocol.ViewResize) {
	v := c.viewByID(m.ViewID)
	if v == nil || v.closing.Load() {
		return
	}
	if err := pty.Setsize(v.pty, &pty.Winsize{Cols: uint16(m.Cols), Rows: uint16(m.Rows)}); err != nil {
		c.d.log.Event("view_resize_failed", "err", err)
	}
	// The browser sends its size again when the view comes back on screen,
	// usually unchanged: the PTY alone then tells tmux nothing.
	v.claimWindowSize()
}

// claimWindowSize makes this view's client the most recently active one, so
// with `window-size latest` the window takes its size. Otherwise a view
// opened or shown again after a client of another size was used keeps that
// size (tmux fills the difference with dots) until its user types.
func (v *view) claimWindowSize() {
	select {
	case v.claim <- struct{}{}:
	default:
	}
}

const (
	// claimRetry is how often claimLoop looks again for an attach client
	// that has not reached the tmux server yet.
	claimRetry = 50 * time.Millisecond
	// claimTimeout bounds one claim, the wait for the client included: on
	// a busy computer a new attach client can take seconds to appear.
	claimTimeout = 15 * time.Second
)

func (v *view) claimLoop() {
	for {
		select {
		case <-v.done:
			return
		case <-v.claim:
		}
		ctx, cancel := context.WithTimeout(v.c.ctx, claimTimeout)
		err := v.claimOnce(ctx)
		cancel()
		if err == nil {
			v.claimed.Add(1)
		} else if !v.closing.Load() && v.c.ctx.Err() == nil {
			v.c.d.log.Event("view_claim_failed", "err", err)
		}
	}
}

var errClientNotAttached = errors.New("attach client not found")

// claimOnce switches the view's client to its own session, which tmux counts
// as that client's activity, so the window is resized for it. -E leaves the
// session environment alone and -Z keeps a zoomed pane zoomed.
func (v *view) claimOnce(ctx context.Context) error {
	if v.clientName == "" {
		name, err := v.findClient(ctx)
		if err != nil {
			return err
		}
		v.clientName = name
	}
	_, err := v.tmuxCommand(ctx, "switch-client", "-E", "-Z", "-c", v.clientName, "-t", "="+v.sessionID)
	return err
}

// findClient waits for the view's attach client to reach the server and
// returns its tmux name.
func (v *view) findClient(ctx context.Context) (string, error) {
	if v.cmd.Process == nil {
		return "", errClientNotAttached
	}
	pid := strconv.Itoa(v.cmd.Process.Pid)
	for {
		out, err := v.tmuxCommand(ctx, "list-clients", "-F", "#{client_pid} #{client_name}")
		if err != nil {
			return "", err
		}
		scanner := bufio.NewScanner(bytes.NewReader(out))
		for scanner.Scan() {
			if p, name, ok := strings.Cut(scanner.Text(), " "); ok && p == pid && name != "" {
				return name, nil
			}
		}
		select {
		case <-ctx.Done():
			return "", errClientNotAttached
		case <-v.done:
			return "", errClientNotAttached
		case <-time.After(claimRetry):
		}
	}
}

// tmuxCommand runs one command against the client's tmux server. Its stderr
// is not kept: it can quote session content.
func (v *view) tmuxCommand(ctx context.Context, args ...string) ([]byte, error) {
	m := v.c.d.tmux
	cmd := exec.CommandContext(ctx, m.Binary(), append([]string{"-u", "-L", m.Socket(), "-f", m.ConfigPath()}, args...)...)
	cmd.Env = tmux.Environ()
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return nil, &tmux.CommandError{Err: err}
	}
	return out, nil
}

// closeView closes a view on the client's side: its pending output is
// dropped, its attach client is ended (the session survives) and, unless
// reason is empty, the server is told why.
func (c *connection) closeView(v *view, reason protocol.ViewClosedReason) {
	if !v.closing.CompareAndSwap(false, true) {
		return
	}
	c.viewsMu.Lock()
	delete(c.views, v.id)
	c.viewsMu.Unlock()
	v.mu.Lock()
	if v.timer != nil {
		v.timer.Stop()
		v.timer = nil
	}
	v.pending = nil
	v.mu.Unlock()
	c.out.dropView(v.id)
	if reason != "" {
		c.pushViewClosed(v.id, reason)
	}
	v.terminate()
	c.d.log.Event("view_closed", "reason", reasonOrNone(reason))
	c.kickSnapshot()
}

func reasonOrNone(reason protocol.ViewClosedReason) protocol.ViewClosedReason {
	if reason == "" {
		return "server"
	}
	return reason
}

func (c *connection) closeAllViews() {
	c.viewsMu.Lock()
	views := make([]*view, 0, len(c.views))
	for _, v := range c.views {
		views = append(views, v)
	}
	c.viewsMu.Unlock()
	for _, v := range views {
		c.closeView(v, "")
	}
	deadline := time.After(5 * time.Second)
	for _, v := range views {
		select {
		case <-v.done:
		case <-deadline:
			return
		}
	}
}

// terminate hangs up the attach client and kills it if it lingers.
func (v *view) terminate() {
	if v.cmd.Process == nil {
		return
	}
	v.cmd.Process.Signal(syscall.SIGHUP)
	go func() {
		select {
		case <-v.done:
		case <-time.After(2 * time.Second):
			v.cmd.Process.Kill()
		}
	}()
}

// readLoop copies PTY output into the coalescing buffer until the attach
// client exits.
func (v *view) readLoop() {
	buf := make([]byte, coalesceBytes)
	for {
		n, err := v.pty.Read(buf)
		if n > 0 {
			v.addOutput(buf[:n])
		}
		if err != nil {
			break
		}
	}
	waitErr := v.cmd.Wait()
	v.flush()
	v.pty.Close()
	close(v.done)
	v.exited(waitErr)
}

func (v *view) writeLoop() {
	for {
		select {
		case <-v.done:
			return
		case data := <-v.input:
			if _, err := v.pty.Write(data); err != nil {
				return
			}
		}
	}
}

// exited reports a view whose attach client ended on its own.
func (v *view) exited(waitErr error) {
	c := v.c
	if !v.closing.CompareAndSwap(false, true) {
		return
	}
	c.viewsMu.Lock()
	delete(c.views, v.id)
	c.viewsMu.Unlock()
	reason := protocol.ViewClosedDetached
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	exists, err := c.d.tmux.Exists(ctx, v.sessionID)
	cancel()
	switch {
	case err == nil && !exists:
		reason = protocol.ViewClosedSessionEnded
	case err != nil || waitErr != nil:
		reason = protocol.ViewClosedError
	}
	c.pushViewClosed(v.id, reason)
	c.d.log.Event("view_exited", "reason", reason)
	c.kickSnapshot()
}

func (v *view) addOutput(p []byte) {
	v.mu.Lock()
	if v.closing.Load() {
		v.mu.Unlock()
		return
	}
	v.pending = append(v.pending, p...)
	overflow := false
	if len(v.pending) >= coalesceBytes {
		overflow = v.flushLocked()
	} else if v.timer == nil {
		v.timer = time.AfterFunc(v.c.d.timing.CoalesceDelay, v.flush)
	}
	v.mu.Unlock()
	if overflow {
		v.c.closeView(v, protocol.ViewClosedLimit)
	}
}

func (v *view) flush() {
	v.mu.Lock()
	overflow := v.flushLocked()
	v.mu.Unlock()
	if overflow {
		v.c.closeView(v, protocol.ViewClosedLimit)
	}
}

// chunkBytes is the largest output chunk that fits the announced limits:
// at most maxOutputChunkBytes, and its event must fit a batch body.
func (c *connection) chunkBytes() int {
	const eventOverhead = 160
	fit := (c.maxBatchBytes() - api.BatchOverhead - eventOverhead) / 4 * 3
	return max(1, min(c.limits.MaxOutputChunkBytes, fit))
}

// flushLocked turns the pending bytes into output events with consecutive
// seq values; overflow reports that the view's backlog is over its bound.
func (v *view) flushLocked() (overflow bool) {
	if v.timer != nil {
		v.timer.Stop()
		v.timer = nil
	}
	if v.closing.Load() {
		v.pending = nil
		return false
	}
	chunk := v.c.chunkBytes()
	for len(v.pending) > 0 {
		n := min(len(v.pending), chunk)
		event := &protocol.OutputEvent{
			Type:   protocol.EventOutput,
			ViewID: v.id,
			Seq:    v.seq,
			Data:   protocol.Bytes(append([]byte(nil), v.pending[:n]...)),
		}
		data, err := api.Marshal(event)
		if err != nil {
			break
		}
		if err := v.c.out.push(&outItem{data: data, viewID: v.id, bytes: n}); err != nil {
			v.pending = nil
			return true
		}
		v.seq++
		v.pending = v.pending[n:]
	}
	v.pending = nil
	return false
}
