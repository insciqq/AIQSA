package daemon

import (
	"context"
	"sync"

	"github.com/insciqq/AIQSA/connect/internal/api"
)

// outbox is the ordered queue of encoded events between their producers
// and the single sender.
type outbox struct {
	mu     sync.Mutex
	items  [][]byte
	notify chan struct{}
}

func newOutbox() *outbox {
	return &outbox{notify: make(chan struct{}, 1)}
}

// push appends one encoded event.
func (o *outbox) push(data []byte) {
	o.mu.Lock()
	o.items = append(o.items, data)
	o.mu.Unlock()
	select {
	case o.notify <- struct{}{}:
	default:
	}
}

// take waits for at least one event and returns the longest prefix that
// fits maxCount events and a body of maxBytes. The first event is returned
// even when it alone is too large, so the sender can drop it. It returns
// nil when ctx ends.
func (o *outbox) take(ctx context.Context, maxCount, maxBytes int) [][]byte {
	for {
		o.mu.Lock()
		if len(o.items) > 0 {
			size := api.BatchOverhead
			n := 0
			for n < len(o.items) && n < maxCount {
				next := len(o.items[n])
				if n > 0 {
					next++
				}
				if n > 0 && size+next > maxBytes {
					break
				}
				size += next
				n++
			}
			batch := make([][]byte, n)
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

func (o *outbox) pending() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.items)
}
