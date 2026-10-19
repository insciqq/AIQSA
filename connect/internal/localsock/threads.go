package localsock

import (
	"cmp"
	"slices"
	"sync"
	"time"
)

const (
	// maxThreads bounds the thread bindings; the least recently used goes first.
	maxThreads = 256
	// maxHeldThreads, maxHeldPerThread and heldFor bound the reports held for
	// threads that are not bound yet: a thread's later event can reach the
	// daemon before the prompt that binds it.
	maxHeldThreads   = 64
	maxHeldPerThread = 8
	heldFor          = 5 * time.Second
)

// threads binds agent threads (Codex session ids) to the client's
// sessions, and holds for a moment the reports of threads not bound. It
// lives in memory only: after a restart the next prompt of a thread binds
// it again.
type threads struct {
	mu    sync.Mutex
	clock uint64
	bound map[string]threadEntry
	held  map[string][]heldReport
	now   func() time.Time
}

type threadEntry struct {
	session string
	used    uint64
}

type heldReport struct {
	msg      Message
	received time.Time
}

func newThreads() *threads {
	return &threads{bound: map[string]threadEntry{}, held: map[string][]heldReport{}, now: time.Now}
}

// bind (re)binds thread to session.
func (t *threads) bind(thread, session string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.bound[thread]; !ok && len(t.bound) >= maxThreads {
		oldest, oldestUsed := "", ^uint64(0)
		for id, e := range t.bound {
			if e.used < oldestUsed {
				oldest, oldestUsed = id, e.used
			}
		}
		delete(t.bound, oldest)
	}
	t.clock++
	t.bound[thread] = threadEntry{session: session, used: t.clock}
}

// unbind drops the binding of a thread whose agent session ended.
func (t *threads) unbind(thread string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.bound, thread)
}

// session returns the session thread is bound to.
func (t *threads) session(thread string) (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.bound[thread]
	if !ok {
		return "", false
	}
	t.clock++
	e.used = t.clock
	t.bound[thread] = e
	return e.session, true
}

// forgetSession drops every thread bound to a session that is gone.
func (t *threads) forgetSession(session string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, e := range t.bound {
		if e.session == session {
			delete(t.bound, id)
		}
	}
}

// hold keeps the report of a thread that is not bound for heldFor, at most
// maxHeldPerThread of each thread (the newest) and of maxHeldThreads
// threads (the most recently heard).
func (t *threads) hold(msg Message) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	t.expire(now)
	reports, ok := t.held[msg.Thread]
	if !ok && len(t.held) >= maxHeldThreads {
		oldest, oldestAt := "", now
		for id, r := range t.held {
			if last := r[len(r)-1].received; oldest == "" || last.Before(oldestAt) {
				oldest, oldestAt = id, last
			}
		}
		delete(t.held, oldest)
	}
	reports = append(reports, heldReport{msg, now})
	if len(reports) > maxHeldPerThread {
		reports = slices.Delete(reports, 0, len(reports)-maxHeldPerThread)
	}
	t.held[msg.Thread] = reports
}

// take removes and returns the reports held for thread that are still
// fresh, in the order their hooks started: unstamped ones first in arrival
// order, then those of each clock (one in practice) by start.
func (t *threads) take(thread string) []Message {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.expire(t.now())
	reports := t.held[thread]
	delete(t.held, thread)
	msgs := make([]Message, 0, len(reports))
	for _, r := range reports {
		msgs = append(msgs, r.msg)
	}
	slices.SortStableFunc(msgs, func(a, b Message) int {
		sa, sb := a.Started(), b.Started()
		if !sa.Valid() || !sb.Valid() {
			return cmp.Compare(boolInt(sa.Valid()), boolInt(sb.Valid()))
		}
		return cmp.Or(cmp.Compare(sa.Kind, sb.Kind), cmp.Compare(sa.At, sb.At))
	})
	return msgs
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// expire drops held reports older than heldFor.
func (t *threads) expire(now time.Time) {
	for id, reports := range t.held {
		reports = slices.DeleteFunc(reports, func(r heldReport) bool { return now.Sub(r.received) >= heldFor })
		if len(reports) == 0 {
			delete(t.held, id)
		} else {
			t.held[id] = reports
		}
	}
}
