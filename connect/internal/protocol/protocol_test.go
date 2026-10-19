package protocol

import (
	"bytes"
	"encoding/base64"
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
	"session":                 decodeInto[Session](),
	"pairingCreateRequest":    decodeInto[PairingCreateRequest](),
	"pairingCreateResponse":   decodeInto[PairingCreateResponse](),
	"pairingPollRequest":      decodeInto[PairingPollRequest](),
	"pairingPollResponse":     decodeInto[PairingPollResponse](),
	"pairingLookupResponse":   decodeInto[PairingLookupResponse](),
	"pairingDecisionRequest":  decodeInto[PairingDecisionRequest](),
	"pairingDecisionResponse": decodeInto[PairingDecisionResponse](),
	"deviceStreamEvent":       decodeStream(DecodeDeviceStreamEvent),
	"serverCommand": func(data []byte) (any, error) {
		return DecodeServerCommand(data)
	},
	"sessionCreateResult":  decodeInto[SessionCreateResult](),
	"sessionKillResult":    decodeInto[SessionKillResult](),
	"sessionHistoryResult": decodeInto[SessionHistoryResult](),
	"sessionOptionsResult": decodeInto[SessionOptionsResult](),
	"recentDirsResult":     decodeInto[RecentDirsResult](),
	"deviceEvent": func(data []byte) (any, error) {
		return DecodeDeviceEvent(data)
	},
	"deviceEventBatch":      decodeInto[EventBatch](),
	"clientManifest":        decodeInto[ClientManifest](),
	"devicesResponse":       decodeInto[DevicesResponse](),
	"sessionCreateRequest":  decodeInto[SessionCreateRequest](),
	"viewCreateRequest":     decodeInto[ViewCreateRequest](),
	"viewCreateResponse":    decodeInto[ViewCreateResponse](),
	"viewInputRequest":      decodeInto[ViewInputRequest](),
	"viewResizeRequest":     decodeInto[ViewResizeRequest](),
	"viewVisibilityRequest": decodeInto[ViewVisibilityRequest](),
	"eventsStreamEvent":     decodeStream(DecodeEventsStreamEvent),
	"viewStreamEvent":       decodeStream(DecodeViewStreamEvent),
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
		"protocolVersion": ProtocolVersion,
		"limits": map[string]any{
			"maxDevicesPerUser":             MaxDevicesPerUser,
			"maxSessionsPerDevice":          MaxSessionsPerDevice,
			"maxViewsPerDevice":             MaxViewsPerDevice,
			"maxEventsPerPost":              MaxEventsPerPost,
			"maxEventsBodyBytes":            MaxEventsBodyBytes,
			"maxOutputChunkBytes":           MaxOutputChunkBytes,
			"maxInputBytes":                 MaxInputBytes,
			"maxHistoryBytes":               MaxHistoryBytes,
			"replyTimeoutSeconds":           ReplyTimeoutSeconds,
			"heartbeatSeconds":              HeartbeatSeconds,
			"viewOrphanTimeoutSeconds":      ViewOrphanTimeoutSeconds,
			"pairingTtlSeconds":             PairingTTLSeconds,
			"pairingPollIntervalSeconds":    PairingPollIntervalSeconds,
			"pairingPollIntervalMaxSeconds": PairingPollIntervalMaxSeconds,
			"maxTitleLength":                MaxTitleLength,
			"maxCwdLength":                  MaxCwdLength,
			"maxRecentDirs":                 MaxRecentDirs,
			"maxSnapshotSessions":           MaxSnapshotSessions,
			"maxDeviceNameLength":           MaxDeviceNameLength,
			"maxHostnameLength":             MaxHostnameLength,
			"maxAccountLabelLength":         MaxAccountLabelLength,
			"maxSessionOptions":             MaxSessionOptions,
			"maxOptionLabelLength":          MaxOptionLabelLength,
			"maxAttachedClients":            MaxAttachedClients,
			"maxUrlLength":                  MaxURLLength,
			"maxClientBinaryBytes":          MaxClientBinaryBytes,
			"maxClientTargets":              MaxClientTargets,
			"maxSeq":                        MaxSeq,
			"minCols":                       MinCols,
			"maxCols":                       MaxCols,
			"minRows":                       MinRows,
			"maxRows":                       MaxRows,
		},
		"helloLimits":             DefaultHelloLimits,
		"reasonCodes":             ReasonCodes,
		"replyErrorCodes":         ReplyErrorCodes,
		"deviceStreamClosedCodes": DeviceStreamClosedCodes,
		"eventsStreamClosedCodes": EventsStreamClosedCodes,
		"viewClosedReasons":       ViewClosedReasons,
		"viewStreamClosedReasons": ViewStreamClosedReasons,
		"os":                      OSValues,
		"arch":                    ArchValues,
		"programs":                Programs,
		"sessionStatuses":         SessionStatuses,
		"statusReasons":           StatusReasons,
		"pairingDecisions":        PairingDecisions,
		"userCodeAlphabet":        UserCodeAlphabet,
		"patterns": map[string]string{
			"sessionId":        SessionIDPattern,
			"userCode":         UserCodePattern,
			"deviceToken":      DeviceTokenPattern,
			"pollSecret":       PollSecretPattern,
			"id":               IDPattern,
			"version":          VersionPattern,
			"timestamp":        TimestampPattern,
			"sha256":           SHA256Pattern,
			"optionKey":        OptionKeyPattern,
			"base64":           Base64Pattern,
			"controlCharacter": ControlCharacterPattern,
			"requestedCwd":     RequestedCwdPattern,
			"absolutePath":     AbsolutePathPattern,
			"urlPrefix":        URLPrefixPattern,
		},
		"devicePaths": map[string]string{
			"pairings":           PairingsPath,
			"pairingPoll":        PairingPollPath,
			"stream":             DeviceStreamPath,
			"events":             DeviceEventsPath,
			"client":             ClientManifestPath,
			"installScript":      InstallScriptPath,
			"checksums":          ClientChecksumsPath,
			"downloadLinuxArm64": ClientDownloadPath(OSLinux, ArchARM64),
		},
		"deviceStreamEvents": DeviceStreamEvents,
		"eventsStreamEvents": EventsStreamEvents,
		"viewStreamEvents":   ViewStreamEvents,
		"serverCommandTypes": []string{
			CommandViewOpen, CommandViewInput, CommandViewResize, CommandViewClose, CommandSessionCreate,
			CommandSessionKill, CommandSessionHistory, CommandSessionOptions, CommandRecentDirs,
		},
		"requestCommandTypes": []string{
			CommandSessionCreate, CommandSessionKill, CommandSessionHistory, CommandSessionOptions, CommandRecentDirs,
		},
		"deviceEventTypes": []string{EventSessions, EventStatus, EventOutput, EventViewClosed, EventReply},
	}
	if !sameJSON(t, data, mustMarshal(actual)) {
		t.Fatalf("Go constants differ from testdata/contract.json:\n%s", mustMarshal(actual))
	}
}

func TestEveryRequestCommandHasAResultType(t *testing.T) {
	for _, commandType := range []string{CommandSessionCreate, CommandSessionKill, CommandSessionHistory, CommandSessionOptions, CommandRecentDirs} {
		if _, ok := newCommandResult(commandType); !ok {
			t.Errorf("%s has no result type", commandType)
		}
	}
	if _, err := DecodeCommandResult(CommandSessionHistory, []byte(`{"sessionId":"ac-k3x9q2"}`)); err == nil {
		t.Error("a session_create result was accepted for session_history")
	}
}

const testViewID = "c4ca4238-a0b9-4382-8dcc-509a6f75849b"
const testRequestID = "e4da3b7f-bbce-4345-9777-2b0670b8a1c4"

func TestLargeLimits(t *testing.T) {
	output := func(size int) []byte {
		return mustMarshal(map[string]any{
			"type": "output", "viewId": testViewID, "seq": 1,
			"data": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{'x'}, size)),
		})
	}
	if _, err := DecodeDeviceEvent(output(MaxOutputChunkBytes)); err != nil {
		t.Errorf("full output chunk rejected: %v", err)
	}
	if _, err := DecodeDeviceEvent(output(MaxOutputChunkBytes + 1)); err == nil {
		t.Error("oversize output chunk accepted")
	}

	input := func(data string) []byte {
		return mustMarshal(map[string]any{"type": "view_input", "viewId": testViewID, "data": data})
	}
	// "ж" is two UTF-8 bytes: the limit counts bytes, not characters.
	if _, err := DecodeServerCommand(input(strings.Repeat("ж", MaxInputBytes/2))); err != nil {
		t.Errorf("full input rejected: %v", err)
	}
	if _, err := DecodeServerCommand(input(strings.Repeat("ж", MaxInputBytes/2) + "x")); err == nil {
		t.Error("oversize input accepted")
	}

	history := func(size int) []byte {
		return mustMarshal(map[string]any{"text": strings.Repeat("a", size)})
	}
	if _, err := DecodeCommandResult(CommandSessionHistory, history(MaxHistoryBytes)); err != nil {
		t.Errorf("full history rejected: %v", err)
	}
	if _, err := DecodeCommandResult(CommandSessionHistory, history(MaxHistoryBytes+1)); err == nil {
		t.Error("oversize history accepted")
	}

	// Text limits count code points: 80 astral characters fit a title.
	title := strings.Repeat("😀", MaxTitleLength)
	create := func(title string) []byte {
		return mustMarshal(map[string]any{"type": "session_create", "requestId": testRequestID, "program": "shell", "cwd": "~", "title": title})
	}
	if _, err := DecodeServerCommand(create(title)); err != nil {
		t.Errorf("80-character title rejected: %v", err)
	}
	if _, err := DecodeServerCommand(create(title + "😀")); err == nil {
		t.Error("81-character title accepted")
	}
}

func TestUnknownCommandCarriesRequestID(t *testing.T) {
	_, err := DecodeServerCommand([]byte(`{"type":"file_upload","requestId":"` + testRequestID + `","path":"/x"}`))
	var unknown *UnknownCommandError
	if !errors.As(err, &unknown) || unknown.Type != "file_upload" || unknown.RequestID != testRequestID {
		t.Fatalf("got %v", err)
	}
	_, err = DecodeServerCommand([]byte(`{"type":"file_upload","requestId":"not-an-id"}`))
	if !errors.As(err, &unknown) || unknown.RequestID != "" {
		t.Fatalf("got %v", err)
	}
}

func TestReplyConstructors(t *testing.T) {
	reply, err := NewReplyResult(testRequestID, &RecentDirsResult{Home: "/home/user", Dirs: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := reply.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeDeviceEvent(mustMarshal(reply)); err != nil {
		t.Fatalf("encoded reply rejected: %v", err)
	}
	if _, err := NewReplyResult(testRequestID, &RecentDirsResult{Home: "/home/user"}); err == nil {
		t.Error("a nil dirs list would encode as null and was accepted")
	}
	failure := NewReplyError(testRequestID, CodeSessionNotFound)
	if _, err := DecodeDeviceEvent(mustMarshal(failure)); err != nil {
		t.Fatalf("encoded failure rejected: %v", err)
	}
	if err := NewReplyError(testRequestID, CodeDisabled).Validate(); err == nil {
		t.Error("a server-only code was accepted in a reply")
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
}
