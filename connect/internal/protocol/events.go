package protocol

// DeviceEvent is one event the device POSTs to /connect-api/v1/events.
type DeviceEvent interface {
	Validator
	EventType() string
}
