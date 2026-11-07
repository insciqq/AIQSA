// Package ops runs the agent's operations on this computer: shell commands
// and background jobs, reading, writing, editing and searching files, and
// the folder picker's stat, list_dirs and recent_dirs. Each op runs with its
// own deadline, at most MaxConcurrentOps at once, and stops on cancel or
// when its run ends; every process it starts is ended with its tree. A
// background job lives until job_stop, its run's end or Close, and at most
// runLease after the server last sent a command for its run.
//
// Nothing an op handles (commands, paths, content, output) reaches the log:
// only the op kind, the reply code, the duration and byte counts.
package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// Options configure an Executor.
type Options struct {
	// Home is the user's home directory, an absolute path.
	Home string
	// RecentFile persists the recent working directories; empty keeps them in memory.
	RecentFile string
	Log        *logx.Logger
	// System replaces the operating system (tests); nil uses Native().
	System System
}

// Causes an op's context ends with.
var (
	errCancelled = errors.New("cancelled by the server")
	errRunEnded  = errors.New("run ended")
	errClosed    = errors.New("client stopping")
	errStopped   = errors.New("stopped by the client")
	errDeadline  = errors.New("deadline")
)

// runLease is how long a background job outlives the last command (op,
// job_output, job_stop) the server sent for its run. run_ended normally ends
// it long before; the lease covers a run_ended that never arrives (the
// server restarted while this computer was offline).
const runLease = 2 * time.Hour

// Executor runs ops. It outlives device streams: background jobs keep
// running across a reconnect and end with their run, their run's lease,
// StopAll or Close.
type Executor struct {
	sys    System
	goos   string
	home   string
	log    *logx.Logger
	recent *recentDirs

	shellOnce sync.Once
	shell     Shell

	// writing holds a token while a write or edit runs (lockWrites).
	writing chan struct{}
	// inPlace is where a write in place opens files and backups: osFiles,
	// or a fake in tests.
	inPlace inPlaceFiles

	mu      sync.Mutex
	limits  protocol.HelloV2Limits
	running map[string]*runningOp
	jobs    map[string]*job
	// starting holds the background jobs whose process is being started.
	// EndRun, StopAll and Close mark them aborted under mu, and the starter
	// ends the process instead of registering it; they count against MaxJobs.
	starting map[*job]struct{}
	closed   bool
	// lease is runLease; tests shorten it before the first job starts.
	lease        time.Duration
	leaseStarted bool
	wg           sync.WaitGroup

	// finishing counts what exited commands left running while it is
	// ended; closing is closed by Close to end it at once.
	finishing sync.WaitGroup
	closing   chan struct{}
	closeOnce sync.Once
}

type runningOp struct {
	runID  string
	cancel context.CancelCauseFunc
}

// New returns an Executor with the contract's default limits.
func New(opts Options) *Executor {
	sys := opts.System
	if sys == nil {
		sys = Native()
	}
	log := opts.Log
	if log == nil {
		log = logx.Discard()
	}
	return &Executor{
		sys:      sys,
		goos:     sys.GOOS(),
		home:     validHome(sys.GOOS(), opts.Home),
		log:      log,
		recent:   newRecentDirs(opts.RecentFile),
		inPlace:  osFiles{},
		writing:  make(chan struct{}, 1),
		limits:   protocol.DefaultHelloV2Limits,
		running:  map[string]*runningOp{},
		jobs:     map[string]*job{},
		starting: map[*job]struct{}{},
		lease:    runLease,
		closing:  make(chan struct{}),
	}
}

// SetLimits applies the limits of a hello to the ops that start after it.
func (e *Executor) SetLimits(limits protocol.HelloV2Limits) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.limits = limits
}

func (e *Executor) currentLimits() protocol.HelloV2Limits {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.limits
}

// Shell is the shell the shell op runs, detected once.
func (e *Executor) Shell() Shell {
	e.shellOnce.Do(func() { e.shell = e.sys.DetectShell() })
	return e.shell
}

// Start runs op in the background and calls reply once with its answer.
// No answer follows a cancel (the server stopped waiting) or Close.
func (e *Executor) Start(op *protocol.OpCommand, reply func(*protocol.OpReplyEvent)) {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	// Any command of a run renews the lease of its background jobs.
	now := time.Now()
	for _, j := range e.jobs {
		if j.runID == op.RunID {
			j.lastCommand = now
		}
	}
	if _, dup := e.running[op.RequestID]; dup {
		e.mu.Unlock()
		e.log.Event("op_duplicate", "op", op.Op)
		return
	}
	limits := e.limits
	if len(e.running) >= limits.MaxConcurrentOps {
		e.mu.Unlock()
		e.log.Event("op", "op", op.Op, "code", protocol.CodeComputerLimit)
		reply(protocol.NewOpReplyError(op.RequestID, protocol.CodeComputerLimit))
		return
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	e.running[op.RequestID] = &runningOp{runID: op.RunID, cancel: cancel}
	e.wg.Add(1)
	e.mu.Unlock()
	go func() {
		defer e.wg.Done()
		defer cancel(nil)
		started := time.Now()
		deadline := time.Duration(op.DeadlineMs) * time.Millisecond
		opCtx, stop := context.WithTimeoutCause(ctx, deadline, errDeadline)
		result, code := e.execute(opCtx, op, limits)
		// Cancel, EndRun, StopAll and Close cancel under mu, so the cause
		// read here is final for this op: a job it started whose reply will
		// not carry the job id is ended now, as the server never learns it.
		e.mu.Lock()
		delete(e.running, op.RequestID)
		cause := context.Cause(opCtx)
		var orphan *job
		if started, ok := result.(*protocol.ShellJobResult); ok && cause != nil {
			if orphan = e.jobs[started.JobID]; orphan != nil {
				delete(e.jobs, started.JobID)
			}
		}
		e.mu.Unlock()
		stop()
		if orphan != nil {
			orphan.stop()
		}
		if cause != nil {
			switch cause {
			case errCancelled, errClosed, errStopped:
				e.log.Event("op", "op", op.Op, "code", "dropped", "ms", time.Since(started).Milliseconds())
				return
			case errRunEnded:
				code = protocol.CodeComputerCancelled
			case errDeadline:
				code = protocol.CodeComputerTimeout
			}
		}
		var event *protocol.OpReplyEvent
		if code == "" {
			var err error
			if event, err = fitReply(op.RequestID, result, limits.MaxReplyBytes); err != nil {
				code = protocol.CodeDeviceError
			}
		}
		if code != "" {
			event = protocol.NewOpReplyError(op.RequestID, code)
			e.log.Event("op", "op", op.Op, "code", code, "ms", time.Since(started).Milliseconds())
		} else {
			e.log.Event("op", "op", op.Op, "ok", true, "ms", time.Since(started).Milliseconds(), "bytes", len(event.Result))
		}
		reply(event)
	}()
}

// Cancel stops the op the server stopped waiting for.
func (e *Executor) Cancel(requestID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if op := e.running[requestID]; op != nil {
		op.cancel(errCancelled)
	}
}

// EndRun stops every op and background job of a run, jobs still being
// started included.
func (e *Executor) EndRun(runID string) {
	e.mu.Lock()
	ops, jobs := e.cancelLocked(func(r string) bool { return r == runID }, errRunEnded)
	e.mu.Unlock()
	stopJobs(jobs)
	if ops+len(jobs) > 0 {
		e.log.Event("run_ended", "ops", ops, "jobs", len(jobs))
	}
}

// StopAll stops every op and background job and waits for the jobs'
// processes to end; new ops still run. The client calls it when the server
// can no longer end their runs (AIQSA Connect was turned off). Stopped ops
// are not answered.
func (e *Executor) StopAll() {
	e.mu.Lock()
	ops, jobs := e.cancelLocked(func(string) bool { return true }, errStopped)
	e.mu.Unlock()
	stopJobs(jobs)
	if ops+len(jobs) > 0 {
		e.log.Event("ops_stopped", "ops", ops, "jobs", len(jobs))
	}
}

// Close stops every op and job, waits for their processes to end and
// refuses new ops. The client calls it when it stops.
func (e *Executor) Close() {
	e.mu.Lock()
	e.closed = true
	_, jobs := e.cancelLocked(func(string) bool { return true }, errClosed)
	e.mu.Unlock()
	e.closeOnce.Do(func() { close(e.closing) })
	stopJobs(jobs)
	e.wg.Wait()
	e.finishing.Wait()
}

// cancelLocked cancels the ops of the runs match selects, marks their job
// starts aborted and takes their jobs out of e.jobs for the caller to
// stop. e.mu is held: a starting job registers under it, so none slips
// past, and an op's cause is final once it left e.running.
func (e *Executor) cancelLocked(match func(runID string) bool, cause error) (ops int, jobs []*job) {
	for _, op := range e.running {
		if match(op.runID) {
			op.cancel(cause)
			ops++
		}
	}
	for j := range e.starting {
		if match(j.runID) {
			j.aborted = true
		}
	}
	for id, j := range e.jobs {
		if match(j.runID) {
			jobs = append(jobs, j)
			delete(e.jobs, id)
		}
	}
	return ops, jobs
}

// stopJobs ends the jobs' process trees and waits for them.
func stopJobs(jobs []*job) {
	var stopped sync.WaitGroup
	for _, j := range jobs {
		stopped.Go(j.stop)
	}
	stopped.Wait()
}

// startLeaseLocked starts the lease watchdog with the first job; it runs
// until Close, which waits for it. e.mu is held.
func (e *Executor) startLeaseLocked() {
	if e.leaseStarted || e.closed {
		return
	}
	e.leaseStarted = true
	interval := max(min(e.lease/4, time.Minute), time.Millisecond)
	e.wg.Go(func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-e.closing:
				return
			case <-ticker.C:
				e.expireLeases(time.Now())
			}
		}
	})
}

// expireLeases ends the jobs of every run that has no op running and whose
// last command is at least the lease old.
func (e *Executor) expireLeases(now time.Time) {
	e.mu.Lock()
	busy := map[string]bool{}
	for _, op := range e.running {
		busy[op.runID] = true
	}
	expired := map[string]bool{}
	for _, j := range e.jobs {
		if !busy[j.runID] && now.Sub(j.lastCommand) >= e.lease {
			expired[j.runID] = true
		}
	}
	var jobs []*job
	if len(expired) > 0 {
		_, jobs = e.cancelLocked(func(r string) bool { return expired[r] }, errRunEnded)
	}
	e.mu.Unlock()
	if len(jobs) > 0 {
		stopJobs(jobs)
		e.log.Event("run_lease_expired", "runs", len(expired), "jobs", len(jobs))
	}
}

// execute runs one op; a non-empty code is its failure.
func (e *Executor) execute(ctx context.Context, op *protocol.OpCommand, limits protocol.HelloV2Limits) (protocol.Validator, protocol.ReasonCode) {
	switch args := op.Args.(type) {
	case *protocol.ShellArgs:
		if args.TimeoutSeconds > limits.MaxShellTimeoutSeconds {
			return nil, protocol.CodeComputerLimit
		}
		return e.runShell(ctx, op.RunID, args, limits)
	case *protocol.JobOutputArgs:
		return e.jobOutput(ctx, args)
	case *protocol.JobStopArgs:
		return e.jobStop(args)
	case *protocol.ReadArgs:
		return e.read(args)
	case *protocol.WriteArgs:
		if len(args.Content) > limits.MaxWriteBytes {
			return nil, protocol.CodeComputerFileTooLarge
		}
		return e.write(ctx, args)
	case *protocol.EditArgs:
		if len(args.NewString) > limits.MaxWriteBytes || len(args.OldString) > limits.MaxWriteBytes {
			return nil, protocol.CodeComputerFileTooLarge
		}
		return e.edit(ctx, args)
	case *protocol.GlobArgs:
		return e.glob(ctx, args)
	case *protocol.GrepArgs:
		return e.grep(ctx, args)
	case *protocol.StatArgs:
		return e.stat(args)
	case *protocol.ListDirsArgs:
		return e.listDirs(args, limits.MaxListDirs)
	case *protocol.RecentDirsArgs:
		return &protocol.OpRecentDirsResult{Home: e.home, Dirs: e.recent.list(e.goos, limits.MaxRecentDirs)}, ""
	}
	return nil, protocol.CodeUnsupported
}

// resolve is the absolute form of an op's path p, relative to cwd.
func (e *Executor) resolve(cwd, p string) string {
	return resolvePath(e.goos, e.home, cwd, p)
}

// resolveCwd is the absolute form of an op's cwd: `~` and a relative cwd
// are taken from the home directory.
func (e *Executor) resolveCwd(cwd string) string {
	return resolvePath(e.goos, e.home, e.home, cwd)
}

// useCwd records an op's working directory among the recent ones.
func (e *Executor) useCwd(cwd string) {
	dir := e.resolveCwd(cwd)
	if isDir(dir) {
		if err := e.recent.add(e.goos, dir); err != nil {
			e.log.Event("recent_dirs_failed", "err", err)
		}
	}
}

// marshal is the wire's JSON: no HTML escaping, no trailing newline.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// replyOverhead is the reply envelope around a result, with a margin.
const replyOverhead = 160

// fitReply builds a successful reply within maxBytes, shrinking a large
// result (output, lines, matches) until it fits.
func fitReply(requestID string, result protocol.Validator, maxBytes int) (*protocol.OpReplyEvent, error) {
	for range 24 {
		if err := result.Validate(); err != nil {
			return nil, err
		}
		encoded, err := marshal(result)
		if err != nil {
			return nil, err
		}
		if len(encoded)+replyOverhead <= maxBytes {
			event := &protocol.OpReplyEvent{Type: protocol.EventReply, RequestID: requestID, OK: true, Result: encoded}
			return event, event.Validate()
		}
		if !shrink(result) {
			break
		}
	}
	return nil, errors.New("reply too large")
}

// shrink halves the largest part of a result; false when it cannot.
func shrink(result protocol.Validator) bool {
	half := func(s string) string {
		if s == "" {
			return s
		}
		return cutHeadTail(s, s, len(s)/4, len(s)/4+len(truncationMarker))
	}
	switch r := result.(type) {
	case *protocol.ShellResult:
		if r.Stdout == "" && r.Stderr == "" {
			return false
		}
		r.Stdout, r.Stderr, r.Truncated = half(r.Stdout), half(r.Stderr), true
	case *protocol.JobOutputResult:
		if r.Stdout == "" && r.Stderr == "" {
			return false
		}
		r.Stdout, r.Stderr, r.Truncated = half(r.Stdout), half(r.Stderr), true
	case *protocol.ReadResult:
		if r.Content == "" {
			return false
		}
		r.Content, r.Truncated = keepLines(r.Content, len(r.Content)/2), true
	case *protocol.GrepResult:
		if len(r.Matches) == 0 {
			return false
		}
		r.Matches, r.Truncated = r.Matches[:len(r.Matches)/2], true
	case *protocol.GlobResult:
		if len(r.Paths) == 0 {
			return false
		}
		r.Paths, r.Truncated = r.Paths[:len(r.Paths)/2], true
	case *protocol.ListDirsResult:
		if len(r.Dirs) == 0 {
			return false
		}
		r.Dirs, r.Truncated = r.Dirs[:len(r.Dirs)/2], true
	default:
		return false
	}
	return true
}

// keepLines keeps the whole lines of content within n bytes.
func keepLines(content string, n int) string {
	if len(content) <= n {
		return content
	}
	cut := bytes.LastIndexByte([]byte(content[:n]), '\n')
	if cut < 0 {
		return ""
	}
	return content[:cut+1]
}
