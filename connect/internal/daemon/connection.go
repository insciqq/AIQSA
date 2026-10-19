package daemon

import (
	"bytes"
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// connection is the state of one open device stream: the limits from its
// hello, its event queue and sender, and its views. Views never outlive the
// stream.
type connection struct {
	d      *Daemon
	ctx    context.Context
	cancel context.CancelCauseFunc
	limits protocol.HelloLimits
	out    *outbox
	wg     sync.WaitGroup

	viewsMu sync.Mutex
	views   map[string]*view

	snapKick     chan struct{}
	snapMu       sync.Mutex
	lastSnapshot []byte
}

func newConnection(d *Daemon, ctx context.Context, cancel context.CancelCauseFunc, limits protocol.HelloLimits) *connection {
	return &connection{
		d:        d,
		ctx:      ctx,
		cancel:   cancel,
		limits:   limits,
		out:      newOutbox(d.timing.MaxPendingViewBytes),
		views:    map[string]*view{},
		snapKick: make(chan struct{}, 1),
	}
}

// start sends the first snapshot and starts the sender and the poll.
func (c *connection) start() {
	c.sendSnapshot(true)
	c.wg.Go(c.sendLoop)
	c.wg.Go(c.snapshotLoop)
}

// stop ends the connection: its views are closed (their attach clients are
// killed; the sessions keep running) and its goroutines finish.
func (c *connection) stop() {
	c.cancel(nil)
	c.closeAllViews()
	c.wg.Wait()
}

// push validates and enqueues one event.
func (c *connection) push(event protocol.DeviceEvent) {
	if err := event.Validate(); err != nil {
		c.d.log.Event("event_invalid", "type", event.EventType())
		return
	}
	data, err := api.Marshal(event)
	if err != nil {
		c.d.log.Event("event_invalid", "type", event.EventType())
		return
	}
	c.out.push(&outItem{data: data})
}

func (c *connection) pushViewClosed(viewID string, reason protocol.ViewClosedReason) {
	c.push(&protocol.ViewClosedEvent{Type: protocol.EventViewClosed, ViewID: viewID, Reason: reason})
}

func (c *connection) maxBatchBytes() int { return c.limits.MaxEventsBodyBytes }

// sendLoop is the single sender: one POST at a time, in queue order.
func (c *connection) sendLoop() {
	retry := c.d.timing.RetryMin
	for {
		batch := c.out.take(c.ctx, c.limits.MaxEventsPerPost, c.maxBatchBytes())
		if batch == nil {
			return
		}
		for {
			batch = c.out.live(batch)
			if len(batch) == 0 {
				break
			}
			encoded := make([][]byte, len(batch))
			for i, item := range batch {
				encoded[i] = item.data
			}
			body := api.BatchBody(encoded)
			if len(body) > c.maxBatchBytes() {
				c.d.log.Event("event_dropped", "reason", "too_large", "bytes", len(body))
				c.out.release(batch)
				break
			}
			err := c.d.api.PostEvents(c.ctx, body)
			if err == nil {
				c.out.release(batch)
				retry = c.d.timing.RetryMin
				break
			}
			if c.ctx.Err() != nil {
				return
			}
			wait := retry
			if apiErr, ok := api.AsError(err); ok {
				c.d.log.Event("events_refused", "status", apiErr.Status, "code", apiErr.Code, "events", len(batch))
				switch {
				case apiErr.Code == protocol.CodeStreamRequired || apiErr.Status == http.StatusConflict:
					c.cancel(errStreamRequired)
					return
				case kindOfCode(apiErr.Code, apiErr.Status) == outcomeRevoked:
					c.cancel(errRevokedCause)
					return
				case apiErr.Code == protocol.CodeDisabled:
					c.cancel(errDisabledCause)
					return
				case kindOfCode(apiErr.Code, apiErr.Status) == outcomeOutdated:
					c.cancel(errOutdatedCause)
					return
				case apiErr.Status == http.StatusTooManyRequests || apiErr.Status >= 500:
					wait = max(wait, apiErr.RetryAfter)
				default:
					// The server refused this batch; resending it cannot help.
					c.out.release(batch)
					batch = nil
				}
				if batch == nil {
					break
				}
			} else {
				c.d.log.Event("events_failed", "err", err, "events", len(batch))
			}
			if api.Sleep(c.ctx, wait) != nil {
				return
			}
			retry = min(retry*2, c.d.timing.RetryMax)
		}
	}
}

// kickSnapshot asks the poll loop for a snapshot now.
func (c *connection) kickSnapshot() {
	select {
	case c.snapKick <- struct{}{}:
	default:
	}
}

func (c *connection) snapshotLoop() {
	ticker := time.NewTicker(c.d.timing.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
		case <-c.snapKick:
		}
		c.sendSnapshot(false)
	}
}

// sendSnapshot lists the sessions and enqueues a snapshot when it changed
// (always when force).
func (c *connection) sendSnapshot(force bool) {
	c.snapMu.Lock()
	defer c.snapMu.Unlock()
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	list, err := c.d.tmux.List(ctx)
	if err != nil {
		if c.ctx.Err() == nil {
			c.d.log.Event("snapshot_failed", "err", err)
		}
		return
	}
	c.d.seedStatus(list)
	sessions := SnapshotSessions(list, c.d.home, c.limits.MaxSnapshotSessions)
	var data []byte
	for {
		event := &protocol.SessionsEvent{Type: protocol.EventSessions, Sessions: sessions}
		if err := event.Validate(); err != nil {
			c.d.log.Event("snapshot_invalid")
			return
		}
		data, err = api.Marshal(event)
		if err != nil {
			return
		}
		if len(data)+api.BatchOverhead <= c.maxBatchBytes() || len(sessions) == 0 {
			break
		}
		sessions = sessions[1:]
	}
	if !force && bytes.Equal(data, c.lastSnapshot) {
		return
	}
	c.lastSnapshot = data
	c.out.push(&outItem{data: data, sessions: true})
	c.d.log.Event("snapshot", "sessions", len(sessions))
}
