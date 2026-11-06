package protocol

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Fixture convention shared with lib/contracts/connect.test.ts:
// testdata/{valid,invalid}/<schema>.<case>.json, where <schema> names an
// entry of fixtureSchemas below and of the TypeScript registry. A fixture is
// one JSON value; stream events are {"event": <SSE event name>, "data": <data>}.

type decodeFunc func([]byte) (any, error)

func decodeInto[T any, P interface {
	*T
	Validator
}]() decodeFunc {
	return func(data []byte) (any, error) {
		message := P(new(T))
		if err := Decode(data, message); err != nil {
			return nil, err
		}
		return message, nil
	}
}

func decodeStream(decode func(string, []byte) (Validator, error)) decodeFunc {
	return func(data []byte) (any, error) {
		var frame StreamEvent
		if !isObject(data) {
			return nil, errors.New("expected a JSON object")
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			return nil, err
		}
		message, err := decode(frame.Event, frame.Data)
		if err != nil {
			return nil, err
		}
		return StreamEvent{Event: frame.Event, Data: mustMarshal(message)}, nil
	}
}

func mustMarshal(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

var fixtureSchemas = map[string]decodeFunc{
	"errorResponse":           decodeInto[ErrorResponse](),
	"pairingCreateRequest":    decodeInto[PairingCreateRequest](),
	"pairingCreateResponse":   decodeInto[PairingCreateResponse](),
	"pairingPollRequest":      decodeInto[PairingPollRequest](),
	"pairingPollResponse":     decodeInto[PairingPollResponse](),
	"pairingLookupResponse":   decodeInto[PairingLookupResponse](),
	"pairingDecisionRequest":  decodeInto[PairingDecisionRequest](),
	"pairingDecisionResponse": decodeInto[PairingDecisionResponse](),
	"clientManifest":          decodeInto[ClientManifest](),
	"deviceStreamEventV2":     decodeStream(DecodeDeviceStreamEventV2),
	"serverCommandV2": func(data []byte) (any, error) {
		return DecodeServerCommandV2(data)
	},
	"opResult": decodeOpResultFixture,
	"deviceEventV2": func(data []byte) (any, error) {
		return DecodeDeviceEventV2(data)
	},
	"deviceEventBatchV2":   decodeInto[EventBatchV2](),
	"legacyClientManifest": decodeInto[LegacyClientManifest](),
}

// opResultFixture is the fixture shape of an op result: the op it answers
// and the result, which DecodeOpResult checks against that op.
type opResultFixture struct {
	Op     Op              `json:"op"`
	Result json.RawMessage `json:"result"`
}

func (m *opResultFixture) UnmarshalJSON(data []byte) error {
	type plain opResultFixture
	return strictUnmarshal(data, (*plain)(m))
}

func decodeOpResultFixture(data []byte) (any, error) {
	var wrapper opResultFixture
	if !isObject(data) {
		return nil, errors.New("expected a JSON object")
	}
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return nil, err
	}
	result, err := DecodeOpResult(wrapper.Op, wrapper.Result)
	if err != nil {
		return nil, err
	}
	return opResultFixture{Op: wrapper.Op, Result: mustMarshal(result)}, nil
}

type fixture struct {
	name   string
	schema string
	data   []byte
}

func loadFixtures(t *testing.T, kind string) []fixture {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join("testdata", kind, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatalf("no %s fixtures", kind)
	}
	fixtures := make([]fixture, 0, len(paths))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		name := filepath.Base(path)
		schema, _, _ := strings.Cut(name, ".")
		fixtures = append(fixtures, fixture{name: kind + "/" + name, schema: schema, data: data})
	}
	return fixtures
}

func TestValidFixturesDecodeAndReencode(t *testing.T) {
	covered := map[string]bool{}
	for _, f := range loadFixtures(t, "valid") {
		decode, ok := fixtureSchemas[f.schema]
		if !ok {
			t.Errorf("%s: unknown schema %q", f.name, f.schema)
			continue
		}
		covered[f.schema] = true
		message, err := decode(f.data)
		if err != nil {
			t.Errorf("%s: rejected: %v", f.name, err)
			continue
		}
		// Encoding the decoded value yields the same JSON: Go writes the keys the contract reads.
		if !sameJSON(t, f.data, mustMarshal(message)) {
			t.Errorf("%s: re-encoded JSON differs: %s", f.name, mustMarshal(message))
		}
	}
	for schema := range fixtureSchemas {
		if !covered[schema] {
			t.Errorf("schema %q has no valid fixture", schema)
		}
	}
}

func TestInvalidFixturesAreRejected(t *testing.T) {
	for _, f := range loadFixtures(t, "invalid") {
		decode, ok := fixtureSchemas[f.schema]
		if !ok {
			t.Errorf("%s: unknown schema %q", f.name, f.schema)
			continue
		}
		_, err := decode(f.data)
		if err == nil {
			t.Errorf("%s: accepted", f.name)
			continue
		}
		t.Logf("%s: %v", f.name, err)
	}
}

func sameJSON(t *testing.T, left, right []byte) bool {
	t.Helper()
	var a, b any
	if err := json.Unmarshal(left, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(right, &b); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(a, b)
}

func TestConstantsMatchSharedContract(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	actual := map[string]any{
		"protocolVersion":       ProtocolVersion,
		"legacyProtocolVersion": LegacyProtocolVersion,
		"limits": map[string]any{
			"maxDevicesPerUser":             MaxDevicesPerUser,
			"maxEventsPerPost":              MaxEventsPerPost,
			"maxEventsBodyBytes":            MaxEventsBodyBytes,
			"heartbeatSeconds":              HeartbeatSeconds,
			"pairingTtlSeconds":             PairingTTLSeconds,
			"pairingPollIntervalSeconds":    PairingPollIntervalSeconds,
			"pairingPollIntervalMaxSeconds": PairingPollIntervalMaxSeconds,
			"maxCwdLength":                  MaxCwdLength,
			"maxRecentDirs":                 MaxRecentDirs,
			"maxDeviceNameLength":           MaxDeviceNameLength,
			"maxHostnameLength":             MaxHostnameLength,
			"maxAccountLabelLength":         MaxAccountLabelLength,
			"maxUrlLength":                  MaxURLLength,
			"maxClientBinaryBytes":          MaxClientBinaryBytes,
			"maxClientTargets":              MaxClientTargets,
			"maxSeq":                        MaxSeq,
			"legacyMaxClientTargets":        LegacyMaxClientTargets,
			"maxConcurrentOps":              MaxConcurrentOps,
			"maxJobs":                       MaxJobs,
			"maxReplyBytes":                 MaxReplyBytes,
			"maxWriteBytes":                 MaxWriteBytes,
			"defaultShellTimeoutSeconds":    DefaultShellTimeoutSeconds,
			"maxShellTimeoutSeconds":        MaxShellTimeoutSeconds,
			"maxOpDeadlineMs":               MaxOpDeadlineMs,
			"maxJobWaitSeconds":             MaxJobWaitSeconds,
			"maxJobBufferBytes":             MaxJobBufferBytes,
			"outputHeadBytes":               OutputHeadBytes,
			"outputTailBytes":               OutputTailBytes,
			"maxStreamOutputBytes":          MaxStreamOutputBytes,
			"maxCommandBytes":               MaxCommandBytes,
			"defaultReadLines":              DefaultReadLines,
			"maxReadLines":                  MaxReadLines,
			"maxReadLineLength":             MaxReadLineLength,
			"maxLineBytes":                  MaxLineBytes,
			"maxReadBytes":                  MaxReadBytes,
			"maxLineNumber":                 MaxLineNumber,
			"maxGlobPaths":                  MaxGlobPaths,
			"maxGrepMatches":                MaxGrepMatches,
			"maxGrepContext":                MaxGrepContext,
			"maxPatternLength":              MaxPatternLength,
			"maxListDirs":                   MaxListDirs,
			"maxDirNameLength":              MaxDirNameLength,
			"maxOsVersionLength":            MaxOSVersionLength,
			"maxShellNameLength":            MaxShellNameLength,
			"maxShellVersionLength":         MaxShellVersionLength,
			"minExitCode":                   MinExitCode,
			"maxExitCode":                   MaxExitCode,
		},
		"helloV2Limits":           DefaultHelloV2Limits,
		"reasonCodes":             ReasonCodes,
		"opErrorCodes":            OpErrorCodes,
		"deviceStreamClosedCodes": DeviceStreamClosedCodes,
		"eventsStreamClosedCodes": EventsStreamClosedCodes,
		"os":                      OSValues,
		"legacyOs":                LegacyOSValues,
		"arch":                    ArchValues,
		"legacyClientTargets":     LegacyClientTargets,
		"ops":                     Ops,
		"shellKinds":              ShellKinds,
		"grepModes":               GrepModes,
		"lineEndings":             LineEndings,
		"statKinds":               StatKinds,
		"pairingDecisions":        PairingDecisions,
		"userCodeAlphabet":        UserCodeAlphabet,
		"patterns": map[string]string{
			"userCode":         UserCodePattern,
			"deviceToken":      DeviceTokenPattern,
			"pollSecret":       PollSecretPattern,
			"id":               IDPattern,
			"version":          VersionPattern,
			"timestamp":        TimestampPattern,
			"sha256":           SHA256Pattern,
			"controlCharacter": ControlCharacterPattern,
			"urlPrefix":        URLPrefixPattern,
			"devicePath":       DevicePathPattern,
			"jobId":            JobIDPattern,
			"encoding":         EncodingPattern,
		},
		"headers": map[string]string{
			"clientVersion": ClientVersionHeader,
			"protocol":      ProtocolHeader,
		},
		"devicePaths": map[string]string{
			"pairings":             PairingsPath,
			"pairingPoll":          PairingPollPath,
			"stream":               DeviceStreamPath,
			"events":               DeviceEventsPath,
			"client":               ClientManifestPath,
			"installScript":        InstallScriptPath,
			"checksums":            ClientChecksumsPath,
			"downloadLinuxArm64":   ClientDownloadPath(OSLinux, ArchARM64),
			"downloadWindowsAmd64": ClientDownloadPath(OSWindows, ArchAMD64),
		},
		"deviceStreamEvents":   DeviceStreamEvents,
		"eventsStreamEvents":   EventsStreamEvents,
		"serverCommandV2Types": []string{CommandOp, CommandCancel, CommandRunEnded},
		"deviceEventV2Types":   []string{EventReply, EventDeviceInfo},
	}
	if !sameJSON(t, data, mustMarshal(actual)) {
		t.Fatalf("Go constants differ from testdata/contract.json:\n%s", mustMarshal(actual))
	}
}

func TestFormatTimestamp(t *testing.T) {
	stamp := FormatTimestamp(time.Date(2026, 10, 19, 13, 15, 30, 123456789, time.FixedZone("MSK", 3*3600)))
	if stamp != "2026-10-19T10:15:30.123Z" {
		t.Fatalf("got %s", stamp)
	}
	if err := checkTimestamp("at", stamp); err != nil {
		t.Fatal(err)
	}
}

func TestClientDownloadPath(t *testing.T) {
	if got := ClientDownloadPath(OSDarwin, ArchAMD64); got != "/connect/download/aiqsa-connect-darwin-amd64" {
		t.Fatalf("got %s", got)
	}
	if got := ClientBinaryName(OSWindows, ArchARM64); got != "aiqsa-connect-windows-arm64.exe" {
		t.Fatalf("got %s", got)
	}
}

const testRequestID = "e4da3b7f-bbce-4345-9777-2b0670b8a1c4"
const testRunID = "1679091c-5a88-4faf-afb5-e6087eb1b2dc"

func TestEveryOpHasArgsAndResults(t *testing.T) {
	for _, op := range Ops {
		args, ok := NewOpArgs(op)
		if !ok || args.ArgsOp() != op {
			t.Errorf("%s has no arguments type", op)
		}
		if newOpResults(op) == nil {
			t.Errorf("%s has no result type", op)
		}
	}
	if _, err := DecodeOpResult(OpWrite, []byte(`{"replacements":1}`)); err == nil {
		t.Error("an edit result was accepted for write")
	}
}

func TestUnknownOpCarriesRequestID(t *testing.T) {
	_, err := DecodeServerCommandV2([]byte(`{"type":"op","requestId":"` + testRequestID + `","runId":"` + testRunID + `","op":"upload","args":{},"deadlineMs":1000}`))
	var unknown *UnknownCommandError
	if !errors.As(err, &unknown) || unknown.Type != CommandOp || unknown.Op != "upload" || unknown.RequestID != testRequestID {
		t.Fatalf("got %v", err)
	}
	_, err = DecodeServerCommandV2([]byte(`{"type":"view_open","requestId":"` + testRequestID + `"}`))
	if !errors.As(err, &unknown) || unknown.Type != "view_open" || unknown.Op != "" || unknown.RequestID != testRequestID {
		t.Fatalf("got %v", err)
	}
	_, err = DecodeServerCommandV2([]byte(`{"type":"file_upload","requestId":"not-an-id"}`))
	if !errors.As(err, &unknown) || unknown.RequestID != "" {
		t.Fatalf("got %v", err)
	}
}

func TestOpCommandRoundTrip(t *testing.T) {
	path := "Documents"
	command := &OpCommand{
		Type: CommandOp, RequestID: testRequestID, RunID: testRunID, Op: OpGlob,
		Args: &GlobArgs{Pattern: "*.pdf", Cwd: "~", Path: &path}, DeadlineMs: 60_000,
	}
	if err := command.Validate(); err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeServerCommandV2(mustMarshal(command))
	if err != nil {
		t.Fatal(err)
	}
	op, ok := decoded.(*OpCommand)
	if !ok || op.CommandRequestID() != testRequestID {
		t.Fatalf("got %#v", decoded)
	}
	glob, ok := op.Args.(*GlobArgs)
	if !ok || glob.Pattern != "*.pdf" || glob.Path == nil || *glob.Path != path {
		t.Fatalf("got %#v", op.Args)
	}
	mismatched := *command
	mismatched.Args = &StatArgs{Path: "~"}
	if err := mismatched.Validate(); err == nil {
		t.Error("stat arguments were accepted for glob")
	}
}

func TestProtocol2LargeLimits(t *testing.T) {
	write := func(content string) []byte {
		return mustMarshal(map[string]any{
			"type": "op", "requestId": testRequestID, "runId": testRunID, "op": "write", "deadlineMs": 60_000,
			"args": map[string]any{"path": "a.txt", "cwd": "~", "content": content},
		})
	}
	if _, err := DecodeServerCommandV2(write(strings.Repeat("ж", MaxWriteBytes/2))); err != nil {
		t.Errorf("full write rejected: %v", err)
	}
	if _, err := DecodeServerCommandV2(write(strings.Repeat("ж", MaxWriteBytes/2) + "x")); err == nil {
		t.Error("oversize write accepted")
	}
	shell := func(stdout string) []byte {
		return mustMarshal(map[string]any{
			"exitCode": 0, "stdout": stdout, "stderr": "", "truncated": true, "stdoutBytes": 1 << 30, "stderrBytes": 0, "durationMs": 5,
		})
	}
	if _, err := DecodeOpResult(OpShell, shell(strings.Repeat("a", MaxStreamOutputBytes))); err != nil {
		t.Errorf("full output rejected: %v", err)
	}
	if _, err := DecodeOpResult(OpShell, shell(strings.Repeat("a", MaxStreamOutputBytes+1))); err == nil {
		t.Error("oversize output accepted")
	}
}

func TestOpReplyConstructors(t *testing.T) {
	reply, err := NewOpReplyResult(testRequestID, &OpRecentDirsResult{Home: `C:\Users\ivan`, Dirs: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeDeviceEventV2(mustMarshal(reply)); err != nil {
		t.Fatalf("encoded reply rejected: %v", err)
	}
	if _, err := NewOpReplyResult(testRequestID, &ListDirsResult{Path: "/", Dirs: nil}); err == nil {
		t.Error("a nil dirs list would encode as null and was accepted")
	}
	failure := NewOpReplyError(testRequestID, CodeComputerPathNotFound)
	if _, err := DecodeDeviceEventV2(mustMarshal(failure)); err != nil {
		t.Fatalf("encoded failure rejected: %v", err)
	}
	if err := NewOpReplyError(testRequestID, CodeDisabled).Validate(); err == nil {
		t.Error("a server-only code was accepted in an op reply")
	}
}
