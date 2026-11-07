package protocol

import "fmt"

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

// UnknownCommandError reports a command type, or for `op` an op, this
// client does not know. RequestID is set when the command carried a valid
// requestId, so the client can answer `reply {ok: false, code: "connect_unsupported"}`.
type UnknownCommandError struct {
	Type string
	// Op is the unknown op of an `op` command; empty for an unknown type.
	Op        string
	RequestID string
}

func (e *UnknownCommandError) Error() string {
	if e.Op != "" {
		return fmt.Sprintf("unknown op %q", e.Op)
	}
	return fmt.Sprintf("unknown command type %q", e.Type)
}
