import { z } from "zod";

import contract from "../../connect/internal/protocol/testdata/contract.json";
import { connectComputerEventsStreamEventSchema, connectComputerListResponseSchema } from "./computer";
import {
  CONNECT_ARCH_VALUES,
  CONNECT_CLIENT_CHECKSUMS_PATH,
  CONNECT_CLIENT_MANIFEST_PATH,
  CONNECT_CLIENT_VERSION_HEADER,
  CONNECT_CONTROL_CHARACTER_PATTERN,
  CONNECT_DEFAULT_HELLO_V2_LIMITS,
  CONNECT_DEFAULT_READ_LINES,
  CONNECT_DEFAULT_SHELL_TIMEOUT_SECONDS,
  CONNECT_DEVICE_EVENTS_PATH,
  CONNECT_DEVICE_PATH_PATTERN,
  CONNECT_DEVICE_SELF_PATH,
  CONNECT_DEVICE_STREAM_CLOSED_CODES,
  CONNECT_DEVICE_STREAM_EVENTS,
  CONNECT_DEVICE_STREAM_PATH,
  CONNECT_DEVICE_TOKEN_PATTERN,
  CONNECT_ENCODING_PATTERN,
  CONNECT_EVENTS_STREAM_CLOSED_CODES,
  CONNECT_EVENTS_STREAM_EVENTS,
  CONNECT_GREP_MODES,
  CONNECT_HEARTBEAT_SECONDS,
  CONNECT_ID_PATTERN,
  CONNECT_INSTALL_SCRIPT_PATH,
  CONNECT_JOB_ID_PATTERN,
  CONNECT_LEGACY_CLIENT_TARGETS,
  CONNECT_LEGACY_MAX_CLIENT_TARGETS,
  CONNECT_LEGACY_OS_VALUES,
  CONNECT_LEGACY_PROTOCOL_VERSION,
  CONNECT_LINE_ENDINGS,
  CONNECT_MAX_ACCOUNT_LABEL_LENGTH,
  CONNECT_MAX_CLIENT_BINARY_BYTES,
  CONNECT_MAX_CLIENT_TARGETS,
  CONNECT_MAX_COMMAND_BYTES,
  CONNECT_MAX_CONCURRENT_OPS,
  CONNECT_MAX_CWD_LENGTH,
  CONNECT_MAX_DEVICE_NAME_LENGTH,
  CONNECT_MAX_DEVICES_PER_USER,
  CONNECT_MAX_DIR_NAME_LENGTH,
  CONNECT_MAX_EVENTS_BODY_BYTES,
  CONNECT_MAX_EVENTS_PER_POST,
  CONNECT_MAX_EXIT_CODE,
  CONNECT_MAX_GLOB_PATHS,
  CONNECT_MAX_GREP_CONTEXT,
  CONNECT_MAX_GREP_MATCHES,
  CONNECT_MAX_HOSTNAME_LENGTH,
  CONNECT_MAX_JOB_BUFFER_BYTES,
  CONNECT_MAX_JOB_WAIT_SECONDS,
  CONNECT_MAX_JOBS,
  CONNECT_MAX_LINE_BYTES,
  CONNECT_MAX_LINE_NUMBER,
  CONNECT_MAX_LIST_DIRS,
  CONNECT_MAX_OP_DEADLINE_MS,
  CONNECT_MAX_OS_VERSION_LENGTH,
  CONNECT_MAX_PATTERN_LENGTH,
  CONNECT_MAX_READ_BYTES,
  CONNECT_MAX_READ_LINE_LENGTH,
  CONNECT_MAX_READ_LINES,
  CONNECT_MAX_RECENT_DIRS,
  CONNECT_MAX_REPLY_BYTES,
  CONNECT_MAX_SEQ,
  CONNECT_MAX_SHELL_NAME_LENGTH,
  CONNECT_MAX_SHELL_TIMEOUT_SECONDS,
  CONNECT_MAX_SHELL_VERSION_LENGTH,
  CONNECT_MAX_STREAM_OUTPUT_BYTES,
  CONNECT_MAX_URL_LENGTH,
  CONNECT_MAX_WRITE_BYTES,
  CONNECT_MIN_EXIT_CODE,
  CONNECT_OP_ERROR_CODES,
  CONNECT_OPS,
  CONNECT_OS_VALUES,
  CONNECT_OUTPUT_HEAD_BYTES,
  CONNECT_OUTPUT_TAIL_BYTES,
  CONNECT_PAIRING_DECISIONS,
  CONNECT_PAIRING_POLL_INTERVAL_MAX_SECONDS,
  CONNECT_PAIRING_POLL_INTERVAL_SECONDS,
  CONNECT_PAIRING_POLL_PATH,
  CONNECT_PAIRING_TTL_SECONDS,
  CONNECT_PAIRINGS_PATH,
  CONNECT_POLL_SECRET_PATTERN,
  CONNECT_PROTOCOL_HEADER,
  CONNECT_PROTOCOL_VERSION,
  CONNECT_REASON_CODES,
  CONNECT_SHA256_PATTERN,
  CONNECT_SHELL_KINDS,
  CONNECT_STAT_KINDS,
  CONNECT_TIMESTAMP_PATTERN,
  CONNECT_URL_PREFIX_PATTERN,
  CONNECT_USER_CODE_ALPHABET,
  CONNECT_USER_CODE_PATTERN,
  CONNECT_VERSION_PATTERN,
  connectClientBinaryName,
  connectClientDownloadPath,
  connectClientManifestSchema,
  connectDeviceEventBatchV2Schema,
  connectDeviceEventV2Schema,
  connectDeviceStreamEventV2Schema,
  connectErrorResponseSchema,
  connectLegacyClientManifestSchema,
  connectOpArgsSchemas,
  connectOpResultSchemas,
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
  connectServerCommandV2Schema,
  connectUtf8ByteLength,
  decodeConnectErrorResponse,
  normalizeConnectUserCode,
  parseConnectOpResult
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
  pairingCreateRequest: connectPairingCreateRequestSchema,
  pairingCreateResponse: connectPairingCreateResponseSchema,
  pairingPollRequest: connectPairingPollRequestSchema,
  pairingPollResponse: connectPairingPollResponseSchema,
  pairingLookupResponse: connectPairingLookupResponseSchema,
  pairingDecisionRequest: connectPairingDecisionRequestSchema,
  pairingDecisionResponse: connectPairingDecisionResponseSchema,
  clientManifest: connectClientManifestSchema,
  deviceStreamEventV2: connectDeviceStreamEventV2Schema,
  serverCommandV2: connectServerCommandV2Schema,
  /** `{op, result}`: the result checked against the op it answers, as `parseConnectOpResult` does. */
  opResult: z.strictObject({ op: z.enum(CONNECT_OPS), result: z.unknown() }).transform((value, context) => {
    const result = parseConnectOpResult(value.op, value.result);
    if (result === null) {
      context.addIssue({ code: "custom", message: "result does not match op" });
      return z.NEVER;
    }
    return { op: value.op, result };
  }),
  deviceEventV2: connectDeviceEventV2Schema,
  deviceEventBatchV2: connectDeviceEventBatchV2Schema,
  legacyClientManifest: connectLegacyClientManifestSchema
};

/**
 * Protocol 1 (terminal) fixtures the server no longer speaks. The Go client
 * removes them with its terminal types; until then they are skipped here,
 * and once they are gone this list names nothing that exists.
 */
const TERMINAL_FIXTURE_SCHEMAS: ReadonlySet<string> = new Set([
  "deviceEvent",
  "deviceEventBatch",
  "deviceStreamEvent",
  "devicesResponse",
  "eventsStreamEvent",
  "recentDirsResult",
  "serverCommand",
  "session",
  "sessionCreateRequest",
  "sessionCreateResult",
  "sessionHistoryResult",
  "sessionKillResult",
  "sessionOptionsResult",
  "viewCreateRequest",
  "viewCreateResponse",
  "viewInputRequest",
  "viewResizeRequest",
  "viewStreamEvent",
  "viewVisibilityRequest"
]);

type Fixture = Readonly<{ name: string; schema: string; value: unknown }>;

function fixtures(files: Record<string, string>): Fixture[] {
  return Object.entries(files).flatMap(([path, raw]) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const schema = name.slice(0, name.indexOf("."));
    return TERMINAL_FIXTURE_SCHEMAS.has(schema) ? [] : [{ name, schema, value: JSON.parse(raw) as unknown }];
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

/**
 * The protocol 1 entries of `contract.json` (terminal limits, codes, events
 * and patterns) that TypeScript no longer defines; the Go client drops them
 * with its terminal types. Absent keys and codes are ignored.
 */
const TERMINAL_CONTRACT_LIMITS = [
  "maxSessionsPerDevice", "maxViewsPerDevice", "maxOutputChunkBytes", "maxInputBytes", "maxHistoryBytes",
  "replyTimeoutSeconds", "viewOrphanTimeoutSeconds", "maxTitleLength", "maxSnapshotSessions", "maxSessionOptions",
  "maxOptionLabelLength", "maxAttachedClients", "minCols", "maxCols", "minRows", "maxRows"
];
const TERMINAL_CONTRACT_KEYS = [
  "helloLimits", "replyErrorCodes", "viewClosedReasons", "viewStreamClosedReasons", "programs", "sessionStatuses",
  "statusReasons", "viewStreamEvents", "serverCommandTypes", "requestCommandTypes", "deviceEventTypes"
];
const TERMINAL_CONTRACT_PATTERNS = ["sessionId", "optionKey", "base64", "requestedCwd", "absolutePath"];
const TERMINAL_REASON_CODES: ReadonlySet<string> = new Set([
  "connect_device_timeout", "connect_session_limit", "connect_view_limit", "connect_session_not_found", "connect_cwd_invalid"
]);

function withoutTerminalEntries(value: typeof contract): Record<string, unknown> {
  const omit = (record: object, keys: readonly string[]) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
  return {
    ...omit(value, TERMINAL_CONTRACT_KEYS),
    limits: omit(value.limits, TERMINAL_CONTRACT_LIMITS),
    patterns: omit(value.patterns, TERMINAL_CONTRACT_PATTERNS),
    reasonCodes: value.reasonCodes.filter((code) => !TERMINAL_REASON_CODES.has(code))
  };
}

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
    const typeValues = (schema: { options: readonly unknown[] }) => schema.options.map((option) => {
      const variant = option as { shape?: { type: { value: string } }; options?: readonly { shape: { type: { value: string } } }[] };
      return variant.shape ? variant.shape.type.value : variant.options![0]!.shape.type.value;
    });
    expect({
      protocolVersion: CONNECT_PROTOCOL_VERSION,
      legacyProtocolVersion: CONNECT_LEGACY_PROTOCOL_VERSION,
      limits: {
        maxDevicesPerUser: CONNECT_MAX_DEVICES_PER_USER,
        maxEventsPerPost: CONNECT_MAX_EVENTS_PER_POST,
        maxEventsBodyBytes: CONNECT_MAX_EVENTS_BODY_BYTES,
        heartbeatSeconds: CONNECT_HEARTBEAT_SECONDS,
        pairingTtlSeconds: CONNECT_PAIRING_TTL_SECONDS,
        pairingPollIntervalSeconds: CONNECT_PAIRING_POLL_INTERVAL_SECONDS,
        pairingPollIntervalMaxSeconds: CONNECT_PAIRING_POLL_INTERVAL_MAX_SECONDS,
        maxCwdLength: CONNECT_MAX_CWD_LENGTH,
        maxRecentDirs: CONNECT_MAX_RECENT_DIRS,
        maxDeviceNameLength: CONNECT_MAX_DEVICE_NAME_LENGTH,
        maxHostnameLength: CONNECT_MAX_HOSTNAME_LENGTH,
        maxAccountLabelLength: CONNECT_MAX_ACCOUNT_LABEL_LENGTH,
        maxUrlLength: CONNECT_MAX_URL_LENGTH,
        maxClientBinaryBytes: CONNECT_MAX_CLIENT_BINARY_BYTES,
        maxClientTargets: CONNECT_MAX_CLIENT_TARGETS,
        maxSeq: CONNECT_MAX_SEQ,
        legacyMaxClientTargets: CONNECT_LEGACY_MAX_CLIENT_TARGETS,
        maxConcurrentOps: CONNECT_MAX_CONCURRENT_OPS,
        maxJobs: CONNECT_MAX_JOBS,
        maxReplyBytes: CONNECT_MAX_REPLY_BYTES,
        maxWriteBytes: CONNECT_MAX_WRITE_BYTES,
        defaultShellTimeoutSeconds: CONNECT_DEFAULT_SHELL_TIMEOUT_SECONDS,
        maxShellTimeoutSeconds: CONNECT_MAX_SHELL_TIMEOUT_SECONDS,
        maxOpDeadlineMs: CONNECT_MAX_OP_DEADLINE_MS,
        maxJobWaitSeconds: CONNECT_MAX_JOB_WAIT_SECONDS,
        maxJobBufferBytes: CONNECT_MAX_JOB_BUFFER_BYTES,
        outputHeadBytes: CONNECT_OUTPUT_HEAD_BYTES,
        outputTailBytes: CONNECT_OUTPUT_TAIL_BYTES,
        maxStreamOutputBytes: CONNECT_MAX_STREAM_OUTPUT_BYTES,
        maxCommandBytes: CONNECT_MAX_COMMAND_BYTES,
        defaultReadLines: CONNECT_DEFAULT_READ_LINES,
        maxReadLines: CONNECT_MAX_READ_LINES,
        maxReadLineLength: CONNECT_MAX_READ_LINE_LENGTH,
        maxLineBytes: CONNECT_MAX_LINE_BYTES,
        maxReadBytes: CONNECT_MAX_READ_BYTES,
        maxLineNumber: CONNECT_MAX_LINE_NUMBER,
        maxGlobPaths: CONNECT_MAX_GLOB_PATHS,
        maxGrepMatches: CONNECT_MAX_GREP_MATCHES,
        maxGrepContext: CONNECT_MAX_GREP_CONTEXT,
        maxPatternLength: CONNECT_MAX_PATTERN_LENGTH,
        maxListDirs: CONNECT_MAX_LIST_DIRS,
        maxDirNameLength: CONNECT_MAX_DIR_NAME_LENGTH,
        maxOsVersionLength: CONNECT_MAX_OS_VERSION_LENGTH,
        maxShellNameLength: CONNECT_MAX_SHELL_NAME_LENGTH,
        maxShellVersionLength: CONNECT_MAX_SHELL_VERSION_LENGTH,
        minExitCode: CONNECT_MIN_EXIT_CODE,
        maxExitCode: CONNECT_MAX_EXIT_CODE
      },
      helloV2Limits: CONNECT_DEFAULT_HELLO_V2_LIMITS,
      reasonCodes: CONNECT_REASON_CODES,
      opErrorCodes: CONNECT_OP_ERROR_CODES,
      deviceStreamClosedCodes: CONNECT_DEVICE_STREAM_CLOSED_CODES,
      eventsStreamClosedCodes: CONNECT_EVENTS_STREAM_CLOSED_CODES,
      os: CONNECT_OS_VALUES,
      legacyOs: CONNECT_LEGACY_OS_VALUES,
      arch: CONNECT_ARCH_VALUES,
      legacyClientTargets: CONNECT_LEGACY_CLIENT_TARGETS,
      ops: CONNECT_OPS,
      shellKinds: CONNECT_SHELL_KINDS,
      grepModes: CONNECT_GREP_MODES,
      lineEndings: CONNECT_LINE_ENDINGS,
      statKinds: CONNECT_STAT_KINDS,
      pairingDecisions: CONNECT_PAIRING_DECISIONS,
      userCodeAlphabet: CONNECT_USER_CODE_ALPHABET,
      patterns: {
        userCode: CONNECT_USER_CODE_PATTERN.source,
        deviceToken: CONNECT_DEVICE_TOKEN_PATTERN.source,
        pollSecret: CONNECT_POLL_SECRET_PATTERN.source,
        id: CONNECT_ID_PATTERN.source,
        version: CONNECT_VERSION_PATTERN.source,
        timestamp: CONNECT_TIMESTAMP_PATTERN.source,
        sha256: CONNECT_SHA256_PATTERN.source,
        controlCharacter: CONNECT_CONTROL_CHARACTER_PATTERN.source,
        urlPrefix: CONNECT_URL_PREFIX_PATTERN.source,
        devicePath: CONNECT_DEVICE_PATH_PATTERN.source,
        jobId: CONNECT_JOB_ID_PATTERN.source,
        encoding: CONNECT_ENCODING_PATTERN.source
      },
      headers: {
        clientVersion: CONNECT_CLIENT_VERSION_HEADER,
        protocol: CONNECT_PROTOCOL_HEADER
      },
      devicePaths: {
        pairings: CONNECT_PAIRINGS_PATH,
        pairingPoll: CONNECT_PAIRING_POLL_PATH,
        stream: CONNECT_DEVICE_STREAM_PATH,
        events: CONNECT_DEVICE_EVENTS_PATH,
        client: CONNECT_CLIENT_MANIFEST_PATH,
        installScript: CONNECT_INSTALL_SCRIPT_PATH,
        checksums: CONNECT_CLIENT_CHECKSUMS_PATH,
        downloadLinuxArm64: connectClientDownloadPath("linux", "arm64"),
        downloadWindowsAmd64: connectClientDownloadPath("windows", "amd64")
      },
      deviceStreamEvents: CONNECT_DEVICE_STREAM_EVENTS,
      eventsStreamEvents: CONNECT_EVENTS_STREAM_EVENTS,
      serverCommandV2Types: typeValues(connectServerCommandV2Schema),
      deviceEventV2Types: typeValues(connectDeviceEventV2Schema)
    }).toEqual(withoutTerminalEntries(contract));
  });

  it("names every SSE event its stream schema accepts", () => {
    const names = (schema: { options: readonly { shape: { event: { value: string } } }[] }) =>
      schema.options.map((option) => option.shape.event.value);
    expect(names(connectDeviceStreamEventV2Schema)).toEqual([...CONNECT_DEVICE_STREAM_EVENTS]);
    expect(names(connectComputerEventsStreamEventSchema)).toEqual([...CONNECT_EVENTS_STREAM_EVENTS]);
  });

  it("uses an unambiguous pairing code alphabet", () => {
    expect(CONNECT_USER_CODE_ALPHABET).not.toMatch(/[01ILOU]/u);
    expect(new Set(CONNECT_USER_CODE_ALPHABET).size).toBe(CONNECT_USER_CODE_ALPHABET.length);
    expect(normalizeConnectUserCode(" bcdf 2345 ")).toBe("BCDF-2345");
    expect(normalizeConnectUserCode("bcdf-2345")).toBe("BCDF-2345");
    expect(normalizeConnectUserCode("BCD0-2345")).toBeNull();
    expect(normalizeConnectUserCode("BCDF-234")).toBeNull();
  });

  it("counts text in UTF-8 bytes as the Go client does", () => {
    expect(connectUtf8ByteLength("ж".repeat(4))).toBe(8);
    expect(connectUtf8ByteLength("😀")).toBe(4);
    expect(connectUtf8ByteLength("\ud800")).toBe(3);
  });
});

describe("connect paths", () => {
  it("builds browser API, device API and page paths with encoded segments", () => {
    expect(connectPairingByCodePath("BCDF-2345")).toBe("/api/connect/pairings/by-code/BCDF-2345");
    expect(connectRecentDirsPath("../x")).toBe("/api/connect/devices/..%2Fx/recent-dirs");
    expect(connectPairPagePath("BCDF-2345")).toBe("/connect/pair?code=BCDF-2345");
    expect(CONNECT_DEVICE_SELF_PATH).toBe("/connect-api/v1/device");
  });
});

describe("connect browser decoders", () => {
  it("returns null for invalid values", () => {
    expect(decodeConnectErrorResponse({ code: "connect_disabled" })).toEqual({ code: "connect_disabled" });
    expect(decodeConnectErrorResponse({ code: "connect_session_not_found" })).toBeNull();
    expect(decodeConnectErrorResponse({ code: "nope" })).toBeNull();
    expect(connectComputerListResponseSchema.safeParse({ computers: [] }).success).toBe(true);
  });
});

const REQUEST_ID = "e4da3b7f-bbce-4345-9777-2b0670b8a1c4";
const RUN_ID = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";

describe("connect protocol 2", () => {
  it("names every op's arguments and results in op order", () => {
    expect(Object.keys(connectOpArgsSchemas)).toEqual([...CONNECT_OPS]);
    expect(Object.keys(connectOpResultSchemas)).toEqual([...CONNECT_OPS]);
  });

  it("checks a reply result against the op it answers", () => {
    expect(parseConnectOpResult("edit", { replacements: 2 })).toEqual({ replacements: 2 });
    expect(parseConnectOpResult("write", { replacements: 2 })).toBeNull();
    expect(parseConnectOpResult("shell", { jobId: "job-k3x9q2ab" })).toEqual({ jobId: "job-k3x9q2ab" });
    expect(parseConnectOpResult("stat", { exists: false })).toEqual({ exists: false });
  });

  it("bounds write content and command output in UTF-8 bytes", () => {
    const write = (content: string) => ({
      type: "op", requestId: REQUEST_ID, runId: RUN_ID, op: "write", args: { path: "a.txt", cwd: "~", content }, deadlineMs: 60_000
    });
    const full = "ж".repeat(CONNECT_MAX_WRITE_BYTES / 2);
    expect(connectServerCommandV2Schema.safeParse(write(full)).success).toBe(true);
    expect(connectServerCommandV2Schema.safeParse(write(`${full}x`)).success).toBe(false);
    const shell = (stdout: string) => ({
      exitCode: 0, stdout, stderr: "", truncated: true, stdoutBytes: 2 ** 30, stderrBytes: 0, durationMs: 5
    });
    expect(parseConnectOpResult("shell", shell("a".repeat(CONNECT_MAX_STREAM_OUTPUT_BYTES)))).not.toBeNull();
    expect(parseConnectOpResult("shell", shell("a".repeat(CONNECT_MAX_STREAM_OUTPUT_BYTES + 1)))).toBeNull();
  });

  it("accepts the absolute paths of every supported system", () => {
    for (const path of ["/home/ivan", "C:\\Users\\ivan", "c:/Users/ivan", "\\\\server\\share"]) {
      expect(CONNECT_DEVICE_PATH_PATTERN.test(path)).toBe(true);
    }
    for (const path of ["ivan", "~/x", "C:relative", "\\single"]) {
      expect(CONNECT_DEVICE_PATH_PATTERN.test(path)).toBe(false);
    }
  });

  it("names Windows release files with .exe and keeps the legacy targets", () => {
    expect(connectClientBinaryName("windows", "arm64")).toBe("aiqsa-connect-windows-arm64.exe");
    expect(connectClientBinaryName("linux", "amd64")).toBe("aiqsa-connect-linux-amd64");
    expect(CONNECT_LEGACY_CLIENT_TARGETS.map(({ arch, os }) => connectClientBinaryName(os, arch))).toEqual([
      "aiqsa-connect-darwin-amd64",
      "aiqsa-connect-darwin-arm64",
      "aiqsa-connect-linux-amd64",
      "aiqsa-connect-linux-arm64"
    ]);
  });
});
