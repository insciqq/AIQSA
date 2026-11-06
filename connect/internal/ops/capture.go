package ops

import (
	"sync"
)

// headTail captures a stream as its first headMax bytes and its last
// tailMax bytes; total counts every byte written.
type headTail struct {
	mu      sync.Mutex
	headMax int
	tailMax int
	head    []byte
	tail    []byte // a ring of tailMax bytes once full
	start   int    // index of the oldest tail byte when full
	total   int64
}

func newHeadTail(headMax, tailMax int) *headTail {
	return &headTail{headMax: headMax, tailMax: tailMax}
}

func (c *headTail) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := len(p)
	c.total += int64(n)
	if room := c.headMax - len(c.head); room > 0 {
		take := min(room, len(p))
		c.head = append(c.head, p[:take]...)
		p = p[take:]
	}
	if len(p) == 0 || c.tailMax == 0 {
		return n, nil
	}
	if len(p) >= c.tailMax {
		c.tail = append(c.tail[:0], p[len(p)-c.tailMax:]...)
		c.start = 0
		return n, nil
	}
	if len(c.tail) < c.tailMax {
		room := c.tailMax - len(c.tail)
		take := min(room, len(p))
		c.tail = append(c.tail, p[:take]...)
		p = p[take:]
	}
	for len(p) > 0 {
		k := copy(c.tail[c.start:], p)
		p = p[k:]
		c.start = (c.start + k) % c.tailMax
	}
	return n, nil
}

// snapshot returns the head, the tail in order, whether bytes between them
// were dropped, and the total.
func (c *headTail) snapshot() (head, tail []byte, cut bool, total int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	head = append([]byte{}, c.head...)
	tail = make([]byte, 0, len(c.tail))
	tail = append(tail, c.tail[c.start:]...)
	tail = append(tail, c.tail[:c.start]...)
	cut = c.total > int64(len(c.head)+len(c.tail))
	return head, tail, cut, c.total
}

// text is the captured stream as a result carries it.
func (c *headTail) text(fallback func([]byte) string) (string, bool, int64) {
	head, tail, cut, total := c.snapshot()
	text, truncated := fitStream(head, tail, cut, c.headMax, c.tailMax, fallback)
	return text, truncated, total
}

// ring keeps the last size bytes of a background job's stream and what a
// reader has taken of it.
type ring struct {
	size  int
	buf   []byte
	start int   // index of the oldest byte when full
	total int64 // bytes ever written
	read  int64 // bytes the reader has taken, counted from the start
}

func newRing(size int) *ring { return &ring{size: size} }

// write appends p; the caller holds the job's lock.
func (r *ring) write(p []byte) {
	r.total += int64(len(p))
	if len(p) >= r.size {
		r.buf = append(r.buf[:0], p[len(p)-r.size:]...)
		r.start = 0
		return
	}
	if len(r.buf) < r.size {
		take := min(r.size-len(r.buf), len(p))
		r.buf = append(r.buf, p[:take]...)
		p = p[take:]
	}
	for len(p) > 0 {
		k := copy(r.buf[r.start:], p)
		p = p[k:]
		r.start = (r.start + k) % r.size
	}
}

// unread returns the bytes written since the last take and whether some
// of them were already overwritten; it marks them taken.
func (r *ring) take() (data []byte, lost bool) {
	held := int64(len(r.buf))
	oldest := r.total - held
	from := r.read
	if from < oldest {
		from, lost = oldest, true
	}
	ordered := append(append([]byte{}, r.buf[r.start:]...), r.buf[:r.start]...)
	data = ordered[from-oldest:]
	r.read = r.total
	return data, lost
}

func (r *ring) pending() bool { return r.read < r.total }
