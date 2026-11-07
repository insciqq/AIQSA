package ops

import (
	"context"
	"errors"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// lockWrites takes the executor's write lock, which every write and edit
// holds from its first look at its file to the end of the replacement or
// of putting the original back. The executor runs ops side by side for
// any chat of its user, and two writes in place of one file that
// interleave their writes and cuts would both succeed and leave neither
// content. A file has many names (hard links, symbolic links to it or to
// a folder on its path, another case of its name) and one that does not
// exist yet has none to tell, so writes take turns across all files: most
// take milliseconds, and a write waiting behind a long one (a file too
// large to load is read through first) waits at most until its deadline.
//
// Waiting stops when ctx ends: the op was cancelled, reached its deadline
// or the client is stopping (Close cancels every op). It then answers
// computer_timeout or computer_cancelled, and nothing was read or
// changed. unlock releases the lock.
func (e *Executor) lockWrites(ctx context.Context) (unlock func(), code protocol.ReasonCode) {
	if ctx.Err() != nil {
		return nil, ctxCode(ctx)
	}
	select {
	case e.writing <- struct{}{}:
		return func() { <-e.writing }, ""
	case <-ctx.Done():
		return nil, ctxCode(ctx)
	case <-e.closing:
		return nil, protocol.CodeComputerCancelled
	}
}

// ctxCode is the reply code of an op whose context ended: computer_timeout
// at its deadline, otherwise computer_cancelled.
func ctxCode(ctx context.Context) protocol.ReasonCode {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return protocol.CodeComputerTimeout
	}
	return protocol.CodeComputerCancelled
}
