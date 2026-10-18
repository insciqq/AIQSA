package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// DeviceEvent is one event the device POSTs to /connect-api/v1/events.
type DeviceEvent interface {
	Validator
	EventType() string
}

// DecodeDeviceEvent strictly decodes and validates one device event.
func DecodeDeviceEvent(data []byte) (DeviceEvent, error) {
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
	case EventSessions:
		event = &SessionsEvent{}
	case EventStatus:
		event = &StatusEvent{}
	case EventOutput:
		event = &OutputEvent{}
	case EventViewClosed:
		event = &ViewClosedEvent{}
	case EventReply:
		event = &ReplyEvent{}
	default:
		return nil, fmt.Errorf("unknown event type %q", eventType)
	}
	if err := Decode(data, event); err != nil {
		return nil, err
	}
	return event, nil
}

// SessionsEvent is the full session snapshot, sent on connect and on every change.
type SessionsEvent struct {
	Type     string    `json:"type"`
	Sessions []Session `json:"sessions"`
}

func (m *SessionsEvent) EventType() string { return EventSessions }

func (m *SessionsEvent) UnmarshalJSON(data []byte) error {
	type plain SessionsEvent
	return strictUnmarshal(data, (*plain)(m))
}

func (m *SessionsEvent) Validate() error {
	if err := checkType(EventSessions, m.Type); err != nil {
		return err
	}
	return validateSessions(m.Sessions)
}

// StatusEvent reports a session status change.
type StatusEvent struct {
	Type      string        `json:"type"`
	SessionID string        `json:"sessionId"`
	Status    SessionStatus `json:"status"`
	StatusAt  string        `json:"statusAt"`
	Reason    *StatusReason `json:"reason,omitempty"`
}

func (m *StatusEvent) EventType() string { return EventStatus }

func (m *StatusEvent) UnmarshalJSON(data []byte) error {
	type plain StatusEvent
	return strictUnmarshal(data, (*plain)(m))
}

func (m *StatusEvent) Validate() error {
	if m.Reason != nil {
		if err := checkEnum("reason", *m.Reason, StatusReasons); err != nil {
			return err
		}
	}
	return firstError(
		checkType(EventStatus, m.Type),
		checkPattern("sessionId", m.SessionID, SessionIDRegexp),
		checkEnum("status", m.Status, SessionStatuses),
		checkTimestamp("statusAt", m.StatusAt),
	)
}

// OutputEvent carries one chunk of a view's terminal output. Seq starts at
// 0 for each view and grows by one per chunk.
type OutputEvent struct {
	Type   string `json:"type"`
	ViewID string `json:"viewId"`
	Seq    uint64 `json:"seq"`
	Data   Bytes  `json:"data"`
}

func (m *OutputEvent) EventType() string { return EventOutput }

func (m *OutputEvent) UnmarshalJSON(data []byte) error {
	type plain OutputEvent
	return strictUnmarshal(data, (*plain)(m))
}

func (m *OutputEvent) Validate() error {
	return firstError(
		checkType(EventOutput, m.Type),
		checkPattern("viewId", m.ViewID, IDRegexp),
		checkSeq(m.Seq),
		checkOutput(m.Data),
	)
}

func checkSeq(seq uint64) error {
	if seq > MaxSeq {
		return fmt.Errorf("seq: must be at most %d", MaxSeq)
	}
	return nil
}

func checkOutput(data Bytes) error {
	if len(data) < 1 || len(data) > MaxOutputChunkBytes {
		return fmt.Errorf("data: must decode to 1..%d bytes", MaxOutputChunkBytes)
	}
	return nil
}

// ViewClosedEvent reports that the device closed a view.
type ViewClosedEvent struct {
	Type   string           `json:"type"`
	ViewID string           `json:"viewId"`
	Reason ViewClosedReason `json:"reason"`
}

func (m *ViewClosedEvent) EventType() string { return EventViewClosed }

func (m *ViewClosedEvent) UnmarshalJSON(data []byte) error {
	type plain ViewClosedEvent
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ViewClosedEvent) Validate() error {
	return firstError(
		checkType(EventViewClosed, m.Type),
		checkPattern("viewId", m.ViewID, IDRegexp),
		checkEnum("reason", m.Reason, ViewClosedReasons),
	)
}

// ReplyEvent answers a request command: `{ok: true, result}` or `{ok: false, code}`.
type ReplyEvent struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	OK        bool            `json:"ok"`
	Result    json.RawMessage `json:"result,omitempty"`
	Code      *ReasonCode     `json:"code,omitempty"`
}

// NewReplyResult builds a successful reply; result is one of the command result types.
func NewReplyResult(requestID string, result Validator) (*ReplyEvent, error) {
	if err := result.Validate(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return &ReplyEvent{Type: EventReply, RequestID: requestID, OK: true, Result: encoded}, nil
}

// NewReplyError builds a failed reply with one of ReplyErrorCodes.
func NewReplyError(requestID string, code ReasonCode) *ReplyEvent {
	return &ReplyEvent{Type: EventReply, RequestID: requestID, OK: false, Code: &code}
}

func (m *ReplyEvent) EventType() string { return EventReply }

func (m *ReplyEvent) UnmarshalJSON(data []byte) error {
	type plain ReplyEvent
	return strictUnmarshal(data, (*plain)(m))
}

func (m *ReplyEvent) Validate() error {
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
		return checkEnum("code", *m.Code, ReplyErrorCodes)
	}
	if m.Code != nil {
		return errors.New("code: only when not ok")
	}
	if m.Result == nil {
		return errors.New("result: required when ok")
	}
	for _, commandType := range []string{CommandSessionCreate, CommandSessionHistory, CommandSessionOptions, CommandRecentDirs, CommandSessionKill} {
		if _, err := DecodeCommandResult(commandType, m.Result); err == nil {
			return nil
		}
	}
	return errors.New("result: matches no command result")
}

// EventBatch is the body of POST /connect-api/v1/events.
type EventBatch struct {
	Events []DeviceEvent `json:"events"`
}

func (m *EventBatch) UnmarshalJSON(data []byte) error {
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
		event, err := DecodeDeviceEvent(raw)
		if err != nil {
			return fmt.Errorf("events[%d].%w", i, err)
		}
		m.Events[i] = event
	}
	return nil
}

func (m *EventBatch) Validate() error {
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
