package daemon

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// viewInputQueue bounds the input chunks waiting for one PTY.
const viewInputQueue = 256

// view is one browser view: a `tmux attach` client in its own PTY.
type view struct {
	c         *connection
	id        string
	sessionID string
	cmd       *exec.Cmd
	pty       *os.File
	input     chan []byte
	done      chan struct{}
	// closing is set once the client closes the view or it exited.
	closing atomic.Bool

	mu      sync.Mutex
	pending []byte
	timer   *time.Timer
	seq     uint64
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
	exists, err := c.d.tmux.Exists(ctx, m.SessionID)
	cancel()
	if err != nil || !exists {
		reason := protocol.ViewClosedSessionEnded
		if err != nil {
			reason = protocol.ViewClosedError
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
		cmd:       cmd,
		pty:       ptmx,
		input:     make(chan []byte, viewInputQueue),
		done:      make(chan struct{}),
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
	c.d.log.Event("view_open", "views", open)
	c.kickSnapshot()
}

func (c *connection) viewInput(m *protocol.ViewInput) {
	v := c.viewByID(m.ViewID)
	if v == nil || v.closing.Load() {
		return
	}
	select {
	case v.input <- []byte(m.Data):
	default:
		c.d.log.Event("view_input_overflow")
		c.closeView(v, protocol.ViewClosedError)
		return
	}
	c.d.reportInput(v.sessionID)
}

func (c *connection) viewResize(m *protocol.ViewResize) {
	v := c.viewByID(m.ViewID)
	if v == nil || v.closing.Load() {
		return
	}
	if err := pty.Setsize(v.pty, &pty.Winsize{Cols: uint16(m.Cols), Rows: uint16(m.Rows)}); err != nil {
		c.d.log.Event("view_resize_failed", "err", err)
	}
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
