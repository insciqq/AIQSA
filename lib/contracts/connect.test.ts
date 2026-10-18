import type { z } from "zod";

import contract from "../../connect/internal/protocol/testdata/contract.json";
import {
  CONNECT_ABSOLUTE_PATH_PATTERN,
  CONNECT_ARCH_VALUES,
  CONNECT_BASE64_PATTERN,
  CONNECT_CLIENT_CHECKSUMS_PATH,
  CONNECT_CLIENT_MANIFEST_PATH,
  CONNECT_CONTROL_CHARACTER_PATTERN,
  CONNECT_DEFAULT_HELLO_LIMITS,
  CONNECT_DEVICE_EVENTS_PATH,
  CONNECT_DEVICE_STREAM_CLOSED_CODES,
  CONNECT_DEVICE_STREAM_EVENTS,
  CONNECT_DEVICE_STREAM_PATH,
  CONNECT_DEVICE_TOKEN_PATTERN,
  CONNECT_EVENTS_STREAM_CLOSED_CODES,
  CONNECT_EVENTS_STREAM_EVENTS,
  CONNECT_HEARTBEAT_SECONDS,
  CONNECT_ID_PATTERN,
  CONNECT_INSTALL_SCRIPT_PATH,
  CONNECT_MAX_ATTACHED_CLIENTS,
  CONNECT_MAX_CLIENT_BINARY_BYTES,
  CONNECT_MAX_CLIENT_TARGETS,
  CONNECT_MAX_COLS,
  CONNECT_MAX_CWD_LENGTH,
  CONNECT_MAX_DEVICE_NAME_LENGTH,
  CONNECT_MAX_DEVICES_PER_USER,
  CONNECT_MAX_EVENTS_BODY_BYTES,
  CONNECT_MAX_EVENTS_PER_POST,
  CONNECT_MAX_HISTORY_BYTES,
  CONNECT_MAX_HOSTNAME_LENGTH,
  CONNECT_MAX_INPUT_BYTES,
  CONNECT_MAX_OPTION_LABEL_LENGTH,
  CONNECT_MAX_OUTPUT_CHUNK_BYTES,
  CONNECT_MAX_RECENT_DIRS,
  CONNECT_MAX_ROWS,
  CONNECT_MAX_SEQ,
  CONNECT_MAX_SESSION_OPTIONS,
  CONNECT_MAX_SESSIONS_PER_DEVICE,
  CONNECT_MAX_SNAPSHOT_SESSIONS,
  CONNECT_MAX_TITLE_LENGTH,
  CONNECT_MAX_URL_LENGTH,
  CONNECT_MAX_VIEWS_PER_DEVICE,
  CONNECT_MIN_COLS,
  CONNECT_MIN_ROWS,
  CONNECT_OPTION_KEY_PATTERN,
  CONNECT_OS_VALUES,
  CONNECT_PAIRING_DECISIONS,
  CONNECT_PAIRING_POLL_INTERVAL_MAX_SECONDS,
  CONNECT_PAIRING_POLL_INTERVAL_SECONDS,
  CONNECT_PAIRING_POLL_PATH,
  CONNECT_PAIRING_TTL_SECONDS,
  CONNECT_PAIRINGS_PATH,
  CONNECT_POLL_SECRET_PATTERN,
  CONNECT_PROGRAMS,
  CONNECT_PROTOCOL_VERSION,
  CONNECT_REASON_CODES,
  CONNECT_REPLY_ERROR_CODES,
  CONNECT_REPLY_TIMEOUT_SECONDS,
  CONNECT_REQUESTED_CWD_PATTERN,
  CONNECT_SESSION_ID_PATTERN,
  CONNECT_SESSION_STATUSES,
  CONNECT_SHA256_PATTERN,
  CONNECT_STATUS_REASONS,
  CONNECT_TIMESTAMP_PATTERN,
  CONNECT_URL_PREFIX_PATTERN,
  CONNECT_USER_CODE_ALPHABET,
  CONNECT_USER_CODE_PATTERN,
  CONNECT_VERSION_PATTERN,
  CONNECT_VIEW_CLOSED_REASONS,
  CONNECT_VIEW_ORPHAN_TIMEOUT_SECONDS,
  CONNECT_VIEW_STREAM_CLOSED_REASONS,
  CONNECT_VIEW_STREAM_EVENTS,
  connectClientDownloadPath,
  connectClientManifestSchema,
  connectCommandResultSchemas,
  connectDeviceEventBatchSchema,
  connectDeviceEventSchema,
  connectDeviceSessionPath,
  connectDeviceSessionsPath,
  connectDeviceStreamEventSchema,
  connectDevicesResponseSchema,
  connectErrorResponseSchema,
  connectEventsStreamEventSchema,
  connectPairingByCodePath,
  connectPairingCreateRequestSchema,
  connectPairingCreateResponseSchema,
  connectPairingDecisionRequestSchema,
  connectPairingDecisionResponseSchema,
  connectPairingLookupResponseSchema,
  connectPairingPollRequestSchema,
  connectPairingPollResponseSchema,
  connectPairPagePath,
  connectRecentDirsPath,
  connectRecentDirsResultSchema,
  connectServerCommandSchema,
  connectSessionCreateRequestSchema,
  connectSessionCreateResultSchema,
  connectSessionHistoryPath,
  connectSessionHistoryResultSchema,
  connectSessionKillResultSchema,
  connectSessionOptionsPath,
  connectSessionOptionsResultSchema,
  connectSessionPath,
  connectSessionSchema,
  connectUtf8ByteLength,
  connectViewCreateRequestSchema,
  connectViewCreateResponseSchema,
  connectViewInputPath,
  connectViewInputRequestSchema,
  connectViewPath,
  connectViewResizePath,
  connectViewResizeRequestSchema,
  connectViewStreamEventSchema,
  connectViewStreamPath,
  connectViewVisibilityPath,
  connectViewVisibilityRequestSchema,
  decodeConnectDevicesResponse,
  decodeConnectErrorResponse,
  decodeConnectEventsStreamEvent,
  decodeConnectViewStreamEvent,
  normalizeConnectUserCode,
  parseConnectCommandResult
} from "./connect";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true; import: "default"; query: "?raw" }): Record<string, string>;
  }
}

/**
 * Fixture convention shared with connect/internal/protocol/protocol_test.go:
 * testdata/{valid,invalid}/<schema>.<case>.json, where <schema> names an
 * entry below and of the Go registry. A fixture is one JSON value; stream
 * events are {"event": <SSE event name>, "data": <data>}.
 */
const fixtureSchemas: Readonly<Record<string, z.ZodType>> = {
  errorResponse: connectErrorResponseSchema,
  session: connectSessionSchema,
  pairingCreateRequest: connectPairingCreateRequestSchema,
  pairingCreateResponse: connectPairingCreateResponseSchema,
  pairingPollRequest: connectPairingPollRequestSchema,
  pairingPollResponse: connectPairingPollResponseSchema,
  pairingLookupResponse: connectPairingLookupResponseSchema,
  pairingDecisionRequest: connectPairingDecisionRequestSchema,
  pairingDecisionResponse: connectPairingDecisionResponseSchema,
  deviceStreamEvent: connectDeviceStreamEventSchema,
  serverCommand: connectServerCommandSchema,
  sessionCreateResult: connectSessionCreateResultSchema,
  sessionKillResult: connectSessionKillResultSchema,
  sessionHistoryResult: connectSessionHistoryResultSchema,
  sessionOptionsResult: connectSessionOptionsResultSchema,
  recentDirsResult: connectRecentDirsResultSchema,
  deviceEvent: connectDeviceEventSchema,
  deviceEventBatch: connectDeviceEventBatchSchema,
  clientManifest: connectClientManifestSchema,
  devicesResponse: connectDevicesResponseSchema,
  sessionCreateRequest: connectSessionCreateRequestSchema,
  viewCreateRequest: connectViewCreateRequestSchema,
  viewCreateResponse: connectViewCreateResponseSchema,
  viewInputRequest: connectViewInputRequestSchema,
  viewResizeRequest: connectViewResizeRequestSchema,
  viewVisibilityRequest: connectViewVisibilityRequestSchema,
  eventsStreamEvent: connectEventsStreamEventSchema,
  viewStreamEvent: connectViewStreamEventSchema
};

type Fixture = Readonly<{ name: string; schema: string; value: unknown }>;

function fixtures(files: Record<string, string>): Fixture[] {
  return Object.entries(files).map(([path, raw]) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return { name, schema: name.slice(0, name.indexOf(".")), value: JSON.parse(raw) as unknown };
  });
}

const validFixtures = fixtures(import.meta.glob("../../connect/internal/protocol/testdata/valid/*.json", {
  eager: true,
  import: "default",
  query: "?raw"
}));
const invalidFixtures = fixtures(import.meta.glob("../../connect/internal/protocol/testdata/invalid/*.json", {
  eager: true,
  import: "default",
  query: "?raw"
}));

const DEVICE_ID = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const VIEW_ID = "c4ca4238-a0b9-4382-8dcc-509a6f75849b";
const REQUEST_ID = "e4da3b7f-bbce-4345-9777-2b0670b8a1c4";
const SESSION_ID = "ac-k3x9q2";

describe("connect contract fixtures", () => {
  it("loads fixtures for every schema", () => {
    expect(validFixtures.length).toBeGreaterThan(0);
    expect(invalidFixtures.length).toBeGreaterThan(0);
    const covered = new Set(validFixtures.map((fixture) => fixture.schema));
    expect(Object.keys(fixtureSchemas).filter((schema) => !covered.has(schema))).toEqual([]);
    const unknown = [...validFixtures, ...invalidFixtures].filter((fixture) => !(fixture.schema in fixtureSchemas));
    expect(unknown.map((fixture) => fixture.name)).toEqual([]);
  });

  it("accepts every valid fixture unchanged", () => {
    const failures = validFixtures.flatMap((fixture) => {
      const decoded = fixtureSchemas[fixture.schema]!.safeParse(fixture.value);
      if (!decoded.success) return [`${fixture.name}: ${decoded.error.message}`];
      return JSON.stringify(decoded.data) === JSON.stringify(fixture.value) ? [] : [`${fixture.name}: changed`];
    });
    expect(failures).toEqual([]);
  });

  it("rejects every invalid fixture", () => {
    const accepted = invalidFixtures
      .filter((fixture) => fixtureSchemas[fixture.schema]!.safeParse(fixture.value).success)
      .map((fixture) => fixture.name);
    expect(accepted).toEqual([]);
  });
});

describe("connect contract constants", () => {
  it("match the contract shared with the Go client", () => {
    const optionValues = <T extends { options: readonly { shape: { type: { value: string } } }[] }>(schema: T) =>
      schema.options.map((option) => option.shape.type.value);
    expect({
      protocolVersion: CONNECT_PROTOCOL_VERSION,
      limits: {
        maxDevicesPerUser: CONNECT_MAX_DEVICES_PER_USER,
        maxSessionsPerDevice: CONNECT_MAX_SESSIONS_PER_DEVICE,
        maxViewsPerDevice: CONNECT_MAX_VIEWS_PER_DEVICE,
        maxEventsPerPost: CONNECT_MAX_EVENTS_PER_POST,
        maxEventsBodyBytes: CONNECT_MAX_EVENTS_BODY_BYTES,
        maxOutputChunkBytes: CONNECT_MAX_OUTPUT_CHUNK_BYTES,
        maxInputBytes: CONNECT_MAX_INPUT_BYTES,
        maxHistoryBytes: CONNECT_MAX_HISTORY_BYTES,
        replyTimeoutSeconds: CONNECT_REPLY_TIMEOUT_SECONDS,
        heartbeatSeconds: CONNECT_HEARTBEAT_SECONDS,
        viewOrphanTimeoutSeconds: CONNECT_VIEW_ORPHAN_TIMEOUT_SECONDS,
        pairingTtlSeconds: CONNECT_PAIRING_TTL_SECONDS,
        pairingPollIntervalSeconds: CONNECT_PAIRING_POLL_INTERVAL_SECONDS,
        pairingPollIntervalMaxSeconds: CONNECT_PAIRING_POLL_INTERVAL_MAX_SECONDS,
        maxTitleLength: CONNECT_MAX_TITLE_LENGTH,
        maxCwdLength: CONNECT_MAX_CWD_LENGTH,
        maxRecentDirs: CONNECT_MAX_RECENT_DIRS,
        maxSnapshotSessions: CONNECT_MAX_SNAPSHOT_SESSIONS,
        maxDeviceNameLength: CONNECT_MAX_DEVICE_NAME_LENGTH,
        maxHostnameLength: CONNECT_MAX_HOSTNAME_LENGTH,
        maxSessionOptions: CONNECT_MAX_SESSION_OPTIONS,
        maxOptionLabelLength: CONNECT_MAX_OPTION_LABEL_LENGTH,
        maxAttachedClients: CONNECT_MAX_ATTACHED_CLIENTS,
        maxUrlLength: CONNECT_MAX_URL_LENGTH,
        maxClientBinaryBytes: CONNECT_MAX_CLIENT_BINARY_BYTES,
        maxClientTargets: CONNECT_MAX_CLIENT_TARGETS,
        maxSeq: CONNECT_MAX_SEQ,
        minCols: CONNECT_MIN_COLS,
        maxCols: CONNECT_MAX_COLS,
        minRows: CONNECT_MIN_ROWS,
        maxRows: CONNECT_MAX_ROWS
      },
      helloLimits: CONNECT_DEFAULT_HELLO_LIMITS,
      reasonCodes: CONNECT_REASON_CODES,
      replyErrorCodes: CONNECT_REPLY_ERROR_CODES,
      deviceStreamClosedCodes: CONNECT_DEVICE_STREAM_CLOSED_CODES,
      eventsStreamClosedCodes: CONNECT_EVENTS_STREAM_CLOSED_CODES,
      viewClosedReasons: CONNECT_VIEW_CLOSED_REASONS,
      viewStreamClosedReasons: CONNECT_VIEW_STREAM_CLOSED_REASONS,
      os: CONNECT_OS_VALUES,
      arch: CONNECT_ARCH_VALUES,
      programs: CONNECT_PROGRAMS,
      sessionStatuses: CONNECT_SESSION_STATUSES,
      statusReasons: CONNECT_STATUS_REASONS,
      pairingDecisions: CONNECT_PAIRING_DECISIONS,
      userCodeAlphabet: CONNECT_USER_CODE_ALPHABET,
      patterns: {
        sessionId: CONNECT_SESSION_ID_PATTERN.source,
        userCode: CONNECT_USER_CODE_PATTERN.source,
        deviceToken: CONNECT_DEVICE_TOKEN_PATTERN.source,
        pollSecret: CONNECT_POLL_SECRET_PATTERN.source,
        id: CONNECT_ID_PATTERN.source,
        version: CONNECT_VERSION_PATTERN.source,
        timestamp: CONNECT_TIMESTAMP_PATTERN.source,
        sha256: CONNECT_SHA256_PATTERN.source,
        optionKey: CONNECT_OPTION_KEY_PATTERN.source,
        base64: CONNECT_BASE64_PATTERN.source,
        controlCharacter: CONNECT_CONTROL_CHARACTER_PATTERN.source,
        requestedCwd: CONNECT_REQUESTED_CWD_PATTERN.source,
        absolutePath: CONNECT_ABSOLUTE_PATH_PATTERN.source,
        urlPrefix: CONNECT_URL_PREFIX_PATTERN.source
      },
      devicePaths: {
        pairings: CONNECT_PAIRINGS_PATH,
        pairingPoll: CONNECT_PAIRING_POLL_PATH,
        stream: CONNECT_DEVICE_STREAM_PATH,
        events: CONNECT_DEVICE_EVENTS_PATH,
        client: CONNECT_CLIENT_MANIFEST_PATH,
        installScript: CONNECT_INSTALL_SCRIPT_PATH,
        checksums: CONNECT_CLIENT_CHECKSUMS_PATH,
        downloadLinuxArm64: connectClientDownloadPath("linux", "arm64")
      },
      deviceStreamEvents: CONNECT_DEVICE_STREAM_EVENTS,
      eventsStreamEvents: CONNECT_EVENTS_STREAM_EVENTS,
      viewStreamEvents: CONNECT_VIEW_STREAM_EVENTS,
      serverCommandTypes: optionValues(connectServerCommandSchema),
      requestCommandTypes: Object.keys(connectCommandResultSchemas),
      deviceEventTypes: connectDeviceEventSchema.options.map((option) =>
        "shape" in option ? option.shape.type.value : option.options[0].shape.type.value)
    }).toEqual(contract);
  });

  it("names every SSE event its stream schema accepts", () => {
    const names = (schema: { options: readonly { shape: { event: { value: string } } }[] }) =>
      schema.options.map((option) => option.shape.event.value);
    expect(names(connectDeviceStreamEventSchema)).toEqual([...CONNECT_DEVICE_STREAM_EVENTS]);
    expect(names(connectEventsStreamEventSchema)).toEqual([...CONNECT_EVENTS_STREAM_EVENTS]);
    expect(names(connectViewStreamEventSchema)).toEqual([...CONNECT_VIEW_STREAM_EVENTS]);
  });

  it("uses an unambiguous pairing code alphabet", () => {
    expect(CONNECT_USER_CODE_ALPHABET).not.toMatch(/[01ILOU]/u);
    expect(new Set(CONNECT_USER_CODE_ALPHABET).size).toBe(CONNECT_USER_CODE_ALPHABET.length);
    expect(normalizeConnectUserCode(" bcdf 2345 ")).toBe("BCDF-2345");
    expect(normalizeConnectUserCode("bcdf-2345")).toBe("BCDF-2345");
    expect(normalizeConnectUserCode("BCD0-2345")).toBeNull();
    expect(normalizeConnectUserCode("BCDF-234")).toBeNull();
  });
});

describe("connect contract size limits", () => {
  const output = (size: number) => ({
    type: "output",
    viewId: VIEW_ID,
    seq: 1,
    data: btoa("x".repeat(size))
  });

  it("bounds decoded output chunks", () => {
    expect(connectDeviceEventSchema.safeParse(output(CONNECT_MAX_OUTPUT_CHUNK_BYTES)).success).toBe(true);
    expect(connectDeviceEventSchema.safeParse(output(CONNECT_MAX_OUTPUT_CHUNK_BYTES + 1)).success).toBe(false);
  });

  it("counts input in UTF-8 bytes", () => {
    const full = "ж".repeat(CONNECT_MAX_INPUT_BYTES / 2);
    expect(connectUtf8ByteLength(full)).toBe(CONNECT_MAX_INPUT_BYTES);
    expect(connectUtf8ByteLength("😀")).toBe(4);
    expect(connectViewInputRequestSchema.safeParse({ data: full }).success).toBe(true);
    expect(connectViewInputRequestSchema.safeParse({ data: `${full}x` }).success).toBe(false);
    expect(connectServerCommandSchema.safeParse({ type: "view_input", viewId: VIEW_ID, data: `${full}x` }).success)
      .toBe(false);
  });

  it("bounds history text", () => {
    expect(connectSessionHistoryResultSchema.safeParse({ text: "a".repeat(CONNECT_MAX_HISTORY_BYTES) }).success)
      .toBe(true);
    expect(connectSessionHistoryResultSchema.safeParse({ text: "a".repeat(CONNECT_MAX_HISTORY_BYTES + 1) }).success)
      .toBe(false);
  });

  it("counts titles in code points", () => {
    const title = "😀".repeat(CONNECT_MAX_TITLE_LENGTH);
    const create = (value: string) => ({ type: "session_create", requestId: REQUEST_ID, program: "shell", cwd: "~", title: value });
    expect(connectServerCommandSchema.safeParse(create(title)).success).toBe(true);
    expect(connectServerCommandSchema.safeParse(create(`${title}😀`)).success).toBe(false);
  });
});

describe("connect command results", () => {
  it("checks a reply result against the command it answers", () => {
    expect(parseConnectCommandResult("session_create", { sessionId: SESSION_ID })).toEqual({ sessionId: SESSION_ID });
    expect(parseConnectCommandResult("session_history", { sessionId: SESSION_ID })).toBeNull();
    expect(parseConnectCommandResult("session_kill", {})).toEqual({});
    expect(parseConnectCommandResult("recent_dirs", { home: "/home/user", dirs: [] }))
      .toEqual({ home: "/home/user", dirs: [] });
  });
});

describe("connect paths", () => {
  it("builds browser API and page paths with encoded segments", () => {
    expect(connectPairingByCodePath("BCDF-2345")).toBe("/api/connect/pairings/by-code/BCDF-2345");
    expect(connectDeviceSessionsPath(DEVICE_ID)).toBe(`/api/connect/devices/${DEVICE_ID}/sessions`);
    expect(connectDeviceSessionPath(DEVICE_ID, SESSION_ID)).toBe(`/api/connect/devices/${DEVICE_ID}/sessions/${SESSION_ID}`);
    expect(connectSessionHistoryPath(DEVICE_ID, SESSION_ID)).toBe(`/api/connect/devices/${DEVICE_ID}/sessions/${SESSION_ID}/history`);
    expect(connectSessionOptionsPath(DEVICE_ID, SESSION_ID)).toBe(`/api/connect/devices/${DEVICE_ID}/sessions/${SESSION_ID}/options`);
    expect(connectRecentDirsPath(DEVICE_ID)).toBe(`/api/connect/devices/${DEVICE_ID}/recent-dirs`);
    expect(connectViewPath(VIEW_ID)).toBe(`/api/connect/views/${VIEW_ID}`);
    expect(connectViewStreamPath(VIEW_ID)).toBe(`/api/connect/views/${VIEW_ID}/stream`);
    expect(connectViewInputPath(VIEW_ID)).toBe(`/api/connect/views/${VIEW_ID}/input`);
    expect(connectViewResizePath(VIEW_ID)).toBe(`/api/connect/views/${VIEW_ID}/resize`);
    expect(connectViewVisibilityPath(VIEW_ID)).toBe(`/api/connect/views/${VIEW_ID}/visibility`);
    expect(connectPairPagePath("BCDF-2345")).toBe("/connect/pair?code=BCDF-2345");
    expect(connectSessionPath(DEVICE_ID, SESSION_ID)).toBe(`/connect/${DEVICE_ID}/${SESSION_ID}`);
    expect(connectViewPath("../x")).toBe("/api/connect/views/..%2Fx");
  });
});

describe("connect browser decoders", () => {
  it("returns null for invalid values", () => {
    expect(decodeConnectErrorResponse({ code: "connect_disabled" })).toEqual({ code: "connect_disabled" });
    expect(decodeConnectErrorResponse({ code: "nope" })).toBeNull();
    expect(decodeConnectDevicesResponse({ devices: [] })).toEqual({ devices: [] });
    expect(decodeConnectDevicesResponse(null)).toBeNull();
  });

  it("decodes SSE frames from the event name and raw data", () => {
    expect(decodeConnectEventsStreamEvent("ping", "{}")).toEqual({ event: "ping", data: {} });
    expect(decodeConnectEventsStreamEvent("devices", "not json")).toBeNull();
    expect(decodeConnectViewStreamEvent("closed", JSON.stringify({ reason: "session_ended" })))
      .toEqual({ event: "closed", data: { reason: "session_ended" } });
    expect(decodeConnectViewStreamEvent("message", "{}")).toBeNull();
  });
});
