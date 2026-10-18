// Package protocol mirrors the AIQSA Connect wire contract defined in
// lib/contracts/connect.ts: the same names, JSON keys, limits, codes and
// patterns. Every inbound message is decoded strictly (unknown keys, missing
// required keys and unexpected nulls are errors) and checked with Validate.
package protocol

import "regexp"

// ProtocolVersion is the `protocol` value of `hello`.
const ProtocolVersion = 1

// Limits. Byte limits count UTF-8 bytes (decoded bytes for base64 output);
// text limits count Unicode code points.
const (
	MaxDevicesPerUser                    = 10
	MaxSessionsPerDevice                 = 30
	MaxViewsPerDevice                    = 8
	MaxEventsPerPost                     = 64
	MaxEventsBodyBytes                   = 1_048_576
	MaxOutputChunkBytes                  = 65_536
	MaxInputBytes                        = 65_536
	MaxHistoryBytes                      = 786_432
	ReplyTimeoutSeconds                  = 10
	HeartbeatSeconds                     = 15
	ViewOrphanTimeoutSeconds             = 30
	PairingTTLSeconds                    = 600
	PairingPollIntervalSeconds           = 2
	PairingPollIntervalMaxSeconds        = 60
	MaxTitleLength                       = 80
	MaxCwdLength                         = 1_024
	MaxRecentDirs                        = 20
	MaxSnapshotSessions                  = 50
	MaxDeviceNameLength                  = 64
	MaxHostnameLength                    = 255
	MaxSessionOptions                    = 9
	MaxOptionLabelLength                 = 80
	MaxAttachedClients                   = 1_000
	MaxURLLength                         = 2_048
	MaxClientBinaryBytes                 = 134_217_728
	MaxClientTargets                     = 4
	MaxSeq                        uint64 = 1<<53 - 1
	MinCols                              = 20
	MaxCols                              = 400
	MinRows                              = 5
	MaxRows                              = 200
)

// ReasonCode is a stable refusal or failure code.
type ReasonCode string

const (
	CodeDisabled          ReasonCode = "connect_disabled"
	CodeUnauthorized      ReasonCode = "connect_unauthorized"
	CodeDeviceOffline     ReasonCode = "connect_device_offline"
	CodeDeviceTimeout     ReasonCode = "connect_device_timeout"
	CodeDeviceLimit       ReasonCode = "connect_device_limit"
	CodeSessionLimit      ReasonCode = "connect_session_limit"
	CodeViewLimit         ReasonCode = "connect_view_limit"
	CodeSessionNotFound   ReasonCode = "connect_session_not_found"
	CodeCwdInvalid        ReasonCode = "connect_cwd_invalid"
	CodeClientOutdated    ReasonCode = "connect_client_outdated"
	CodePairingExpired    ReasonCode = "connect_pairing_expired"
	CodeRateLimited       ReasonCode = "connect_rate_limited"
	CodeInputTooLarge     ReasonCode = "connect_input_too_large"
	CodeStreamRequired    ReasonCode = "connect_stream_required"
	CodeUnsupported       ReasonCode = "connect_unsupported"
	CodeClientUnavailable ReasonCode = "connect_client_unavailable"
	CodeNotFound          ReasonCode = "connect_not_found"
	CodeRequestInvalid    ReasonCode = "connect_request_invalid"
	CodeDeviceError       ReasonCode = "connect_device_error"
)

var ReasonCodes = []ReasonCode{
	CodeDisabled, CodeUnauthorized, CodeDeviceOffline, CodeDeviceTimeout,
	CodeDeviceLimit, CodeSessionLimit, CodeViewLimit, CodeSessionNotFound,
	CodeCwdInvalid, CodeClientOutdated, CodePairingExpired, CodeRateLimited,
	CodeInputTooLarge, CodeStreamRequired, CodeUnsupported, CodeClientUnavailable,
	CodeNotFound, CodeRequestInvalid, CodeDeviceError,
}

// ReplyErrorCodes are the codes a device may put in `reply {ok: false}`.
var ReplyErrorCodes = []ReasonCode{
	CodeSessionNotFound, CodeCwdInvalid, CodeSessionLimit, CodeUnsupported, CodeDeviceError,
}

// DeviceStreamClosedCodes are the codes of `closed` on the device stream.
var DeviceStreamClosedCodes = []ReasonCode{CodeDisabled, CodeUnauthorized, CodeClientOutdated}

// EventsStreamClosedCodes are the codes of `closed` on the browser device-list stream.
var EventsStreamClosedCodes = []ReasonCode{CodeDisabled, CodeUnauthorized}

// ViewClosedReason is the `reason` of `view_closed` and of a browser view stream's `closed`.
type ViewClosedReason string

const (
	ViewClosedSessionEnded ViewClosedReason = "session_ended"
	ViewClosedDetached     ViewClosedReason = "detached"
	ViewClosedError        ViewClosedReason = "error"
	ViewClosedLimit        ViewClosedReason = "limit"
)

var ViewClosedReasons = []ViewClosedReason{
	ViewClosedSessionEnded, ViewClosedDetached, ViewClosedError, ViewClosedLimit,
}

// ViewStreamClosedReasons are the device's reasons plus the server's own codes.
var ViewStreamClosedReasons = []ViewClosedReason{
	ViewClosedSessionEnded, ViewClosedDetached, ViewClosedError, ViewClosedLimit,
	ViewClosedReason(CodeDeviceOffline), ViewClosedReason(CodeDisabled), ViewClosedReason(CodeUnauthorized),
}

type OS string

const (
	OSDarwin OS = "darwin"
	OSLinux  OS = "linux"
)

var OSValues = []OS{OSDarwin, OSLinux}

type Arch string

const (
	ArchAMD64 Arch = "amd64"
	ArchARM64 Arch = "arm64"
)

var ArchValues = []Arch{ArchAMD64, ArchARM64}

type Program string

const (
	ProgramClaude Program = "claude"
	ProgramCodex  Program = "codex"
	ProgramShell  Program = "shell"
)

var Programs = []Program{ProgramClaude, ProgramCodex, ProgramShell}

type SessionStatus string

const (
	StatusIdle          SessionStatus = "idle"
	StatusRunning       SessionStatus = "running"
	StatusNeedsApproval SessionStatus = "needs_approval"
	StatusWaiting       SessionStatus = "waiting"
)

var SessionStatuses = []SessionStatus{StatusIdle, StatusRunning, StatusNeedsApproval, StatusWaiting}

type StatusReason string

const (
	ReasonPermission StatusReason = "permission"
	ReasonTurnEnd    StatusReason = "turn_end"
	ReasonIdlePrompt StatusReason = "idle_prompt"
	ReasonBell       StatusReason = "bell"
	ReasonInput      StatusReason = "input"
)

var StatusReasons = []StatusReason{ReasonPermission, ReasonTurnEnd, ReasonIdlePrompt, ReasonBell, ReasonInput}

type PairingDecision string

const (
	DecisionApprove PairingDecision = "approve"
	DecisionDeny    PairingDecision = "deny"
)

var PairingDecisions = []PairingDecision{DecisionApprove, DecisionDeny}

// PairingStatus is the `status` of a pairing poll or decision response.
type PairingStatus string

const (
	PairingPending  PairingStatus = "pending"
	PairingApproved PairingStatus = "approved"
	PairingDenied   PairingStatus = "denied"
	PairingExpired  PairingStatus = "expired"
)

// UserCodeAlphabet is the pairing code alphabet: digits and capitals without 0, 1, I, L, O and U.
const UserCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

// Pattern sources are identical to the TypeScript contract's RegExp sources.
const (
	SessionIDPattern        = `^ac-[a-z0-9]{6,12}$`
	UserCodePattern         = `^[` + UserCodeAlphabet + `]{4}-[` + UserCodeAlphabet + `]{4}$`
	DeviceTokenPattern      = `^aiqsa_connect_[A-Za-z0-9_-]{43}$`
	PollSecretPattern       = `^[A-Za-z0-9_-]{43}$`
	IDPattern               = `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
	VersionPattern          = `^(?:dev|(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,32})?)$`
	TimestampPattern        = `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$`
	SHA256Pattern           = `^[0-9a-f]{64}$`
	OptionKeyPattern        = `^[1-9]$`
	Base64Pattern           = `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`
	ControlCharacterPattern = `[\x00-\x1f\x7f-\x9f]`
	RequestedCwdPattern     = `^(?:~|~\/.*|\/.*)$`
	AbsolutePathPattern     = `^\/.*$`
	URLPrefixPattern        = `^https?:\/\/`
)

var (
	SessionIDRegexp        = regexp.MustCompile(SessionIDPattern)
	UserCodeRegexp         = regexp.MustCompile(UserCodePattern)
	DeviceTokenRegexp      = regexp.MustCompile(DeviceTokenPattern)
	PollSecretRegexp       = regexp.MustCompile(PollSecretPattern)
	IDRegexp               = regexp.MustCompile(IDPattern)
	VersionRegexp          = regexp.MustCompile(VersionPattern)
	TimestampRegexp        = regexp.MustCompile(TimestampPattern)
	SHA256Regexp           = regexp.MustCompile(SHA256Pattern)
	OptionKeyRegexp        = regexp.MustCompile(OptionKeyPattern)
	Base64Regexp           = regexp.MustCompile(Base64Pattern)
	ControlCharacterRegexp = regexp.MustCompile(ControlCharacterPattern)
	RequestedCwdRegexp     = regexp.MustCompile(RequestedCwdPattern)
	AbsolutePathRegexp     = regexp.MustCompile(AbsolutePathPattern)
	URLPrefixRegexp        = regexp.MustCompile(URLPrefixPattern)
)

// Device-facing paths.
const (
	DeviceAPIPrefix      = "/connect-api/v1"
	PairingsPath         = DeviceAPIPrefix + "/pairings"
	PairingPollPath      = DeviceAPIPrefix + "/pairings/poll"
	DeviceStreamPath     = DeviceAPIPrefix + "/stream"
	DeviceEventsPath     = DeviceAPIPrefix + "/events"
	ClientManifestPath   = DeviceAPIPrefix + "/client"
	InstallScriptPath    = "/connect/install.sh"
	ClientDownloadPrefix = "/connect/download"
	ClientChecksumsPath  = "/connect/checksums.txt"
	ClientBinaryPrefix   = "aiqsa-connect"
)

// ClientBinaryName is the release file name of one target, for example aiqsa-connect-linux-amd64.
func ClientBinaryName(os OS, arch Arch) string {
	return ClientBinaryPrefix + "-" + string(os) + "-" + string(arch)
}

// ClientDownloadPath is the public download path of one target.
func ClientDownloadPath(os OS, arch Arch) string {
	return ClientDownloadPrefix + "/" + ClientBinaryName(os, arch)
}

// Device stream SSE event names.
const (
	StreamEventHello    = "hello"
	StreamEventCommand  = "command"
	StreamEventPing     = "ping"
	StreamEventReplaced = "replaced"
	StreamEventClosed   = "closed"
)

var DeviceStreamEvents = []string{StreamEventHello, StreamEventCommand, StreamEventPing, StreamEventReplaced, StreamEventClosed}

// Browser stream SSE event names.
const (
	StreamEventDevices = "devices"
	StreamEventDevice  = "device"
	StreamEventOutput  = "output"
)

var EventsStreamEvents = []string{StreamEventDevices, StreamEventDevice, StreamEventClosed, StreamEventPing}
var ViewStreamEvents = []string{StreamEventOutput, StreamEventClosed, StreamEventPing}

// Server command types.
const (
	CommandViewOpen       = "view_open"
	CommandViewInput      = "view_input"
	CommandViewResize     = "view_resize"
	CommandViewClose      = "view_close"
	CommandSessionCreate  = "session_create"
	CommandSessionKill    = "session_kill"
	CommandSessionHistory = "session_history"
	CommandSessionOptions = "session_options"
	CommandRecentDirs     = "recent_dirs"
)

// Device event types.
const (
	EventSessions   = "sessions"
	EventStatus     = "status"
	EventOutput     = "output"
	EventViewClosed = "view_closed"
	EventReply      = "reply"
)
