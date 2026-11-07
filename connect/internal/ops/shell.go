package ops

import (
	"context"
	"crypto/rand"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// killGrace is how long a process tree has after SIGTERM before SIGKILL.
var killGrace = 3 * time.Second

// pipeGrace is how long, after a command exits, its output pipes may stay
// open (held by a process it left behind) before they are closed.
const pipeGrace = 500 * time.Millisecond

// shellEnv is added to the client's environment for every command, so
// tools neither page nor color their output.
var shellEnv = []string{"PAGER=cat", "GIT_PAGER=cat", "NO_COLOR=1", "TERM=dumb"}

// startedCommand is a started shell command.
type startedCommand struct {
	cmd     *exec.Cmd
	tree    ProcessTree
	cleanup func()
	done    chan struct{}
	err     error
	once    sync.Once
	exec    *Executor
}

// startCommand starts command in cwd with stdin closed and the streams
// going to stdout and stderr.
func (e *Executor) startCommand(command, cwd string, stdout, stderr io.Writer) (*startedCommand, protocol.ReasonCode) {
	info, err := os.Stat(cwd)
	if err != nil {
		return nil, codeOf(err)
	}
	if !info.IsDir() {
		return nil, protocol.CodeComputerNotADirectory
	}
	cmd, cleanup, err := e.sys.ShellCommand(e.Shell(), command, cwd)
	if err != nil {
		e.log.Event("shell_prepare_failed", "err", err)
		return nil, protocol.CodeDeviceError
	}
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), shellEnv...)
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = pipeGrace
	tree, err := e.sys.Start(cmd)
	if err != nil {
		cleanup()
		e.log.Event("shell_start_failed", "err", err)
		return nil, codeOf(err)
	}
	started := &startedCommand{cmd: cmd, tree: tree, cleanup: cleanup, done: make(chan struct{}), exec: e}
	go func() {
		started.err = cmd.Wait()
		close(started.done)
	}()
	return started, ""
}

// exitCode is the command's exit status; -1 when a signal ended it.
func (s *startedCommand) exitCode() int64 {
	if s.cmd.ProcessState == nil {
		return -1
	}
	return int64(s.cmd.ProcessState.ExitCode())
}

// finish ends whatever the command left running and frees its tree. It is
// called once the command exited; the processes it leaves behind are
// stopped as on cancel, in the background, and at once when the client
// stops (Close waits for it).
func (s *startedCommand) finish() {
	s.once.Do(func() {
		end := func() {
			s.tree.Kill()
			s.tree.Release()
			s.cleanup()
		}
		s.tree.Terminate()
		e := s.exec
		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			end()
			return
		}
		e.finishing.Add(1)
		e.mu.Unlock()
		go func() {
			defer e.finishing.Done()
			select {
			case <-time.After(killGrace):
			case <-e.closing:
			}
			end()
		}()
	})
}

// stop ends the whole tree: SIGTERM, then SIGKILL after killGrace, and
// waits until the command is gone.
func (s *startedCommand) stop() {
	s.once.Do(func() {
		s.tree.Terminate()
		select {
		case <-s.done:
		case <-time.After(killGrace):
		}
		s.tree.Kill()
		<-s.done
		// The command is gone; Kill reaches what it left behind.
		s.tree.Kill()
		s.tree.Release()
		s.cleanup()
	})
}

// runShell runs a foreground command until it exits or its timeout, or
// starts a background job.
func (e *Executor) runShell(ctx context.Context, runID string, args *protocol.ShellArgs, limits protocol.HelloV2Limits) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	cwd := e.resolveCwd(args.Cwd)
	if args.Background {
		return e.startJob(ctx, runID, args.Command, cwd, limits)
	}
	stdout := newHeadTail(protocol.OutputHeadBytes, protocol.OutputTailBytes)
	stderr := newHeadTail(protocol.OutputHeadBytes, protocol.OutputTailBytes)
	started := time.Now()
	command, code := e.startCommand(args.Command, cwd, stdout, stderr)
	if code != "" {
		return nil, code
	}
	timeout := time.NewTimer(time.Duration(args.TimeoutSeconds) * time.Second)
	defer timeout.Stop()
	select {
	case <-command.done:
		command.finish()
	case <-ctx.Done():
		command.stop()
		return nil, protocol.CodeComputerCancelled
	case <-timeout.C:
		command.stop()
		return nil, protocol.CodeComputerTimeout
	}
	fallback := e.sys.OutputFallback
	outText, outCut, outBytes := stdout.text(fallback)
	errText, errCut, errBytes := stderr.text(fallback)
	return &protocol.ShellResult{
		ExitCode:    command.exitCode(),
		Stdout:      outText,
		Stderr:      errText,
		Truncated:   outCut || errCut,
		StdoutBytes: outBytes,
		StderrBytes: errBytes,
		DurationMs:  time.Since(started).Milliseconds(),
	}, ""
}

// job is a background command, kept until job_stop, its run's end, its
// run's lease, StopAll or Close.
type job struct {
	id    string
	runID string
	cmd   *startedCommand

	// Guarded by Executor.mu: aborted ends a job whose start lost to its
	// run's end, StopAll or Close; lastCommand is when the server last sent
	// a command for its run.
	aborted     bool
	lastCommand time.Time

	mu      sync.Mutex
	stdout  *ring
	stderr  *ring
	changed chan struct{} // closed and replaced on new output or exit
	ended   bool
}

// jobWriter feeds one stream of a job.
type jobWriter struct {
	j      *job
	stream func(*job) *ring
}

func (w jobWriter) Write(p []byte) (int, error) {
	w.j.mu.Lock()
	w.stream(w.j).write(p)
	w.j.signalLocked()
	w.j.mu.Unlock()
	return len(p), nil
}

func (j *job) signalLocked() {
	close(j.changed)
	j.changed = make(chan struct{})
}

// stop ends the job's process tree and waits for it.
func (j *job) stop() { j.cmd.stop() }

const jobIDAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func newJobID() string {
	b := make([]byte, 12)
	rand.Read(b)
	for i := range b {
		b[i] = jobIDAlphabet[int(b[i])%len(jobIDAlphabet)]
	}
	return "job-" + string(b)
}

// startJob starts a background command; at most MaxJobs run at once. The
// job registers atomically with cancellation: when its op is cancelled or
// times out, or its run's end, StopAll or Close come while the process
// starts, the process tree is ended and no job remains.
func (e *Executor) startJob(ctx context.Context, runID, command, cwd string, limits protocol.HelloV2Limits) (protocol.Validator, protocol.ReasonCode) {
	e.mu.Lock()
	running := len(e.starting)
	for _, j := range e.jobs {
		j.mu.Lock()
		if !j.ended {
			running++
		}
		j.mu.Unlock()
	}
	if running >= limits.MaxJobs || e.closed {
		e.mu.Unlock()
		return nil, protocol.CodeComputerLimit
	}
	j := &job{id: newJobID(), runID: runID, changed: make(chan struct{})}
	j.stdout = newRing(protocol.MaxJobBufferBytes / 2)
	j.stderr = newRing(protocol.MaxJobBufferBytes / 2)
	e.starting[j] = struct{}{}
	e.mu.Unlock()
	var started *startedCommand
	code := protocol.CodeComputerCancelled
	if ctx.Err() == nil {
		started, code = e.startCommand(command, cwd,
			jobWriter{j, func(j *job) *ring { return j.stdout }},
			jobWriter{j, func(j *job) *ring { return j.stderr }})
	}
	e.mu.Lock()
	delete(e.starting, j)
	abort := j.aborted || ctx.Err() != nil || e.closed
	if code == "" && !abort {
		j.cmd = started
		j.lastCommand = time.Now()
		e.jobs[j.id] = j
		e.startLeaseLocked()
	}
	e.mu.Unlock()
	if code != "" {
		return nil, code
	}
	if abort {
		started.stop()
		e.log.Event("job_aborted")
		return nil, protocol.CodeComputerCancelled
	}
	go func() {
		<-started.done
		started.finish()
		j.mu.Lock()
		j.ended = true
		j.signalLocked()
		j.mu.Unlock()
		e.log.Event("job_ended")
	}()
	e.pruneJobs(limits.MaxJobs)
	e.log.Event("job_started")
	return &protocol.ShellJobResult{JobID: j.id}, ""
}

// pruneJobs forgets the oldest ended jobs beyond a few times the limit.
func (e *Executor) pruneJobs(maxJobs int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	keep := 4 * maxJobs
	if len(e.jobs) <= keep {
		return
	}
	for id, j := range e.jobs {
		j.mu.Lock()
		ended := j.ended
		j.mu.Unlock()
		if ended && len(e.jobs) > keep {
			delete(e.jobs, id)
		}
	}
}

func (e *Executor) findJob(id string) *job {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.jobs[id]
}

// jobOutput returns a job's output since the previous call, waiting up to
// waitSeconds for new output or its end.
func (e *Executor) jobOutput(ctx context.Context, args *protocol.JobOutputArgs) (protocol.Validator, protocol.ReasonCode) {
	j := e.findJob(args.JobID)
	if j == nil {
		return nil, protocol.CodeComputerJobNotFound
	}
	if args.WaitSeconds > 0 {
		deadline := time.NewTimer(time.Duration(args.WaitSeconds) * time.Second)
		defer deadline.Stop()
	wait:
		for {
			j.mu.Lock()
			ready := j.ended || j.stdout.pending() || j.stderr.pending()
			changed := j.changed
			j.mu.Unlock()
			if ready {
				break
			}
			select {
			case <-changed:
			case <-deadline.C:
				break wait
			case <-ctx.Done():
				return nil, protocol.CodeComputerCancelled
			}
		}
	}
	j.mu.Lock()
	// ended is set after Wait returned, so all output before the exit is in.
	ended := j.ended
	out, outLost := j.stdout.take()
	errOut, errLost := j.stderr.take()
	j.mu.Unlock()
	fallback := e.sys.OutputFallback
	outText, outCut := fitStream(out, nil, false, protocol.OutputHeadBytes, protocol.OutputTailBytes, fallback)
	errText, errCut := fitStream(errOut, nil, false, protocol.OutputHeadBytes, protocol.OutputTailBytes, fallback)
	result := &protocol.JobOutputResult{Running: !ended, Stdout: outText, Stderr: errText, Truncated: outLost || errLost || outCut || errCut}
	if ended {
		code := j.cmd.exitCode()
		result.ExitCode = &code
	}
	return result, ""
}

// jobStop stops a job; stopped is false when it had already ended.
func (e *Executor) jobStop(args *protocol.JobStopArgs) (protocol.Validator, protocol.ReasonCode) {
	j := e.findJob(args.JobID)
	if j == nil {
		return nil, protocol.CodeComputerJobNotFound
	}
	j.mu.Lock()
	wasRunning := !j.ended
	j.mu.Unlock()
	j.stop()
	return &protocol.JobStopResult{Stopped: wasRunning}, ""
}
