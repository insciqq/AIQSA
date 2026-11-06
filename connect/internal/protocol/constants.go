// Package protocol mirrors the AIQSA Connect wire contract defined in
// lib/contracts/connect.ts: the same names, JSON keys, limits, codes and
// patterns. Every inbound message is decoded strictly (unknown keys, missing
// required keys and unexpected nulls are errors) and checked with Validate.
package protocol

import "regexp"

// ProtocolVersion is the `protocol` of HelloV2: the agent works on the
// user's computer through `op` commands. Protocol 2 clients send
// ProtocolHeader on every device API request.
const ProtocolVersion = 2

// LegacyProtocolVersion is the `protocol` of the removed terminal protocol;
// the shared contract still names it.
const LegacyProtocolVersion = 1

// Limits. Byte limits count UTF-8 bytes; text limits count Unicode code points.
const (
	MaxDevicesPerUser                    = 10
	MaxEventsPerPost                     = 64
	MaxEventsBodyBytes                   = 1_048_576
	HeartbeatSeconds                     = 15
	PairingTTLSeconds                    = 600
	PairingPollIntervalSeconds           = 2
	PairingPollIntervalMaxSeconds        = 60
	MaxCwdLength                         = 1_024
	MaxRecentDirs                        = 20
	MaxDeviceNameLength                  = 64
	MaxHostnameLength                    = 255
	MaxAccountLabelLength                = 400
	MaxURLLength                         = 2_048
	MaxClientBinaryBytes                 = 134_217_728
	MaxClientTargets                     = 6
	LegacyMaxClientTargets               = 4
	MaxSeq                        uint64 = 1<<53 - 1
)

// Protocol 2 limits: the device's agent operations (`op`).
const (
	MaxConcurrentOps           = 16
	MaxJobs                    = 8
	MaxReplyBytes              = 524_288
	MaxWriteBytes              = 1_048_576
	DefaultShellTimeoutSeconds = 120
	MaxShellTimeoutSeconds     = 600
	MaxOpDeadlineMs            = 660_000
	MaxJobWaitSeconds          = 30
	MaxJobBufferBytes          = 1_048_576
	OutputHeadBytes            = 32_768
	OutputTailBytes            = 98_304
	MaxStreamOutputBytes       = OutputHeadBytes + OutputTailBytes
	MaxCommandBytes            = 65_536
	DefaultReadLines           = 2_000
	MaxReadLines               = 2_000
	MaxReadLineLength          = 2_000
	MaxLineBytes               = 8_000
	MaxReadBytes               = 262_144
	MaxLineNumber              = 2_147_483_647
	MaxGlobPaths               = 1_000
	MaxGrepMatches             = 1_000
	MaxGrepContext             = 5
	MaxPatternLength           = 1_024
	MaxListDirs                = 500
	MaxDirNameLength           = 255
	MaxOSVersionLength         = 128
	MaxShellNameLength         = 64
	MaxShellVersionLength      = 64
	MinExitCode                = -2_147_483_648
	MaxExitCode                = 4_294_967_295
)

// ReasonCode is a stable refusal or failure code.
type ReasonCode string

const (
	CodeDisabled          ReasonCode = "connect_disabled"
	CodeUnauthorized      ReasonCode = "connect_unauthorized"
	CodeDeviceOffline     ReasonCode = "connect_device_offline"
	CodeDeviceLimit       ReasonCode = "connect_device_limit"
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
	CodeDisabled, CodeUnauthorized, CodeDeviceOffline, CodeDeviceLimit,
	CodeClientOutdated, CodePairingExpired, CodeRateLimited, CodeInputTooLarge,
	CodeStreamRequired, CodeUnsupported, CodeClientUnavailable, CodeNotFound,
	CodeRequestInvalid, CodeDeviceError,
}

// Codes of a protocol 2 device's failed `op` reply. CodeUnsupported answers
// an op this client does not know; CodeDeviceError any other failure.
const (
	CodeComputerTimeout          ReasonCode = "computer_timeout"
	CodeComputerCancelled        ReasonCode = "computer_cancelled"
	CodeComputerPathNotFound     ReasonCode = "computer_path_not_found"
	CodeComputerNotADirectory    ReasonCode = "computer_not_a_directory"
	CodeComputerIsADirectory     ReasonCode = "computer_is_a_directory"
	CodeComputerPermissionDenied ReasonCode = "computer_permission_denied"
	CodeComputerFileBinary       ReasonCode = "computer_file_binary"
	CodeComputerFileTooLarge     ReasonCode = "computer_file_too_large"
	CodeComputerEditNoMatch      ReasonCode = "computer_edit_no_match"
	CodeComputerEditAmbiguous    ReasonCode = "computer_edit_ambiguous"
	CodeComputerJobNotFound      ReasonCode = "computer_job_not_found"
	CodeComputerLimit            ReasonCode = "computer_limit"
	CodeComputerPatternInvalid   ReasonCode = "computer_pattern_invalid"
	// CodeComputerTextUnencodable: write or edit text that the file's
	// encoding (its ANSI code page) cannot hold; nothing was written.
	CodeComputerTextUnencodable ReasonCode = "computer_text_unencodable"
)

// OpErrorCodes are the codes a protocol 2 device may put in a failed `op` reply.
var OpErrorCodes = []ReasonCode{
	CodeComputerTimeout, CodeComputerCancelled, CodeComputerPathNotFound, CodeComputerNotADirectory,
	CodeComputerIsADirectory, CodeComputerPermissionDenied, CodeComputerFileBinary, CodeComputerFileTooLarge,
	CodeComputerEditNoMatch, CodeComputerEditAmbiguous, CodeComputerJobNotFound, CodeComputerLimit,
	CodeComputerPatternInvalid, CodeComputerTextUnencodable, CodeUnsupported, CodeDeviceError,
}

// DeviceStreamClosedCodes are the codes of `closed` on the device stream.
var DeviceStreamClosedCodes = []ReasonCode{CodeDisabled, CodeUnauthorized, CodeClientOutdated}

// EventsStreamClosedCodes are the codes of `closed` on the browser device-list stream.
var EventsStreamClosedCodes = []ReasonCode{CodeDisabled, CodeUnauthorized}

type OS string

const (
	OSDarwin  OS = "darwin"
	OSLinux   OS = "linux"
	OSWindows OS = "windows"
)

var OSValues = []OS{OSDarwin, OSLinux, OSWindows}

// LegacyOSValues are the systems a protocol 1 client knows; its manifest names no others.
var LegacyOSValues = []OS{OSDarwin, OSLinux}

type Arch string

const (
	ArchAMD64 Arch = "amd64"
	ArchARM64 Arch = "arm64"
)

var ArchValues = []Arch{ArchAMD64, ArchARM64}

// Target is one client build.
type Target struct {
	OS   OS   `json:"os"`
	Arch Arch `json:"arch"`
}

// LegacyClientTargets are the four targets of the manifest a protocol 1 client gets, in this order.
var LegacyClientTargets = []Target{
	{OSDarwin, ArchAMD64}, {OSDarwin, ArchARM64}, {OSLinux, ArchAMD64}, {OSLinux, ArchARM64},
}

// Op is an agent operation of protocol 2, the `op` of an `op` command.
type Op string

const (
	OpShell      Op = "shell"
	OpJobOutput  Op = "job_output"
	OpJobStop    Op = "job_stop"
	OpRead       Op = "read"
	OpWrite      Op = "write"
	OpEdit       Op = "edit"
	OpGlob       Op = "glob"
	OpGrep       Op = "grep"
	OpStat       Op = "stat"
	OpListDirs   Op = "list_dirs"
	OpRecentDirs Op = "recent_dirs"
)

var Ops = []Op{OpShell, OpJobOutput, OpJobStop, OpRead, OpWrite, OpEdit, OpGlob, OpGrep, OpStat, OpListDirs, OpRecentDirs}

// ShellKind is the shell `shell` runs: Windows PowerShell 5.1, PowerShell 7+ or the user's POSIX login shell.
type ShellKind string

const (
	ShellPowerShell ShellKind = "powershell"
	ShellPwsh       ShellKind = "pwsh"
	ShellPOSIX      ShellKind = "posix"
)

var ShellKinds = []ShellKind{ShellPowerShell, ShellPwsh, ShellPOSIX}

type GrepMode string

const (
	GrepFiles   GrepMode = "files"
	GrepContent GrepMode = "content"
	GrepCount   GrepMode = "count"
)

var GrepModes = []GrepMode{GrepFiles, GrepContent, GrepCount}

// LineEnding is a file's line endings as `read` found them; `edit` keeps them.
type LineEnding string

const (
	LineEndingLF    LineEnding = "lf"
	LineEndingCRLF  LineEnding = "crlf"
	LineEndingMixed LineEnding = "mixed"
	LineEndingNone  LineEnding = "none"
)

var LineEndings = []LineEnding{LineEndingLF, LineEndingCRLF, LineEndingMixed, LineEndingNone}

type StatKind string

const (
	StatFile  StatKind = "file"
	StatDir   StatKind = "dir"
	StatOther StatKind = "other"
)

var StatKinds = []StatKind{StatFile, StatDir, StatOther}

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
	UserCodePattern         = `^[` + UserCodeAlphabet + `]{4}-[` + UserCodeAlphabet + `]{4}$`
	DeviceTokenPattern      = `^aiqsa_connect_[A-Za-z0-9_-]{43}$`
	PollSecretPattern       = `^[A-Za-z0-9_-]{43}$`
	IDPattern               = `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
	VersionPattern          = `^(?:dev|(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,32})?)$`
	TimestampPattern        = `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$`
	SHA256Pattern           = `^[0-9a-f]{64}$`
	ControlCharacterPattern = `[\x00-\x1f\x7f-\x9f]`
	URLPrefixPattern        = `^https?:\/\/`
	// DevicePathPattern is a protocol 2 client's absolute path: POSIX, a Windows drive (`C:\` or `C:/`) or a UNC share.
	DevicePathPattern = `^(?:\/|[A-Za-z]:[\\/]|\\\\).*$`
	JobIDPattern      = `^job-[a-z0-9]{6,16}$`
	// EncodingPattern is a text encoding's lowercase name, for example utf-8, utf-16le or windows-1251.
	EncodingPattern = `^[a-z0-9][a-z0-9-]{0,31}$`
)

var (
	UserCodeRegexp         = regexp.MustCompile(UserCodePattern)
	DeviceTokenRegexp      = regexp.MustCompile(DeviceTokenPattern)
	PollSecretRegexp       = regexp.MustCompile(PollSecretPattern)
	IDRegexp               = regexp.MustCompile(IDPattern)
	VersionRegexp          = regexp.MustCompile(VersionPattern)
	TimestampRegexp        = regexp.MustCompile(TimestampPattern)
	SHA256Regexp           = regexp.MustCompile(SHA256Pattern)
	ControlCharacterRegexp = regexp.MustCompile(ControlCharacterPattern)
	URLPrefixRegexp        = regexp.MustCompile(URLPrefixPattern)
	DevicePathRegexp       = regexp.MustCompile(DevicePathPattern)
	JobIDRegexp            = regexp.MustCompile(JobIDPattern)
	EncodingRegexp         = regexp.MustCompile(EncodingPattern)
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
	WindowsExecutableExt = ".exe"
)

// ClientVersionHeader carries the client version on every device API request;
// the server records it on the device when the stream opens.
const ClientVersionHeader = "X-AIQSA-Connect-Version"

// ProtocolHeader carries "2" on every device API request of a protocol 2
// client. Without it the stream answers 426 connect_client_outdated and the
// manifest lists only LegacyClientTargets.
const ProtocolHeader = "X-AIQSA-Connect-Protocol"

// ClientBinaryName is the release file name of one target, for example
// aiqsa-connect-linux-amd64 or aiqsa-connect-windows-arm64.exe.
func ClientBinaryName(os OS, arch Arch) string {
	name := ClientBinaryPrefix + "-" + string(os) + "-" + string(arch)
	if os == OSWindows {
		name += WindowsExecutableExt
	}
	return name
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
)

var EventsStreamEvents = []string{StreamEventDevices, StreamEventDevice, StreamEventClosed, StreamEventPing}

// Protocol 2 server command types.
const (
	CommandOp       = "op"
	CommandCancel   = "cancel"
	CommandRunEnded = "run_ended"
)

// Device event types.
const (
	EventReply = "reply"
	// EventDeviceInfo is protocol 2's description of the computer, sent after each hello.
	EventDeviceInfo = "device_info"
)
