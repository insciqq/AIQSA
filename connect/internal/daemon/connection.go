package daemon

import (
	"context"
	"net/http"
	"sync"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// connection is the state of one open device stream: the limits from its
// hello, its event queue and its sender. Ops outlive it: a reply finished
// after the stream closed goes to the next stream, whose server ignores a
// request it no longer waits for.
type connection struct {
	d      *Daemon
	ctx    context.Context
	cancel context.CancelCauseFunc
	limits protocol.HelloV2Limits
	out    *outbox
	wg     sync.WaitGroup
}

func newConnection(d *Daemon, ctx context.Context, cancel context.CancelCauseFunc, limits protocol.HelloV2Limits) *connection {
	return &connection{d: d, ctx: ctx, cancel: cancel, limits: limits, out: newOutbox()}
}

// start sends device_info and starts the sender.
func (c *connection) start() {
	c.wg.Go(c.sendLoop)
	c.wg.Go(func() {
		info := c.d.exec.DeviceInfo()
		if c.ctx.Err() == nil {
			c.push(info)
		}
	})
}

// stop ends the connection and its goroutines.
func (c *connection) stop() {
	c.cancel(nil)
	c.wg.Wait()
}

// maxEventBytes is the largest one encoded event may be: a batch of it alone fits.
func (c *connection) maxEventBytes() int {
	return c.limits.MaxEventsBodyBytes - api.BatchOverhead
}

// push validates and enqueues one event. A reply too large for a batch is
// replaced by a connect_device_error reply.
func (c *connection) push(event protocol.DeviceEvent) {
	if err := event.Validate(); err != nil {
		c.d.log.Event("event_invalid", "type", event.EventType())
		return
	}
	data, err := api.Marshal(event)
	if err == nil && len(data) > c.maxEventBytes() {
		if reply, ok := event.(*protocol.OpReplyEvent); ok {
			c.d.log.Event("reply_too_large", "bytes", len(data))
			data, err = api.Marshal(protocol.NewOpReplyError(reply.RequestID, protocol.CodeDeviceError))
		}
	}
	if err != nil {
		c.d.log.Event("event_invalid", "type", event.EventType())
		return
	}
	c.out.push(data)
}

// sendLoop is the single sender: one POST at a time, in queue order.
func (c *connection) sendLoop() {
	retry := c.d.timing.RetryMin
	for {
		batch := c.out.take(c.ctx, c.limits.MaxEventsPerPost, c.limits.MaxEventsBodyBytes)
		if batch == nil {
			return
		}
		body := api.BatchBody(batch)
		if len(body) > c.limits.MaxEventsBodyBytes {
			c.d.log.Event("event_dropped", "reason", "too_large", "bytes", len(body))
			continue
		}
		for {
			err := c.d.api.PostEvents(c.ctx, body)
			if err == nil {
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
					wait = -1
				}
			} else {
				c.d.log.Event("events_failed", "err", err, "events", len(batch))
			}
			if wait < 0 {
				break
			}
			if api.Sleep(c.ctx, wait) != nil {
				return
			}
			retry = min(retry*2, c.d.timing.RetryMax)
		}
	}
}
