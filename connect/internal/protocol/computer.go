package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Protocol 2: the agent works on the user's computer through `op` commands.

func checkArgPath(field, value string) error {
	return checkText(field, value, MaxCwdLength)
}

func checkDevicePath(field, value string) error {
	return checkPath(field, value, DevicePathRegexp)
}

func checkInt64(field string, value, min, max int64) error {
	if value < min || value > max {
		return fmt.Errorf("%s: must be %d..%d", field, min, max)
	}
	return nil
}

func checkCount(field string, value int64) error {
	return checkInt64(field, value, 0, int64(MaxSeq))
}

func checkExitCode(field string, value int64) error {
	return checkInt64(field, value, MinExitCode, MaxExitCode)
}

func checkStream(field, value string) error {
	return checkBytesText(field, value, 0, MaxStreamOutputBytes)
}

// HelloV2Limits are the limits a protocol 2 server enforces, each at most the contract maximum.
type HelloV2Limits struct {
	MaxEventsPerPost       int `json:"maxEventsPerPost"`
	MaxEventsBodyBytes     int `json:"maxEventsBodyBytes"`
	MaxReplyBytes          int `json:"maxReplyBytes"`
	MaxWriteBytes          int `json:"maxWriteBytes"`
	MaxConcurrentOps       int `json:"maxConcurrentOps"`
	MaxJobs                int `json:"maxJobs"`
	MaxShellTimeoutSeconds int `json:"maxShellTimeoutSeconds"`
	MaxRecentDirs          int `json:"maxRecentDirs"`
	MaxListDirs            int `json:"maxListDirs"`
	HeartbeatSeconds       int `json:"heartbeatSeconds"`
}

// DefaultHelloV2Limits are the contract maxima.
var DefaultHelloV2Limits = HelloV2Limits{
	MaxEventsPerPost:       MaxEventsPerPost,
	MaxEventsBodyBytes:     MaxEventsBodyBytes,
	MaxReplyBytes:          MaxReplyBytes,
	MaxWriteBytes:          MaxWriteBytes,
	MaxConcurrentOps:       MaxConcurrentOps,
	MaxJobs:                MaxJobs,
	MaxShellTimeoutSeconds: MaxShellTimeoutSeconds,
	MaxRecentDirs:          MaxRecentDirs,
	MaxListDirs:            MaxListDirs,
	HeartbeatSeconds:       HeartbeatSeconds,
}

func (m *HelloV2Limits) UnmarshalJSON(data []byte) error {
	type plain HelloV2Limits
	return strictUnmarshal(data, (*plain)(m))
}

func (m *HelloV2Limits) Validate() error {
	return firstError(
		checkRange("maxEventsPerPost", m.MaxEventsPerPost, 1, MaxEventsPerPost),
		checkRange("maxEventsBodyBytes", m.MaxEventsBodyBytes, 1, MaxEventsBodyBytes),
		checkRange("maxReplyBytes", m.MaxReplyBytes, 1, MaxReplyBytes),
		checkRange("maxWriteBytes", m.MaxWriteBytes, 1, MaxWriteBytes),
		checkRange("maxConcurrentOps", m.MaxConcurrentOps, 1, MaxConcurrentOps),
		checkRange("maxJobs", m.MaxJobs, 1, MaxJobs),
		checkRange("maxShellTimeoutSeconds", m.MaxShellTimeoutSeconds, 1, MaxShellTimeoutSeconds),
		checkRange("maxRecentDirs", m.MaxRecentDirs, 1, MaxRecentDirs),
		checkRange("maxListDirs", m.MaxListDirs, 1, MaxListDirs),
		checkRange("heartbeatSeconds", m.HeartbeatSeconds, 1, HeartbeatSeconds),
	)
}

// HelloV2 is the first event of a protocol 2 device stream.
type HelloV2 struct {
	Protocol         int           `json:"protocol"`
	DeviceID         string        `json:"deviceId"`
	ServerVersion    string        `json:"serverVersion"`
	MinClientVersion string        `json:"minClientVersion"`
	Limits           HelloV2Limits `json:"limits"`
}

func (m *HelloV2) UnmarshalJSON(data []byte) error {
	type plain HelloV2
	return strictUnmarshal(data, (*plain)(m))
}

func (m *HelloV2) Validate() error {
	if m.Protocol != ProtocolVersion {
		return fmt.Errorf("protocol: must be %d", ProtocolVersion)
	}
	if err := m.Limits.Validate(); err != nil {
		return fmt.Errorf("limits.%w", err)
	}
	return firstError(
		checkPattern("deviceId", m.DeviceID, IDRegexp),
		checkPattern("serverVersion", m.ServerVersion, VersionRegexp),
		checkPattern("minClientVersion", m.MinClientVersion, VersionRegexp),
	)
}

// DecodeDeviceStreamEventV2 decodes the data of one protocol 2 device stream
// frame into *HelloV2, a ServerCommand of DecodeServerCommandV2, *Empty
// (ping, replaced) or *DeviceStreamClosed.
func DecodeDeviceStreamEventV2(event string, data []byte) (Validator, error) {
	var message Validator
	switch event {
	case StreamEventHello:
		message = &HelloV2{}
	case StreamEventCommand:
		return DecodeServerCommandV2(data)
	case StreamEventPing, StreamEventReplaced:
		message = &Empty{}
	case StreamEventClosed:
		message = &DeviceStreamClosed{}
	default:
		return nil, fmt.Errorf("unknown stream event %q", event)
	}
	if err := Decode(data, message); err != nil {
		return nil, err
	}
	return message, nil
}

// OpArgs are the arguments of one op. The server resolves every default
// before it sends an op, so all fields but the pointers are required.
type OpArgs interface {
	Validator
	ArgsOp() Op
}

// ShellArgs runs a command in the user's shell, starting in Cwd.
type ShellArgs struct {
	// Command is the command line: newlines and tabs allowed, never NUL.
	Command        string `json:"command"`
	Cwd            string `json:"cwd"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	// Background runs it as a job until job_stop or run_ended; the result is then ShellJobResult.
	Background bool `json:"background"`
}

func (m *ShellArgs) ArgsOp() Op { return OpShell }

func (m *ShellArgs) UnmarshalJSON(data []byte) error {
	type plain ShellArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ShellArgs) Validate() error {
	if strings.Contains(m.Command, "\x00") {
		return errors.New("command: contains NUL")
	}
	return firstError(
		checkBytesText("command", m.Command, 1, MaxCommandBytes),
		checkArgPath("cwd", m.Cwd),
		checkRange("timeoutSeconds", m.TimeoutSeconds, 1, MaxShellTimeoutSeconds),
	)
}

// JobOutputArgs asks for a background job's output since the previous call,
// waiting up to WaitSeconds for new output or the job's end.
type JobOutputArgs struct {
	JobID       string `json:"jobId"`
	WaitSeconds int    `json:"waitSeconds"`
}

func (m *JobOutputArgs) ArgsOp() Op { return OpJobOutput }

func (m *JobOutputArgs) UnmarshalJSON(data []byte) error {
	type plain JobOutputArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *JobOutputArgs) Validate() error {
	return firstError(
		checkPattern("jobId", m.JobID, JobIDRegexp),
		checkRange("waitSeconds", m.WaitSeconds, 0, MaxJobWaitSeconds),
	)
}

// JobStopArgs stops a background job and its process tree.
type JobStopArgs struct {
	JobID string `json:"jobId"`
}

func (m *JobStopArgs) ArgsOp() Op { return OpJobStop }

func (m *JobStopArgs) UnmarshalJSON(data []byte) error {
	type plain JobStopArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *JobStopArgs) Validate() error {
	return checkPattern("jobId", m.JobID, JobIDRegexp)
}

// ReadArgs reads Limit lines of a text file from line Offset (from 1).
type ReadArgs struct {
	Path   string `json:"path"`
	Cwd    string `json:"cwd"`
	Offset int    `json:"offset"`
	Limit  int    `json:"limit"`
}

func (m *ReadArgs) ArgsOp() Op { return OpRead }

func (m *ReadArgs) UnmarshalJSON(data []byte) error {
	type plain ReadArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ReadArgs) Validate() error {
	return firstError(
		checkArgPath("path", m.Path),
		checkArgPath("cwd", m.Cwd),
		checkRange("offset", m.Offset, 1, MaxLineNumber),
		checkRange("limit", m.Limit, 1, MaxReadLines),
	)
}

// WriteArgs creates or replaces a file.
type WriteArgs struct {
	Path    string `json:"path"`
	Cwd     string `json:"cwd"`
	Content string `json:"content"`
}

func (m *WriteArgs) ArgsOp() Op { return OpWrite }

func (m *WriteArgs) UnmarshalJSON(data []byte) error {
	type plain WriteArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *WriteArgs) Validate() error {
	return firstError(
		checkArgPath("path", m.Path),
		checkArgPath("cwd", m.Cwd),
		checkBytesText("content", m.Content, 0, MaxWriteBytes),
	)
}

// EditArgs replaces OldString with NewString. Without ReplaceAll, no match
// answers computer_edit_no_match and more than one computer_edit_ambiguous.
type EditArgs struct {
	Path       string `json:"path"`
	Cwd        string `json:"cwd"`
	OldString  string `json:"oldString"`
	NewString  string `json:"newString"`
	ReplaceAll bool   `json:"replaceAll"`
}

func (m *EditArgs) ArgsOp() Op { return OpEdit }

func (m *EditArgs) UnmarshalJSON(data []byte) error {
	type plain EditArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *EditArgs) Validate() error {
	return firstError(
		checkArgPath("path", m.Path),
		checkArgPath("cwd", m.Cwd),
		checkBytesText("oldString", m.OldString, 1, MaxWriteBytes),
		checkBytesText("newString", m.NewString, 0, MaxWriteBytes),
	)
}

// GlobArgs finds files by name pattern under Path, or Cwd when Path is nil.
type GlobArgs struct {
	Pattern string  `json:"pattern"`
	Cwd     string  `json:"cwd"`
	Path    *string `json:"path,omitempty"`
}

func (m *GlobArgs) ArgsOp() Op { return OpGlob }

func (m *GlobArgs) UnmarshalJSON(data []byte) error {
	type plain GlobArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *GlobArgs) Validate() error {
	if m.Path != nil {
		if err := checkArgPath("path", *m.Path); err != nil {
			return err
		}
	}
	return firstError(
		checkText("pattern", m.Pattern, MaxPatternLength),
		checkArgPath("cwd", m.Cwd),
	)
}

// GrepArgs searches file contents with an RE2 pattern; an invalid pattern
// answers computer_pattern_invalid.
type GrepArgs struct {
	Pattern    string   `json:"pattern"`
	Cwd        string   `json:"cwd"`
	Path       *string  `json:"path,omitempty"`
	Glob       *string  `json:"glob,omitempty"`
	IgnoreCase bool     `json:"ignoreCase"`
	Mode       GrepMode `json:"mode"`
	// Context is the number of lines around each match in content mode.
	Context int `json:"context"`
}

func (m *GrepArgs) ArgsOp() Op { return OpGrep }

func (m *GrepArgs) UnmarshalJSON(data []byte) error {
	type plain GrepArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *GrepArgs) Validate() error {
	if m.Path != nil {
		if err := checkArgPath("path", *m.Path); err != nil {
			return err
		}
	}
	if m.Glob != nil {
		if err := checkText("glob", *m.Glob, MaxPatternLength); err != nil {
			return err
		}
	}
	return firstError(
		checkText("pattern", m.Pattern, MaxPatternLength),
		checkArgPath("cwd", m.Cwd),
		checkEnum("mode", m.Mode, GrepModes),
		checkRange("context", m.Context, 0, MaxGrepContext),
	)
}

// StatArgs asks whether a path exists and what it is.
type StatArgs struct {
	Path string `json:"path"`
}

func (m *StatArgs) ArgsOp() Op { return OpStat }

func (m *StatArgs) UnmarshalJSON(data []byte) error {
	type plain StatArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *StatArgs) Validate() error {
	return checkArgPath("path", m.Path)
}

// ListDirsArgs lists one level of subdirectories, without hidden ones.
type ListDirsArgs struct {
	Path string `json:"path"`
}

func (m *ListDirsArgs) ArgsOp() Op { return OpListDirs }

func (m *ListDirsArgs) UnmarshalJSON(data []byte) error {
	type plain ListDirsArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ListDirsArgs) Validate() error {
	return checkArgPath("path", m.Path)
}

// RecentDirsArgs are the `{}` arguments of recent_dirs.
type RecentDirsArgs struct{}

func (m *RecentDirsArgs) ArgsOp() Op { return OpRecentDirs }

func (m *RecentDirsArgs) UnmarshalJSON(data []byte) error {
	type plain RecentDirsArgs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *RecentDirsArgs) Validate() error { return nil }

// NewOpArgs returns empty arguments of an op; false for an unknown op.
func NewOpArgs(op Op) (OpArgs, bool) {
	switch op {
	case OpShell:
		return &ShellArgs{}, true
	case OpJobOutput:
		return &JobOutputArgs{}, true
	case OpJobStop:
		return &JobStopArgs{}, true
	case OpRead:
		return &ReadArgs{}, true
	case OpWrite:
		return &WriteArgs{}, true
	case OpEdit:
		return &EditArgs{}, true
	case OpGlob:
		return &GlobArgs{}, true
	case OpGrep:
		return &GrepArgs{}, true
	case OpStat:
		return &StatArgs{}, true
	case OpListDirs:
		return &ListDirsArgs{}, true
	case OpRecentDirs:
		return &RecentDirsArgs{}, true
	}
	return nil, false
}

// OpCommand is one agent operation, answered by OpReplyEvent with the op's
// result or one of OpErrorCodes. RunID groups the operations run_ended
// stops; DeadlineMs is how long the device may work on it from receipt.
type OpCommand struct {
	Type       string `json:"type"`
	RequestID  string `json:"requestId"`
	RunID      string `json:"runId"`
	Op         Op     `json:"op"`
	Args       OpArgs `json:"args"`
	DeadlineMs int    `json:"deadlineMs"`
}

func (m *OpCommand) CommandType() string      { return CommandOp }
func (m *OpCommand) CommandRequestID() string { return m.RequestID }

func (m *OpCommand) UnmarshalJSON(data []byte) error {
	var plain struct {
		Type       string          `json:"type"`
		RequestID  string          `json:"requestId"`
		RunID      string          `json:"runId"`
		Op         Op              `json:"op"`
		Args       json.RawMessage `json:"args"`
		DeadlineMs int             `json:"deadlineMs"`
	}
	if err := strictUnmarshal(data, &plain); err != nil {
		return err
	}
	args, ok := NewOpArgs(plain.Op)
	if !ok {
		return fmt.Errorf("op: unsupported value %q", string(plain.Op))
	}
	if !isObject(plain.Args) {
		return errors.New("args: expected a JSON object")
	}
	if err := json.Unmarshal(plain.Args, args); err != nil {
		return fmt.Errorf("args: %w", err)
	}
	*m = OpCommand{Type: plain.Type, RequestID: plain.RequestID, RunID: plain.RunID, Op: plain.Op, Args: args, DeadlineMs: plain.DeadlineMs}
	return nil
}

func (m *OpCommand) Validate() error {
	if err := firstError(
		checkType(CommandOp, m.Type),
		checkPattern("requestId", m.RequestID, IDRegexp),
		checkPattern("runId", m.RunID, IDRegexp),
		checkEnum("op", m.Op, Ops),
		checkRange("deadlineMs", m.DeadlineMs, 1, MaxOpDeadlineMs),
	); err != nil {
		return err
	}
	if m.Args == nil || m.Args.ArgsOp() != m.Op {
		return fmt.Errorf("args: must be the arguments of %q", string(m.Op))
	}
	if err := m.Args.Validate(); err != nil {
		return fmt.Errorf("args.%w", err)
	}
	return nil
}

// CancelCommand tells the device the server stopped waiting for an
// operation: the device stops it and need not answer.
type CancelCommand struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
}

func (m *CancelCommand) CommandType() string { return CommandCancel }

func (m *CancelCommand) UnmarshalJSON(data []byte) error {
	type plain CancelCommand
	return strictUnmarshal(data, (*plain)(m))
}

func (m *CancelCommand) Validate() error {
	return firstError(checkType(CommandCancel, m.Type), checkPattern("requestId", m.RequestID, IDRegexp))
}

// RunEndedCommand tells the device a run is over: it stops every process
// and background job it started for the run.
type RunEndedCommand struct {
	Type  string `json:"type"`
	RunID string `json:"runId"`
}

func (m *RunEndedCommand) CommandType() string { return CommandRunEnded }

func (m *RunEndedCommand) UnmarshalJSON(data []byte) error {
	type plain RunEndedCommand
	return strictUnmarshal(data, (*plain)(m))
}

func (m *RunEndedCommand) Validate() error {
	return firstError(checkType(CommandRunEnded, m.Type), checkPattern("runId", m.RunID, IDRegexp))
}

// DecodeServerCommandV2 strictly decodes and validates one protocol 2
// server command: *OpCommand, *CancelCommand or *RunEndedCommand. An unknown
// type or op returns *UnknownCommandError, with RequestID when it carried a
// valid one so the device can answer connect_unsupported.
func DecodeServerCommandV2(data []byte) (ServerCommand, error) {
	if !isObject(data) {
		return nil, errors.New("expected a JSON object")
	}
	var probe struct {
		Type      json.RawMessage `json:"type"`
		RequestID json.RawMessage `json:"requestId"`
		Op        json.RawMessage `json:"op"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, err
	}
	var commandType string
	if err := json.Unmarshal(probe.Type, &commandType); err != nil {
		return nil, errors.New("type: required string")
	}
	unknown := func(op string) error {
		err := &UnknownCommandError{Type: commandType, Op: op}
		var requestID string
		if json.Unmarshal(probe.RequestID, &requestID) == nil && IDRegexp.MatchString(requestID) {
			err.RequestID = requestID
		}
		return err
	}
	var command ServerCommand
	switch commandType {
	case CommandOp:
		var op string
		if err := json.Unmarshal(probe.Op, &op); err != nil {
			return nil, errors.New("op: required string")
		}
		if _, ok := NewOpArgs(Op(op)); !ok {
			return nil, unknown(op)
		}
		command = &OpCommand{}
	case CommandCancel:
		command = &CancelCommand{}
	case CommandRunEnded:
		command = &RunEndedCommand{}
	default:
		return nil, unknown("")
	}
	if err := Decode(data, command); err != nil {
		return nil, err
	}
	return command, nil
}

// Op results, the `reply.result` of each op.

// ShellResult is a foreground command's result. Each stream keeps its first
// OutputHeadBytes and last OutputTailBytes; StdoutBytes and StderrBytes are
// the full sizes.
type ShellResult struct {
	ExitCode    int64  `json:"exitCode"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	Truncated   bool   `json:"truncated"`
	StdoutBytes int64  `json:"stdoutBytes"`
	StderrBytes int64  `json:"stderrBytes"`
	DurationMs  int64  `json:"durationMs"`
}

func (m *ShellResult) UnmarshalJSON(data []byte) error {
	type plain ShellResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ShellResult) Validate() error {
	return firstError(
		checkExitCode("exitCode", m.ExitCode),
		checkStream("stdout", m.Stdout),
		checkStream("stderr", m.Stderr),
		checkCount("stdoutBytes", m.StdoutBytes),
		checkCount("stderrBytes", m.StderrBytes),
		checkCount("durationMs", m.DurationMs),
	)
}

// ShellJobResult is a background command's result.
type ShellJobResult struct {
	JobID string `json:"jobId"`
}

func (m *ShellJobResult) UnmarshalJSON(data []byte) error {
	type plain ShellJobResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ShellJobResult) Validate() error {
	return checkPattern("jobId", m.JobID, JobIDRegexp)
}

// JobOutputResult is a job's output since the previous job_output; ExitCode
// is set exactly when the job is no longer running.
type JobOutputResult struct {
	Running   bool   `json:"running"`
	ExitCode  *int64 `json:"exitCode,omitempty"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated"`
}

func (m *JobOutputResult) UnmarshalJSON(data []byte) error {
	type plain JobOutputResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *JobOutputResult) Validate() error {
	if m.Running && m.ExitCode != nil {
		return errors.New("exitCode: only when not running")
	}
	if !m.Running {
		if m.ExitCode == nil {
			return errors.New("exitCode: required when not running")
		}
		if err := checkExitCode("exitCode", *m.ExitCode); err != nil {
			return err
		}
	}
	return firstError(checkStream("stdout", m.Stdout), checkStream("stderr", m.Stderr))
}

// JobStopResult says whether a running job was stopped.
type JobStopResult struct {
	Stopped bool `json:"stopped"`
}

func (m *JobStopResult) UnmarshalJSON(data []byte) error {
	type plain JobStopResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *JobStopResult) Validate() error { return nil }

// ReadResult holds lines of a text file decoded to UTF-8, each cut to
// MaxReadLineLength characters.
type ReadResult struct {
	Content    string     `json:"content"`
	StartLine  int        `json:"startLine"`
	TotalLines int        `json:"totalLines"`
	Truncated  bool       `json:"truncated"`
	Encoding   string     `json:"encoding"`
	LineEnding LineEnding `json:"lineEnding"`
}

func (m *ReadResult) UnmarshalJSON(data []byte) error {
	type plain ReadResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ReadResult) Validate() error {
	return firstError(
		checkBytesText("content", m.Content, 0, MaxReadBytes),
		checkRange("startLine", m.StartLine, 1, MaxLineNumber),
		checkRange("totalLines", m.TotalLines, 0, MaxLineNumber),
		checkPattern("encoding", m.Encoding, EncodingRegexp),
		checkEnum("lineEnding", m.LineEnding, LineEndings),
	)
}

// WriteResult reports the bytes written and whether the file is new.
type WriteResult struct {
	Bytes   int64 `json:"bytes"`
	Created bool  `json:"created"`
}

func (m *WriteResult) UnmarshalJSON(data []byte) error {
	type plain WriteResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *WriteResult) Validate() error {
	return checkCount("bytes", m.Bytes)
}

// EditResult reports how many occurrences were replaced.
type EditResult struct {
	Replacements int64 `json:"replacements"`
}

func (m *EditResult) UnmarshalJSON(data []byte) error {
	type plain EditResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *EditResult) Validate() error {
	return checkInt64("replacements", m.Replacements, 1, int64(MaxSeq))
}

// GlobResult lists matching absolute paths, most recently modified first.
type GlobResult struct {
	Paths     []string `json:"paths"`
	Truncated bool     `json:"truncated"`
}

func (m *GlobResult) UnmarshalJSON(data []byte) error {
	type plain GlobResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *GlobResult) Validate() error {
	if err := checkList("paths", m.Paths != nil, len(m.Paths), 0, MaxGlobPaths); err != nil {
		return err
	}
	for i, path := range m.Paths {
		if err := checkDevicePath(fmt.Sprintf("paths[%d]", i), path); err != nil {
			return err
		}
	}
	return nil
}

// GrepMatch is one entry of a GrepResult: only Path in files mode; Path,
// Line, Text and, on a line around a match, Context in content mode; Path
// and Count in count mode.
type GrepMatch struct {
	Path    string  `json:"path"`
	Line    *int    `json:"line,omitempty"`
	Text    *string `json:"text,omitempty"`
	Context *bool   `json:"context,omitempty"`
	Count   *int64  `json:"count,omitempty"`
}

func (m *GrepMatch) UnmarshalJSON(data []byte) error {
	type plain GrepMatch
	return strictUnmarshal(data, (*plain)(m))
}

func (m *GrepMatch) validate(mode GrepMode) error {
	if err := checkDevicePath("path", m.Path); err != nil {
		return err
	}
	switch mode {
	case GrepFiles:
		if m.Line != nil || m.Text != nil || m.Context != nil || m.Count != nil {
			return errors.New("only path in files mode")
		}
	case GrepContent:
		if m.Line == nil || m.Text == nil || m.Count != nil {
			return errors.New("path, line and text in content mode")
		}
		if m.Context != nil && !*m.Context {
			return errors.New("context: only true")
		}
		return firstError(
			checkRange("line", *m.Line, 1, MaxLineNumber),
			checkBytesText("text", *m.Text, 0, MaxLineBytes),
		)
	case GrepCount:
		if m.Count == nil || m.Line != nil || m.Text != nil || m.Context != nil {
			return errors.New("path and count in count mode")
		}
		return checkInt64("count", *m.Count, 1, int64(MaxSeq))
	}
	return nil
}

// GrepResult holds the matches of one grep in its mode.
type GrepResult struct {
	Mode      GrepMode    `json:"mode"`
	Matches   []GrepMatch `json:"matches"`
	Truncated bool        `json:"truncated"`
}

func (m *GrepResult) UnmarshalJSON(data []byte) error {
	type plain GrepResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *GrepResult) Validate() error {
	if err := checkEnum("mode", m.Mode, GrepModes); err != nil {
		return err
	}
	if err := checkList("matches", m.Matches != nil, len(m.Matches), 0, MaxGrepMatches); err != nil {
		return err
	}
	for i := range m.Matches {
		if err := m.Matches[i].validate(m.Mode); err != nil {
			return fmt.Errorf("matches[%d]: %w", i, err)
		}
	}
	return nil
}

// StatResult is `{exists: false}` or `{exists: true, path, kind, size,
// mtime}`, where path is the resolved absolute path.
type StatResult struct {
	Exists bool      `json:"exists"`
	Path   *string   `json:"path,omitempty"`
	Kind   *StatKind `json:"kind,omitempty"`
	Size   *int64    `json:"size,omitempty"`
	Mtime  *string   `json:"mtime,omitempty"`
}

func (m *StatResult) UnmarshalJSON(data []byte) error {
	type plain StatResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *StatResult) Validate() error {
	if !m.Exists {
		if m.Path != nil || m.Kind != nil || m.Size != nil || m.Mtime != nil {
			return errors.New("path, kind, size and mtime: only when it exists")
		}
		return nil
	}
	if m.Path == nil || m.Kind == nil || m.Size == nil || m.Mtime == nil {
		return errors.New("path, kind, size and mtime: required when it exists")
	}
	return firstError(
		checkDevicePath("path", *m.Path),
		checkEnum("kind", *m.Kind, StatKinds),
		checkCount("size", *m.Size),
		checkTimestamp("mtime", *m.Mtime),
	)
}

// ListDirsResult lists the names of a directory's subdirectories, sorted and
// without hidden ones. Parent is nil at a root.
type ListDirsResult struct {
	Path      string   `json:"path"`
	Parent    *string  `json:"parent" connect:"nullable"`
	Dirs      []string `json:"dirs"`
	Truncated bool     `json:"truncated"`
}

func (m *ListDirsResult) UnmarshalJSON(data []byte) error {
	type plain ListDirsResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ListDirsResult) Validate() error {
	if err := checkDevicePath("path", m.Path); err != nil {
		return err
	}
	if m.Parent != nil {
		if err := checkDevicePath("parent", *m.Parent); err != nil {
			return err
		}
	}
	if err := checkList("dirs", m.Dirs != nil, len(m.Dirs), 0, MaxListDirs); err != nil {
		return err
	}
	for i, name := range m.Dirs {
		if err := checkText(fmt.Sprintf("dirs[%d]", i), name, MaxDirNameLength); err != nil {
			return err
		}
	}
	return nil
}

// OpRecentDirsResult is the result of the recent_dirs op: the home
// directory and the working directories of recent operations, most recent
// first, as absolute paths of any supported system.
type OpRecentDirsResult struct {
	Home string   `json:"home"`
	Dirs []string `json:"dirs"`
}

func (m *OpRecentDirsResult) UnmarshalJSON(data []byte) error {
	type plain OpRecentDirsResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *OpRecentDirsResult) Validate() error {
	if err := checkDevicePath("home", m.Home); err != nil {
		return err
	}
	if err := checkList("dirs", m.Dirs != nil, len(m.Dirs), 0, MaxRecentDirs); err != nil {
		return err
	}
	for i, dir := range m.Dirs {
		if err := checkDevicePath(fmt.Sprintf("dirs[%d]", i), dir); err != nil {
			return err
		}
	}
	return nil
}

// newOpResults returns the empty result values an op may answer with; shell
// answers ShellResult in the foreground and ShellJobResult in the background.
func newOpResults(op Op) []Validator {
	switch op {
	case OpShell:
		return []Validator{&ShellResult{}, &ShellJobResult{}}
	case OpJobOutput:
		return []Validator{&JobOutputResult{}}
	case OpJobStop:
		return []Validator{&JobStopResult{}}
	case OpRead:
		return []Validator{&ReadResult{}}
	case OpWrite:
		return []Validator{&WriteResult{}}
	case OpEdit:
		return []Validator{&EditResult{}}
	case OpGlob:
		return []Validator{&GlobResult{}}
	case OpGrep:
		return []Validator{&GrepResult{}}
	case OpStat:
		return []Validator{&StatResult{}}
	case OpListDirs:
		return []Validator{&ListDirsResult{}}
	case OpRecentDirs:
		return []Validator{&OpRecentDirsResult{}}
	}
	return nil
}

// DecodeOpResult decodes a reply result against the op it answers.
func DecodeOpResult(op Op, data []byte) (Validator, error) {
	results := newOpResults(op)
	if results == nil {
		return nil, fmt.Errorf("op %q has no result", string(op))
	}
	var first error
	for _, result := range results {
		err := Decode(data, result)
		if err == nil {
			return result, nil
		}
		if first == nil {
			first = err
		}
	}
	return nil, first
}

// Protocol 2 device events.

// OpReplyEvent answers an OpCommand: `{ok: true, result}` or `{ok: false, code}`
// with one of OpErrorCodes. Its type is `reply`, as in protocol 1.
type OpReplyEvent struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	OK        bool            `json:"ok"`
	Result    json.RawMessage `json:"result,omitempty"`
	Code      *ReasonCode     `json:"code,omitempty"`
}

// NewOpReplyResult builds a successful reply; result is one of the op result types.
func NewOpReplyResult(requestID string, result Validator) (*OpReplyEvent, error) {
	if err := result.Validate(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return &OpReplyEvent{Type: EventReply, RequestID: requestID, OK: true, Result: encoded}, nil
}

// NewOpReplyError builds a failed reply with one of OpErrorCodes.
func NewOpReplyError(requestID string, code ReasonCode) *OpReplyEvent {
	return &OpReplyEvent{Type: EventReply, RequestID: requestID, OK: false, Code: &code}
}

func (m *OpReplyEvent) EventType() string { return EventReply }

func (m *OpReplyEvent) UnmarshalJSON(data []byte) error {
	type plain OpReplyEvent
	return strictUnmarshal(data, (*plain)(m))
}

func (m *OpReplyEvent) Validate() error {
	if err := firstError(checkType(EventReply, m.Type), checkPattern("requestId", m.RequestID, IDRegexp)); err != nil {
		return err
	}
	if !m.OK {
		if m.Result != nil {
			return errors.New("result: only when ok")
		}
		if m.Code == nil {
			return errors.New("code: required when not ok")
		}
		return checkEnum("code", *m.Code, OpErrorCodes)
	}
	if m.Code != nil {
		return errors.New("code: only when not ok")
	}
	if m.Result == nil {
		return errors.New("result: required when ok")
	}
	for _, op := range Ops {
		if _, err := DecodeOpResult(op, m.Result); err == nil {
			return nil
		}
	}
	return errors.New("result: matches no op result")
}

// DeviceShell is the shell the shell op runs. Version is nil when the
// device cannot tell.
type DeviceShell struct {
	Kind    ShellKind `json:"kind"`
	Name    string    `json:"name"`
	Version *string   `json:"version,omitempty"`
}

func (m *DeviceShell) UnmarshalJSON(data []byte) error {
	type plain DeviceShell
	return strictUnmarshal(data, (*plain)(m))
}

func (m *DeviceShell) Validate() error {
	if m.Version != nil {
		if err := checkText("version", *m.Version, MaxShellVersionLength); err != nil {
			return err
		}
	}
	return firstError(
		checkEnum("kind", m.Kind, ShellKinds),
		checkText("name", m.Name, MaxShellNameLength),
	)
}

// DeviceInfoEvent describes the computer; the device sends it once after
// each hello and the server keeps it in memory while the stream lives.
type DeviceInfoEvent struct {
	Type      string      `json:"type"`
	OS        OS          `json:"os"`
	OSVersion string      `json:"osVersion"`
	Arch      Arch        `json:"arch"`
	Hostname  string      `json:"hostname"`
	Home      string      `json:"home"`
	Shell     DeviceShell `json:"shell"`
}

func (m *DeviceInfoEvent) EventType() string { return EventDeviceInfo }

func (m *DeviceInfoEvent) UnmarshalJSON(data []byte) error {
	type plain DeviceInfoEvent
	return strictUnmarshal(data, (*plain)(m))
}

func (m *DeviceInfoEvent) Validate() error {
	if err := m.Shell.Validate(); err != nil {
		return fmt.Errorf("shell.%w", err)
	}
	return firstError(
		checkType(EventDeviceInfo, m.Type),
		checkEnum("os", m.OS, OSValues),
		checkText("osVersion", m.OSVersion, MaxOSVersionLength),
		checkEnum("arch", m.Arch, ArchValues),
		checkText("hostname", m.Hostname, MaxHostnameLength),
		checkDevicePath("home", m.Home),
	)
}

// DecodeDeviceEventV2 strictly decodes and validates one protocol 2 device
// event: *OpReplyEvent or *DeviceInfoEvent.
func DecodeDeviceEventV2(data []byte) (DeviceEvent, error) {
	if !isObject(data) {
		return nil, errors.New("expected a JSON object")
	}
	var probe struct {
		Type json.RawMessage `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, err
	}
	var eventType string
	if err := json.Unmarshal(probe.Type, &eventType); err != nil {
		return nil, errors.New("type: required string")
	}
	var event DeviceEvent
	switch eventType {
	case EventReply:
		event = &OpReplyEvent{}
	case EventDeviceInfo:
		event = &DeviceInfoEvent{}
	default:
		return nil, fmt.Errorf("unknown event type %q", eventType)
	}
	if err := Decode(data, event); err != nil {
		return nil, err
	}
	return event, nil
}

// EventBatchV2 is the body of a protocol 2 POST /connect-api/v1/events.
type EventBatchV2 struct {
	Events []DeviceEvent `json:"events"`
}

func (m *EventBatchV2) UnmarshalJSON(data []byte) error {
	var plain struct {
		Events []json.RawMessage `json:"events"`
	}
	if err := strictUnmarshal(data, &plain); err != nil {
		return err
	}
	if plain.Events == nil {
		m.Events = nil
		return nil
	}
	m.Events = make([]DeviceEvent, len(plain.Events))
	for i, raw := range plain.Events {
		event, err := DecodeDeviceEventV2(raw)
		if err != nil {
			return fmt.Errorf("events[%d].%w", i, err)
		}
		m.Events[i] = event
	}
	return nil
}

func (m *EventBatchV2) Validate() error {
	if err := checkList("events", m.Events != nil, len(m.Events), 1, MaxEventsPerPost); err != nil {
		return err
	}
	for i, event := range m.Events {
		if event == nil {
			return fmt.Errorf("events[%d]: required", i)
		}
		if err := event.Validate(); err != nil {
			return fmt.Errorf("events[%d].%w", i, err)
		}
	}
	return nil
}

// LegacyClientManifest is the manifest a protocol 1 client gets: what its
// strict decoder accepts, at most LegacyMaxClientTargets darwin and linux targets.
type LegacyClientManifest struct {
	Version string         `json:"version"`
	Targets []ClientTarget `json:"targets"`
}

func (m *LegacyClientManifest) UnmarshalJSON(data []byte) error {
	type plain LegacyClientManifest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *LegacyClientManifest) Validate() error {
	if err := checkPattern("version", m.Version, VersionRegexp); err != nil {
		return err
	}
	if err := checkList("targets", m.Targets != nil, len(m.Targets), 1, LegacyMaxClientTargets); err != nil {
		return err
	}
	keys := make([]string, len(m.Targets))
	for i := range m.Targets {
		if err := firstError(m.Targets[i].Validate(), checkEnum("os", m.Targets[i].OS, LegacyOSValues)); err != nil {
			return fmt.Errorf("targets[%d].%w", i, err)
		}
		keys[i] = string(m.Targets[i].OS) + "-" + string(m.Targets[i].Arch)
	}
	return checkUnique("targets", keys)
}
