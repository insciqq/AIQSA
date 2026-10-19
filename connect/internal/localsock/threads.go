package localsock

import "sync"

// maxThreads bounds the thread bindings; the least recently used goes first.
const maxThreads = 256

// threads binds agent threads (Codex session ids) to the client's
// sessions. It lives in memory only: after a restart the next prompt of a
// thread binds it again.
type threads struct {
	mu    sync.Mutex
	clock uint64
	bound map[string]threadEntry
}

type threadEntry struct {
	session string
	used    uint64
}

func newThreads() *threads { return &threads{bound: map[string]threadEntry{}} }

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
