package daemon

import (
	"context"
	"errors"
	"sync"

	"github.com/insciqq/AIQSA/connect/internal/api"
)

// errViewOverflow means a view's pending output exceeded its bound.
var errViewOverflow = errors.New("view output backlog too large")

// outItem is one encoded event waiting to be posted.
type outItem struct {
	data     []byte
	viewID   string // set for output events
	bytes    int    // decoded output bytes counted against the view's bound
	sessions bool   // a sessions snapshot; a newer one replaces it
}

// outbox is the ordered queue between event producers and the single
// sender. Output of views closed by the client is dropped, and each view's
// pending output is bounded.
type outbox struct {
	mu           sync.Mutex
	items        []*outItem
	notify       chan struct{}
	viewBytes    map[string]int
	dropped      map[string]bool
	maxViewBytes int
}

func newOutbox(maxViewBytes int) *outbox {
	return &outbox{
		notify:       make(chan struct{}, 1),
		viewBytes:    map[string]int{},
		dropped:      map[string]bool{},
		maxViewBytes: maxViewBytes,
	}
}

// push appends an item. A snapshot replaces any snapshot still pending.
func (o *outbox) push(item *outItem) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if item.viewID != "" {
		if o.dropped[item.viewID] {
			return nil
		}
		if o.viewBytes[item.viewID]+item.bytes > o.maxViewBytes {
			return errViewOverflow
		}
		o.viewBytes[item.viewID] += item.bytes
	}
	if item.sessions {
		o.items = removeItems(o.items, func(existing *outItem) bool { return existing.sessions })
	}
	o.items = append(o.items, item)
	select {
	case o.notify <- struct{}{}:
	default:
	}
	return nil
}

// take waits for at least one item and returns the longest prefix that fits
// maxCount events and a body of maxBytes. The first item is returned even
// when it alone is too large, so the sender can drop it. It returns nil
// when ctx ends.
func (o *outbox) take(ctx context.Context, maxCount, maxBytes int) []*outItem {
	for {
		o.mu.Lock()
		if len(o.items) > 0 {
			size := api.BatchOverhead
			n := 0
			for n < len(o.items) && n < maxCount {
				next := len(o.items[n].data)
				if n > 0 {
					next++
				}
				if n > 0 && size+next > maxBytes {
					break
				}
				size += next
				n++
			}
			batch := make([]*outItem, n)
			copy(batch, o.items[:n])
			o.items = o.items[n:]
			o.mu.Unlock()
			return batch
		}
		o.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil
		case <-o.notify:
		}
	}
}

// release forgets items that were sent or dropped.
func (o *outbox) release(items []*outItem) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, item := range items {
		if item.viewID != "" && !o.dropped[item.viewID] {
			o.viewBytes[item.viewID] -= item.bytes
		}
	}
}

// dropView discards a view's pending output now and in the future.
func (o *outbox) dropView(viewID string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.dropped[viewID] = true
	delete(o.viewBytes, viewID)
	o.items = removeItems(o.items, func(item *outItem) bool { return item.viewID == viewID })
}

// live filters out output of views dropped while the batch was in flight.
func (o *outbox) live(items []*outItem) []*outItem {
	o.mu.Lock()
	defer o.mu.Unlock()
	return removeItems(items, func(item *outItem) bool { return item.viewID != "" && o.dropped[item.viewID] })
}

func (o *outbox) pending() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.items)
}

func removeItems(items []*outItem, drop func(*outItem) bool) []*outItem {
	out := items[:0:0]
	for _, item := range items {
		if !drop(item) {
			out = append(out, item)
		}
	}
	return out
}
