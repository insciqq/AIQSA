package protocol

import "fmt"

// Browser API messages (/api/connect). The client never sends or receives
// them; they are mirrored here so the shared fixtures prove both contracts
// use the same names and keys.

// PairingLookup describes the machine waiting for approval.
type PairingLookup struct {
	Name          string `json:"name"`
	Hostname      string `json:"hostname"`
	OS            OS     `json:"os"`
	Arch          Arch   `json:"arch"`
	ClientVersion string `json:"clientVersion"`
	ExpiresAt     string `json:"expiresAt"`
}

func (m *PairingLookup) UnmarshalJSON(data []byte) error {
	type plain PairingLookup
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingLookup) Validate() error {
	return firstError(
		checkText("name", m.Name, MaxDeviceNameLength),
		checkText("hostname", m.Hostname, MaxHostnameLength),
		checkEnum("os", m.OS, OSValues),
		checkEnum("arch", m.Arch, ArchValues),
		checkPattern("clientVersion", m.ClientVersion, VersionRegexp),
		checkTimestamp("expiresAt", m.ExpiresAt),
	)
}

// PairingLookupResponse is the body of GET /api/connect/pairings/by-code/<userCode>.
type PairingLookupResponse struct {
	Pairing PairingLookup `json:"pairing"`
}

func (m *PairingLookupResponse) UnmarshalJSON(data []byte) error {
	type plain PairingLookupResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingLookupResponse) Validate() error {
	if err := m.Pairing.Validate(); err != nil {
		return fmt.Errorf("pairing.%w", err)
	}
	return nil
}

// PairingDecisionRequest is the body of POST /api/connect/pairings/by-code/<userCode>.
type PairingDecisionRequest struct {
	Decision PairingDecision `json:"decision"`
}

func (m *PairingDecisionRequest) UnmarshalJSON(data []byte) error {
	type plain PairingDecisionRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingDecisionRequest) Validate() error {
	return checkEnum("decision", m.Decision, PairingDecisions)
}

// PairingDecisionResponse is the answer to a pairing decision.
type PairingDecisionResponse struct {
	Status PairingStatus `json:"status"`
}

func (m *PairingDecisionResponse) UnmarshalJSON(data []byte) error {
	type plain PairingDecisionResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingDecisionResponse) Validate() error {
	return checkEnum("status", m.Status, []PairingStatus{PairingApproved, PairingDenied})
}

// Device is one of the user's machines with its last session snapshot.
type Device struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Hostname      string    `json:"hostname"`
	OS            OS        `json:"os"`
	Arch          Arch      `json:"arch"`
	ClientVersion string    `json:"clientVersion"`
	Online        bool      `json:"online"`
	LastSeenAt    *string   `json:"lastSeenAt" connect:"nullable"`
	CreatedAt     string    `json:"createdAt"`
	Sessions      []Session `json:"sessions"`
}

func (m *Device) UnmarshalJSON(data []byte) error {
	type plain Device
	return strictUnmarshal(data, (*plain)(m))
}

func (m *Device) Validate() error {
	if m.LastSeenAt != nil {
		if err := checkTimestamp("lastSeenAt", *m.LastSeenAt); err != nil {
			return err
		}
	}
	return firstError(
		checkPattern("id", m.ID, IDRegexp),
		checkText("name", m.Name, MaxDeviceNameLength),
		checkText("hostname", m.Hostname, MaxHostnameLength),
		checkEnum("os", m.OS, OSValues),
		checkEnum("arch", m.Arch, ArchValues),
		checkPattern("clientVersion", m.ClientVersion, VersionRegexp),
		checkTimestamp("createdAt", m.CreatedAt),
		validateSessions(m.Sessions),
	)
}

// DevicesResponse is the body of GET /api/connect/devices and the `devices` event data.
type DevicesResponse struct {
	Devices []Device `json:"devices"`
}

func (m *DevicesResponse) UnmarshalJSON(data []byte) error {
	type plain DevicesResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *DevicesResponse) Validate() error {
	if err := checkList("devices", m.Devices != nil, len(m.Devices), 0, MaxDevicesPerUser); err != nil {
		return err
	}
	ids := make([]string, len(m.Devices))
	for i := range m.Devices {
		if err := m.Devices[i].Validate(); err != nil {
			return fmt.Errorf("devices[%d].%w", i, err)
		}
		ids[i] = m.Devices[i].ID
	}
	return checkUnique("devices", ids)
}

// DeviceUpdate is the `device` event data of /api/connect/events.
type DeviceUpdate struct {
	Device Device `json:"device"`
}

func (m *DeviceUpdate) UnmarshalJSON(data []byte) error {
	type plain DeviceUpdate
	return strictUnmarshal(data, (*plain)(m))
}

func (m *DeviceUpdate) Validate() error {
	if err := m.Device.Validate(); err != nil {
		return fmt.Errorf("device.%w", err)
	}
	return nil
}

// EventsStreamClosed is the `closed` event data of /api/connect/events.
type EventsStreamClosed struct {
	Code ReasonCode `json:"code"`
}

func (m *EventsStreamClosed) UnmarshalJSON(data []byte) error {
	type plain EventsStreamClosed
	return strictUnmarshal(data, (*plain)(m))
}

func (m *EventsStreamClosed) Validate() error {
	return checkEnum("code", m.Code, EventsStreamClosedCodes)
}

// SessionCreateRequest is the body of POST /api/connect/devices/<deviceId>/sessions.
type SessionCreateRequest struct {
	Program Program `json:"program"`
	Cwd     string  `json:"cwd"`
	Title   *string `json:"title,omitempty"`
}

func (m *SessionCreateRequest) UnmarshalJSON(data []byte) error {
	type plain SessionCreateRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionCreateRequest) Validate() error {
	if m.Title != nil {
		if err := checkText("title", *m.Title, MaxTitleLength); err != nil {
			return err
		}
	}
	return firstError(
		checkEnum("program", m.Program, Programs),
		checkPath("cwd", m.Cwd, RequestedCwdRegexp),
	)
}

// Browser responses that equal a command result.
type (
	SessionCreateResponse  = SessionCreateResult
	SessionHistoryResponse = SessionHistoryResult
	SessionOptionsResponse = SessionOptionsResult
	RecentDirsResponse     = RecentDirsResult
)

// ViewCreateRequest is the body of POST /api/connect/views.
type ViewCreateRequest struct {
	DeviceID  string `json:"deviceId"`
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

func (m *ViewCreateRequest) UnmarshalJSON(data []byte) error {
	type plain ViewCreateRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewCreateRequest) Validate() error {
	return firstError(
		checkPattern("deviceId", m.DeviceID, IDRegexp),
		checkPattern("sessionId", m.SessionID, SessionIDRegexp),
		checkRange("cols", m.Cols, MinCols, MaxCols),
		checkRange("rows", m.Rows, MinRows, MaxRows),
	)
}

// ViewCreateResponse is the answer to POST /api/connect/views.
type ViewCreateResponse struct {
	ViewID string `json:"viewId"`
}

func (m *ViewCreateResponse) UnmarshalJSON(data []byte) error {
	type plain ViewCreateResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewCreateResponse) Validate() error {
	return checkPattern("viewId", m.ViewID, IDRegexp)
}

// ViewInputRequest is the body of POST /api/connect/views/<viewId>/input.
type ViewInputRequest struct {
	Data string `json:"data"`
}

func (m *ViewInputRequest) UnmarshalJSON(data []byte) error {
	type plain ViewInputRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewInputRequest) Validate() error {
	return checkBytesText("data", m.Data, 1, MaxInputBytes)
}

// ViewResizeRequest is the body of POST /api/connect/views/<viewId>/resize.
type ViewResizeRequest struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

func (m *ViewResizeRequest) UnmarshalJSON(data []byte) error {
	type plain ViewResizeRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewResizeRequest) Validate() error {
	return firstError(
		checkRange("cols", m.Cols, MinCols, MaxCols),
		checkRange("rows", m.Rows, MinRows, MaxRows),
	)
}

// ViewVisibilityRequest is the body of POST /api/connect/views/<viewId>/visibility.
type ViewVisibilityRequest struct {
	Visible bool `json:"visible"`
}

func (m *ViewVisibilityRequest) UnmarshalJSON(data []byte) error {
	type plain ViewVisibilityRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewVisibilityRequest) Validate() error { return nil }

// ViewOutput is the `output` event data of a browser view stream.
type ViewOutput struct {
	Seq  uint64 `json:"seq"`
	Data Bytes  `json:"data"`
}

func (m *ViewOutput) UnmarshalJSON(data []byte) error {
	type plain ViewOutput
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewOutput) Validate() error {
	return firstError(checkSeq(m.Seq), checkOutput(m.Data))
}

// ViewStreamClosed is the `closed` event data of a browser view stream.
type ViewStreamClosed struct {
	Reason ViewClosedReason `json:"reason"`
}

func (m *ViewStreamClosed) UnmarshalJSON(data []byte) error {
	type plain ViewStreamClosed
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewStreamClosed) Validate() error {
	return checkEnum("reason", m.Reason, ViewStreamClosedReasons)
}

// DecodeEventsStreamEvent decodes the data of one /api/connect/events frame.
func DecodeEventsStreamEvent(event string, data []byte) (Validator, error) {
	var message Validator
	switch event {
	case StreamEventDevices:
		message = &DevicesResponse{}
	case StreamEventDevice:
		message = &DeviceUpdate{}
	case StreamEventClosed:
		message = &EventsStreamClosed{}
	case StreamEventPing:
		message = &Empty{}
	default:
		return nil, fmt.Errorf("unknown stream event %q", event)
	}
	if err := Decode(data, message); err != nil {
		return nil, err
	}
	return message, nil
}

// DecodeViewStreamEvent decodes the data of one browser view stream frame.
func DecodeViewStreamEvent(event string, data []byte) (Validator, error) {
	var message Validator
	switch event {
	case StreamEventOutput:
		message = &ViewOutput{}
	case StreamEventClosed:
		message = &ViewStreamClosed{}
	case StreamEventPing:
		message = &Empty{}
	default:
		return nil, fmt.Errorf("unknown stream event %q", event)
	}
	if err := Decode(data, message); err != nil {
		return nil, err
	}
	return message, nil
}
