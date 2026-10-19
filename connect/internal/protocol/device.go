package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrorResponse is the body of every refused request: `{code}`.
type ErrorResponse struct {
	Code ReasonCode `json:"code"`
}

func (m *ErrorResponse) UnmarshalJSON(data []byte) error {
	type plain ErrorResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ErrorResponse) Validate() error {
	return checkEnum("code", m.Code, ReasonCodes)
}

// Session is one tmux session of a device.
type Session struct {
	ID              string        `json:"id"`
	Title           string        `json:"title"`
	Cwd             string        `json:"cwd"`
	Program         Program       `json:"program"`
	Status          SessionStatus `json:"status"`
	StatusAt        string        `json:"statusAt"`
	CreatedAt       string        `json:"createdAt"`
	AttachedClients int           `json:"attachedClients"`
}

func (m *Session) UnmarshalJSON(data []byte) error {
	type plain Session
	return strictUnmarshal(data, (*plain)(m))
}

func (m *Session) Validate() error {
	return firstError(
		checkPattern("id", m.ID, SessionIDRegexp),
		checkText("title", m.Title, MaxTitleLength),
		checkPath("cwd", m.Cwd, AbsolutePathRegexp),
		checkEnum("program", m.Program, Programs),
		checkEnum("status", m.Status, SessionStatuses),
		checkTimestamp("statusAt", m.StatusAt),
		checkTimestamp("createdAt", m.CreatedAt),
		checkRange("attachedClients", m.AttachedClients, 0, MaxAttachedClients),
	)
}

func validateSessions(sessions []Session) error {
	if err := checkList("sessions", sessions != nil, len(sessions), 0, MaxSnapshotSessions); err != nil {
		return err
	}
	ids := make([]string, len(sessions))
	for i := range sessions {
		if err := sessions[i].Validate(); err != nil {
			return fmt.Errorf("sessions[%d].%w", i, err)
		}
		ids[i] = sessions[i].ID
	}
	return checkUnique("sessions", ids)
}

// PairingCreateRequest is the body of POST /connect-api/v1/pairings.
type PairingCreateRequest struct {
	Name          string `json:"name"`
	Hostname      string `json:"hostname"`
	OS            OS     `json:"os"`
	Arch          Arch   `json:"arch"`
	ClientVersion string `json:"clientVersion"`
}

func (m *PairingCreateRequest) UnmarshalJSON(data []byte) error {
	type plain PairingCreateRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingCreateRequest) Validate() error {
	return firstError(
		checkText("name", m.Name, MaxDeviceNameLength),
		checkText("hostname", m.Hostname, MaxHostnameLength),
		checkEnum("os", m.OS, OSValues),
		checkEnum("arch", m.Arch, ArchValues),
		checkPattern("clientVersion", m.ClientVersion, VersionRegexp),
	)
}

// PairingCreateResponse is the 201 body of POST /connect-api/v1/pairings.
type PairingCreateResponse struct {
	PairingID string `json:"pairingId"`
	UserCode  string `json:"userCode"`
	// VerificationURI is the complete approval page URL, code included.
	VerificationURI string `json:"verificationUri"`
	PollSecret      string `json:"pollSecret"`
	ExpiresAt       string `json:"expiresAt"`
	IntervalSeconds int    `json:"intervalSeconds"`
}

func (m *PairingCreateResponse) UnmarshalJSON(data []byte) error {
	type plain PairingCreateResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingCreateResponse) Validate() error {
	return firstError(
		checkPattern("pairingId", m.PairingID, IDRegexp),
		checkPattern("userCode", m.UserCode, UserCodeRegexp),
		checkURL("verificationUri", m.VerificationURI),
		checkPattern("pollSecret", m.PollSecret, PollSecretRegexp),
		checkTimestamp("expiresAt", m.ExpiresAt),
		checkRange("intervalSeconds", m.IntervalSeconds, PairingPollIntervalSeconds, PairingPollIntervalMaxSeconds),
	)
}

// PairingPollRequest is the body of POST /connect-api/v1/pairings/poll.
type PairingPollRequest struct {
	PairingID  string `json:"pairingId"`
	PollSecret string `json:"pollSecret"`
}

func (m *PairingPollRequest) UnmarshalJSON(data []byte) error {
	type plain PairingPollRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingPollRequest) Validate() error {
	return firstError(
		checkPattern("pairingId", m.PairingID, IDRegexp),
		checkPattern("pollSecret", m.PollSecret, PollSecretRegexp),
	)
}

// PairingPollResponse is `{status: "pending"|"denied"|"expired"}` or
// `{status: "approved", deviceId, deviceToken, account}`; account names who
// approved the computer.
type PairingPollResponse struct {
	Status      PairingStatus `json:"status"`
	DeviceID    *string       `json:"deviceId,omitempty"`
	DeviceToken *string       `json:"deviceToken,omitempty"`
	Account     *string       `json:"account,omitempty"`
}

func (m *PairingPollResponse) UnmarshalJSON(data []byte) error {
	type plain PairingPollResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingPollResponse) Validate() error {
	if err := checkEnum("status", m.Status, []PairingStatus{PairingPending, PairingApproved, PairingDenied, PairingExpired}); err != nil {
		return err
	}
	if m.Status != PairingApproved {
		if m.DeviceID != nil || m.DeviceToken != nil || m.Account != nil {
			return errors.New("deviceId, deviceToken and account: only for approved")
		}
		return nil
	}
	if m.DeviceID == nil || m.DeviceToken == nil || m.Account == nil {
		return errors.New("deviceId, deviceToken and account: required when approved")
	}
	return firstError(
		checkPattern("deviceId", *m.DeviceID, IDRegexp),
		checkPattern("deviceToken", *m.DeviceToken, DeviceTokenRegexp),
		checkText("account", *m.Account, MaxAccountLabelLength),
	)
}

// HelloLimits are the limits a server enforces, each at most the contract maximum.
type HelloLimits struct {
	MaxEventsPerPost    int `json:"maxEventsPerPost"`
	MaxEventsBodyBytes  int `json:"maxEventsBodyBytes"`
	MaxOutputChunkBytes int `json:"maxOutputChunkBytes"`
	MaxInputBytes       int `json:"maxInputBytes"`
	MaxHistoryBytes     int `json:"maxHistoryBytes"`
	MaxSessions         int `json:"maxSessions"`
	MaxViews            int `json:"maxViews"`
	MaxSnapshotSessions int `json:"maxSnapshotSessions"`
	MaxRecentDirs       int `json:"maxRecentDirs"`
	HeartbeatSeconds    int `json:"heartbeatSeconds"`
	ReplyTimeoutSeconds int `json:"replyTimeoutSeconds"`
}

// DefaultHelloLimits are the contract maxima.
var DefaultHelloLimits = HelloLimits{
	MaxEventsPerPost:    MaxEventsPerPost,
	MaxEventsBodyBytes:  MaxEventsBodyBytes,
	MaxOutputChunkBytes: MaxOutputChunkBytes,
	MaxInputBytes:       MaxInputBytes,
	MaxHistoryBytes:     MaxHistoryBytes,
	MaxSessions:         MaxSessionsPerDevice,
	MaxViews:            MaxViewsPerDevice,
	MaxSnapshotSessions: MaxSnapshotSessions,
	MaxRecentDirs:       MaxRecentDirs,
	HeartbeatSeconds:    HeartbeatSeconds,
	ReplyTimeoutSeconds: ReplyTimeoutSeconds,
}

func (m *HelloLimits) UnmarshalJSON(data []byte) error {
	type plain HelloLimits
	return strictUnmarshal(data, (*plain)(m))
}

func (m *HelloLimits) Validate() error {
	return firstError(
		checkRange("maxEventsPerPost", m.MaxEventsPerPost, 1, MaxEventsPerPost),
		checkRange("maxEventsBodyBytes", m.MaxEventsBodyBytes, 1, MaxEventsBodyBytes),
		checkRange("maxOutputChunkBytes", m.MaxOutputChunkBytes, 1, MaxOutputChunkBytes),
		checkRange("maxInputBytes", m.MaxInputBytes, 1, MaxInputBytes),
		checkRange("maxHistoryBytes", m.MaxHistoryBytes, 1, MaxHistoryBytes),
		checkRange("maxSessions", m.MaxSessions, 1, MaxSessionsPerDevice),
		checkRange("maxViews", m.MaxViews, 1, MaxViewsPerDevice),
		checkRange("maxSnapshotSessions", m.MaxSnapshotSessions, 1, MaxSnapshotSessions),
		checkRange("maxRecentDirs", m.MaxRecentDirs, 1, MaxRecentDirs),
		checkRange("heartbeatSeconds", m.HeartbeatSeconds, 1, HeartbeatSeconds),
		checkRange("replyTimeoutSeconds", m.ReplyTimeoutSeconds, 1, ReplyTimeoutSeconds),
	)
}

// Hello is the first event of the device stream.
type Hello struct {
	Protocol         int         `json:"protocol"`
	DeviceID         string      `json:"deviceId"`
	ServerVersion    string      `json:"serverVersion"`
	MinClientVersion string      `json:"minClientVersion"`
	Limits           HelloLimits `json:"limits"`
}

func (m *Hello) UnmarshalJSON(data []byte) error {
	type plain Hello
	return strictUnmarshal(data, (*plain)(m))
}

func (m *Hello) Validate() error {
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

// DeviceStreamClosed is the data of `closed` on the device stream.
type DeviceStreamClosed struct {
	Code ReasonCode `json:"code"`
}

func (m *DeviceStreamClosed) UnmarshalJSON(data []byte) error {
	type plain DeviceStreamClosed
	return strictUnmarshal(data, (*plain)(m))
}

func (m *DeviceStreamClosed) Validate() error {
	return checkEnum("code", m.Code, DeviceStreamClosedCodes)
}

// Empty is the `{}` data of `ping` and `replaced`, and the result of `session_kill`.
type Empty struct{}

func (m *Empty) UnmarshalJSON(data []byte) error {
	type plain Empty
	return strictUnmarshal(data, (*plain)(m))
}

func (m *Empty) Validate() error { return nil }

// SessionKillResult is the `{}` result of `session_kill`.
type SessionKillResult = Empty

// StreamEvent is one SSE frame: the event name and its JSON data. Fixtures
// and decoders use it to describe a stream event as a single JSON value.
type StreamEvent struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

func (m *StreamEvent) UnmarshalJSON(data []byte) error {
	type plain StreamEvent
	return strictUnmarshal(data, (*plain)(m))
}

// DecodeDeviceStreamEvent decodes the data of one device stream frame into
// *Hello, a ServerCommand, *Empty (ping, replaced) or *DeviceStreamClosed.
func DecodeDeviceStreamEvent(event string, data []byte) (Validator, error) {
	var message Validator
	switch event {
	case StreamEventHello:
		message = &Hello{}
	case StreamEventCommand:
		return DecodeServerCommand(data)
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

// ClientTarget is one downloadable client binary.
type ClientTarget struct {
	OS     OS     `json:"os"`
	Arch   Arch   `json:"arch"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func (m *ClientTarget) UnmarshalJSON(data []byte) error {
	type plain ClientTarget
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ClientTarget) Validate() error {
	if m.Size < 1 || m.Size > MaxClientBinaryBytes {
		return fmt.Errorf("size: must be 1..%d", MaxClientBinaryBytes)
	}
	return firstError(
		checkEnum("os", m.OS, OSValues),
		checkEnum("arch", m.Arch, ArchValues),
		checkPattern("sha256", m.SHA256, SHA256Regexp),
	)
}

// ClientManifest is the body of GET /connect-api/v1/client.
type ClientManifest struct {
	Version string         `json:"version"`
	Targets []ClientTarget `json:"targets"`
}

func (m *ClientManifest) UnmarshalJSON(data []byte) error {
	type plain ClientManifest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ClientManifest) Validate() error {
	if err := checkPattern("version", m.Version, VersionRegexp); err != nil {
		return err
	}
	if err := checkList("targets", m.Targets != nil, len(m.Targets), 1, MaxClientTargets); err != nil {
		return err
	}
	keys := make([]string, len(m.Targets))
	for i := range m.Targets {
		if err := m.Targets[i].Validate(); err != nil {
			return fmt.Errorf("targets[%d].%w", i, err)
		}
		keys[i] = string(m.Targets[i].OS) + "-" + string(m.Targets[i].Arch)
	}
	return checkUnique("targets", keys)
}
