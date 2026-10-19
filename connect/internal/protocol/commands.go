package protocol

import (
	"encoding/json"
	"fmt"
)

// ServerCommand is the data of one `command` event.
type ServerCommand interface {
	Validator
	CommandType() string
}

// RequestCommand is a command the device answers with `reply`.
type RequestCommand interface {
	ServerCommand
	CommandRequestID() string
}

// UnknownCommandError reports a command type this client does not know.
// RequestID is set when the command carried a valid requestId, so the
// client can answer `reply {ok: false, code: "connect_unsupported"}`.
type UnknownCommandError struct {
	Type      string
	RequestID string
}

func (e *UnknownCommandError) Error() string {
	return fmt.Sprintf("unknown command type %q", e.Type)
}

// DecodeServerCommand strictly decodes and validates one server command.
func DecodeServerCommand(data []byte) (ServerCommand, error) {
	if !isObject(data) {
		return nil, fmt.Errorf("expected a JSON object")
	}
	var probe struct {
		Type      json.RawMessage `json:"type"`
		RequestID json.RawMessage `json:"requestId"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, err
	}
	var commandType string
	if err := json.Unmarshal(probe.Type, &commandType); err != nil {
		return nil, fmt.Errorf("type: required string")
	}
	var command ServerCommand
	switch commandType {
	case CommandViewOpen:
		command = &ViewOpen{}
	case CommandViewInput:
		command = &ViewInput{}
	case CommandViewResize:
		command = &ViewResize{}
	case CommandViewClose:
		command = &ViewClose{}
	case CommandSessionCreate:
		command = &SessionCreate{}
	case CommandSessionKill:
		command = &SessionKill{}
	case CommandSessionHistory:
		command = &SessionHistory{}
	case CommandSessionOptions:
		command = &SessionOptions{}
	case CommandRecentDirs:
		command = &RecentDirs{}
	default:
		unknown := &UnknownCommandError{Type: commandType}
		var requestID string
		if json.Unmarshal(probe.RequestID, &requestID) == nil && IDRegexp.MatchString(requestID) {
			unknown.RequestID = requestID
		}
		return nil, unknown
	}
	if err := Decode(data, command); err != nil {
		return nil, err
	}
	return command, nil
}

// ViewOpen attaches a new view of a session at the browser's size.
type ViewOpen struct {
	Type      string `json:"type"`
	ViewID    string `json:"viewId"`
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

func (m *ViewOpen) CommandType() string { return CommandViewOpen }

func (m *ViewOpen) UnmarshalJSON(data []byte) error {
	type plain ViewOpen
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewOpen) Validate() error {
	return firstError(
		checkType(CommandViewOpen, m.Type),
		checkPattern("viewId", m.ViewID, IDRegexp),
		checkPattern("sessionId", m.SessionID, SessionIDRegexp),
		checkRange("cols", m.Cols, MinCols, MaxCols),
		checkRange("rows", m.Rows, MinRows, MaxRows),
	)
}

// ViewInput is terminal input for a view: 1..64 KiB of UTF-8.
type ViewInput struct {
	Type   string `json:"type"`
	ViewID string `json:"viewId"`
	Data   string `json:"data"`
}

func (m *ViewInput) CommandType() string { return CommandViewInput }

func (m *ViewInput) UnmarshalJSON(data []byte) error {
	type plain ViewInput
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewInput) Validate() error {
	return firstError(
		checkType(CommandViewInput, m.Type),
		checkPattern("viewId", m.ViewID, IDRegexp),
		checkBytesText("data", m.Data, 1, MaxInputBytes),
	)
}

// ViewResize resizes a view's PTY.
type ViewResize struct {
	Type   string `json:"type"`
	ViewID string `json:"viewId"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
}

func (m *ViewResize) CommandType() string { return CommandViewResize }

func (m *ViewResize) UnmarshalJSON(data []byte) error {
	type plain ViewResize
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewResize) Validate() error {
	return firstError(
		checkType(CommandViewResize, m.Type),
		checkPattern("viewId", m.ViewID, IDRegexp),
		checkRange("cols", m.Cols, MinCols, MaxCols),
		checkRange("rows", m.Rows, MinRows, MaxRows),
	)
}

// ViewClose detaches a view; the session keeps running.
type ViewClose struct {
	Type   string `json:"type"`
	ViewID string `json:"viewId"`
}

func (m *ViewClose) CommandType() string { return CommandViewClose }

func (m *ViewClose) UnmarshalJSON(data []byte) error {
	type plain ViewClose
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewClose) Validate() error {
	return firstError(
		checkType(CommandViewClose, m.Type),
		checkPattern("viewId", m.ViewID, IDRegexp),
	)
}

// SessionCreate starts a session; the reply result is SessionCreateResult.
type SessionCreate struct {
	Type      string  `json:"type"`
	RequestID string  `json:"requestId"`
	Program   Program `json:"program"`
	// Cwd is absolute, `~` or `~/…`; the client resolves it.
	Cwd   string  `json:"cwd"`
	Title *string `json:"title,omitempty"`
}

func (m *SessionCreate) CommandType() string      { return CommandSessionCreate }
func (m *SessionCreate) CommandRequestID() string { return m.RequestID }

func (m *SessionCreate) UnmarshalJSON(data []byte) error {
	type plain SessionCreate
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionCreate) Validate() error {
	if m.Title != nil {
		if err := checkText("title", *m.Title, MaxTitleLength); err != nil {
			return err
		}
	}
	return firstError(
		checkType(CommandSessionCreate, m.Type),
		checkPattern("requestId", m.RequestID, IDRegexp),
		checkEnum("program", m.Program, Programs),
		checkPath("cwd", m.Cwd, RequestedCwdRegexp),
	)
}

// SessionKill ends a session; the reply result is SessionKillResult.
type SessionKill struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId"`
}

func (m *SessionKill) CommandType() string      { return CommandSessionKill }
func (m *SessionKill) CommandRequestID() string { return m.RequestID }

func (m *SessionKill) UnmarshalJSON(data []byte) error {
	type plain SessionKill
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionKill) Validate() error {
	return validateSessionRequest(CommandSessionKill, m.Type, m.RequestID, m.SessionID)
}

// SessionHistory asks for the session's plain-text scrollback; the reply result is SessionHistoryResult.
type SessionHistory struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId"`
}

func (m *SessionHistory) CommandType() string      { return CommandSessionHistory }
func (m *SessionHistory) CommandRequestID() string { return m.RequestID }

func (m *SessionHistory) UnmarshalJSON(data []byte) error {
	type plain SessionHistory
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionHistory) Validate() error {
	return validateSessionRequest(CommandSessionHistory, m.Type, m.RequestID, m.SessionID)
}

// SessionOptions asks for the agent's numbered menu; the reply result is SessionOptionsResult.
type SessionOptions struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId"`
}

func (m *SessionOptions) CommandType() string      { return CommandSessionOptions }
func (m *SessionOptions) CommandRequestID() string { return m.RequestID }

func (m *SessionOptions) UnmarshalJSON(data []byte) error {
	type plain SessionOptions
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionOptions) Validate() error {
	return validateSessionRequest(CommandSessionOptions, m.Type, m.RequestID, m.SessionID)
}

// RecentDirs asks for the device's recent directories; the reply result is RecentDirsResult.
type RecentDirs struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
}

func (m *RecentDirs) CommandType() string      { return CommandRecentDirs }
func (m *RecentDirs) CommandRequestID() string { return m.RequestID }

func (m *RecentDirs) UnmarshalJSON(data []byte) error {
	type plain RecentDirs
	return strictUnmarshal(data, (*plain)(m))
}

func (m *RecentDirs) Validate() error {
	return firstError(
		checkType(CommandRecentDirs, m.Type),
		checkPattern("requestId", m.RequestID, IDRegexp),
	)
}

func validateSessionRequest(want, got, requestID, sessionID string) error {
	return firstError(
		checkType(want, got),
		checkPattern("requestId", requestID, IDRegexp),
		checkPattern("sessionId", sessionID, SessionIDRegexp),
	)
}

// Command results.

// SessionCreateResult is the result of `session_create`.
type SessionCreateResult struct {
	SessionID string `json:"sessionId"`
}

func (m *SessionCreateResult) UnmarshalJSON(data []byte) error {
	type plain SessionCreateResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionCreateResult) Validate() error {
	return checkPattern("sessionId", m.SessionID, SessionIDRegexp)
}

// SessionHistoryResult is the result of `session_history`: at most 768 KiB of UTF-8.
type SessionHistoryResult struct {
	Text string `json:"text"`
}

func (m *SessionHistoryResult) UnmarshalJSON(data []byte) error {
	type plain SessionHistoryResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionHistoryResult) Validate() error {
	return checkBytesText("text", m.Text, 0, MaxHistoryBytes)
}

// SessionOption is one numbered menu choice; Key is sent as input.
type SessionOption struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

func (m *SessionOption) UnmarshalJSON(data []byte) error {
	type plain SessionOption
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionOption) Validate() error {
	return firstError(
		checkPattern("key", m.Key, OptionKeyRegexp),
		checkText("label", m.Label, MaxOptionLabelLength),
	)
}

// SessionOptionsResult is the result of `session_options`.
type SessionOptionsResult struct {
	Options []SessionOption `json:"options"`
}

func (m *SessionOptionsResult) UnmarshalJSON(data []byte) error {
	type plain SessionOptionsResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionOptionsResult) Validate() error {
	if err := checkList("options", m.Options != nil, len(m.Options), 0, MaxSessionOptions); err != nil {
		return err
	}
	keys := make([]string, len(m.Options))
	for i := range m.Options {
		if err := m.Options[i].Validate(); err != nil {
			return fmt.Errorf("options[%d].%w", i, err)
		}
		keys[i] = m.Options[i].Key
	}
	return checkUnique("options", keys)
}

// RecentDirsResult is the result of `recent_dirs`.
type RecentDirsResult struct {
	Home string   `json:"home"`
	Dirs []string `json:"dirs"`
}

func (m *RecentDirsResult) UnmarshalJSON(data []byte) error {
	type plain RecentDirsResult
	return strictUnmarshal(data, (*plain)(m))
}

func (m *RecentDirsResult) Validate() error {
	if err := checkPath("home", m.Home, AbsolutePathRegexp); err != nil {
		return err
	}
	if err := checkList("dirs", m.Dirs != nil, len(m.Dirs), 0, MaxRecentDirs); err != nil {
		return err
	}
	for i, dir := range m.Dirs {
		if err := checkPath(fmt.Sprintf("dirs[%d]", i), dir, AbsolutePathRegexp); err != nil {
			return err
		}
	}
	return nil
}

// newCommandResult returns an empty result value for a request command type.
func newCommandResult(commandType string) (Validator, bool) {
	switch commandType {
	case CommandSessionCreate:
		return &SessionCreateResult{}, true
	case CommandSessionKill:
		return &SessionKillResult{}, true
	case CommandSessionHistory:
		return &SessionHistoryResult{}, true
	case CommandSessionOptions:
		return &SessionOptionsResult{}, true
	case CommandRecentDirs:
		return &RecentDirsResult{}, true
	}
	return nil, false
}

// DecodeCommandResult decodes a reply result against the command type it answers.
func DecodeCommandResult(commandType string, data []byte) (Validator, error) {
	result, ok := newCommandResult(commandType)
	if !ok {
		return nil, fmt.Errorf("command %q has no result", commandType)
	}
	if err := Decode(data, result); err != nil {
		return nil, err
	}
	return result, nil
}
