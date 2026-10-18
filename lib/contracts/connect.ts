import { z } from "zod";

/**
 * Wire contract of AIQSA Connect: the device API under `/connect-api/v1`, the
 * browser API under `/api/connect`, their SSE streams and the public client
 * downloads. The Go client mirrors every name, key, limit and pattern in
 * `connect/internal/protocol`; both test suites load the same fixtures from
 * `connect/internal/protocol/testdata`.
 */

export const CONNECT_PROTOCOL_VERSION = 1;

// Limits. Byte limits count UTF-8 bytes (decoded bytes for base64 output);
// text limits count Unicode code points so Go and TypeScript agree.
export const CONNECT_MAX_DEVICES_PER_USER = 10;
export const CONNECT_MAX_SESSIONS_PER_DEVICE = 30;
export const CONNECT_MAX_VIEWS_PER_DEVICE = 8;
export const CONNECT_MAX_EVENTS_PER_POST = 64;
export const CONNECT_MAX_EVENTS_BODY_BYTES = 1_048_576;
export const CONNECT_MAX_OUTPUT_CHUNK_BYTES = 65_536;
export const CONNECT_MAX_INPUT_BYTES = 65_536;
export const CONNECT_MAX_HISTORY_BYTES = 786_432;
export const CONNECT_REPLY_TIMEOUT_SECONDS = 10;
export const CONNECT_HEARTBEAT_SECONDS = 15;
export const CONNECT_VIEW_ORPHAN_TIMEOUT_SECONDS = 30;
export const CONNECT_PAIRING_TTL_SECONDS = 600;
export const CONNECT_PAIRING_POLL_INTERVAL_SECONDS = 2;
/** The highest poll interval a server may ask for when it slows a client down. */
export const CONNECT_PAIRING_POLL_INTERVAL_MAX_SECONDS = 60;
export const CONNECT_MAX_TITLE_LENGTH = 80;
export const CONNECT_MAX_CWD_LENGTH = 1_024;
export const CONNECT_MAX_RECENT_DIRS = 20;
export const CONNECT_MAX_SNAPSHOT_SESSIONS = 50;
export const CONNECT_MAX_DEVICE_NAME_LENGTH = 64;
export const CONNECT_MAX_HOSTNAME_LENGTH = 255;
export const CONNECT_MAX_SESSION_OPTIONS = 9;
export const CONNECT_MAX_OPTION_LABEL_LENGTH = 80;
export const CONNECT_MAX_ATTACHED_CLIENTS = 1_000;
export const CONNECT_MAX_URL_LENGTH = 2_048;
export const CONNECT_MAX_CLIENT_BINARY_BYTES = 134_217_728;
export const CONNECT_MAX_CLIENT_TARGETS = 4;
/** Output `seq` starts at 0 for each view and grows by one per chunk. */
export const CONNECT_MAX_SEQ = Number.MAX_SAFE_INTEGER;
export const CONNECT_MIN_COLS = 20;
export const CONNECT_MAX_COLS = 400;
export const CONNECT_MIN_ROWS = 5;
export const CONNECT_MAX_ROWS = 200;

export const CONNECT_REASON_CODES = [
  "connect_disabled",
  "connect_unauthorized",
  "connect_device_offline",
  "connect_device_timeout",
  "connect_device_limit",
  "connect_session_limit",
  "connect_view_limit",
  "connect_session_not_found",
  "connect_cwd_invalid",
  "connect_client_outdated",
  "connect_pairing_expired",
  "connect_rate_limited",
  "connect_input_too_large",
  "connect_stream_required",
  "connect_unsupported",
  "connect_client_unavailable",
  "connect_not_found",
  "connect_request_invalid",
  "connect_device_error"
] as const;
export type ConnectReasonCode = (typeof CONNECT_REASON_CODES)[number];

/** Codes a device may put in `reply {ok: false}`. */
export const CONNECT_REPLY_ERROR_CODES = [
  "connect_session_not_found",
  "connect_cwd_invalid",
  "connect_session_limit",
  "connect_unsupported",
  "connect_device_error"
] as const satisfies readonly ConnectReasonCode[];
export type ConnectReplyErrorCode = (typeof CONNECT_REPLY_ERROR_CODES)[number];

/** `closed {code}` on the device stream. */
export const CONNECT_DEVICE_STREAM_CLOSED_CODES = [
  "connect_disabled",
  "connect_unauthorized",
  "connect_client_outdated"
] as const satisfies readonly ConnectReasonCode[];
export type ConnectDeviceStreamClosedCode = (typeof CONNECT_DEVICE_STREAM_CLOSED_CODES)[number];

/** `closed {code}` on the browser device-list stream. */
export const CONNECT_EVENTS_STREAM_CLOSED_CODES = [
  "connect_disabled",
  "connect_unauthorized"
] as const satisfies readonly ConnectReasonCode[];
export type ConnectEventsStreamClosedCode = (typeof CONNECT_EVENTS_STREAM_CLOSED_CODES)[number];

/** `view_closed {reason}` sent by the device. */
export const CONNECT_VIEW_CLOSED_REASONS = ["session_ended", "detached", "error", "limit"] as const;
export type ConnectViewClosedReason = (typeof CONNECT_VIEW_CLOSED_REASONS)[number];

/** `closed {reason}` on a browser view stream: the device's reasons or the server's own codes. */
export const CONNECT_VIEW_STREAM_CLOSED_REASONS = [
  ...CONNECT_VIEW_CLOSED_REASONS,
  "connect_device_offline",
  "connect_disabled",
  "connect_unauthorized"
] as const;
export type ConnectViewStreamClosedReason = (typeof CONNECT_VIEW_STREAM_CLOSED_REASONS)[number];

export const CONNECT_OS_VALUES = ["darwin", "linux"] as const;
export type ConnectOs = (typeof CONNECT_OS_VALUES)[number];
export const CONNECT_ARCH_VALUES = ["amd64", "arm64"] as const;
export type ConnectArch = (typeof CONNECT_ARCH_VALUES)[number];
export const CONNECT_PROGRAMS = ["claude", "codex", "shell"] as const;
export type ConnectProgram = (typeof CONNECT_PROGRAMS)[number];
export const CONNECT_SESSION_STATUSES = ["idle", "running", "needs_approval", "waiting"] as const;
export type ConnectSessionStatus = (typeof CONNECT_SESSION_STATUSES)[number];
export const CONNECT_STATUS_REASONS = ["permission", "turn_end", "idle_prompt", "bell", "input"] as const;
export type ConnectStatusReason = (typeof CONNECT_STATUS_REASONS)[number];
export const CONNECT_PAIRING_DECISIONS = ["approve", "deny"] as const;
export type ConnectPairingDecision = (typeof CONNECT_PAIRING_DECISIONS)[number];

/** Pairing code alphabet: digits and capitals without 0, 1, I, L, O and U. */
export const CONNECT_USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export const CONNECT_SESSION_ID_PATTERN = /^ac-[a-z0-9]{6,12}$/u;
export const CONNECT_USER_CODE_PATTERN = new RegExp(
  `^[${CONNECT_USER_CODE_ALPHABET}]{4}-[${CONNECT_USER_CODE_ALPHABET}]{4}$`,
  "u"
);
export const CONNECT_DEVICE_TOKEN_PATTERN = /^aiqsa_connect_[A-Za-z0-9_-]{43}$/u;
export const CONNECT_POLL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
/** Device, pairing, view and request ids: lowercase UUIDs. */
export const CONNECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A release version from `package.json`, or `dev` for an unstamped client build. */
export const CONNECT_VERSION_PATTERN =
  /^(?:dev|(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,32})?)$/u;
export const CONNECT_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
export const CONNECT_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const CONNECT_OPTION_KEY_PATTERN = /^[1-9]$/u;
export const CONNECT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
/** Display text and paths never carry C0/C1 control characters or DEL. */
export const CONNECT_CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f-\x9f]/u;
export const CONNECT_URL_PREFIX_PATTERN = /^https?:\/\//u;
/** A path the client resolves: absolute, `~` or `~/…`. */
export const CONNECT_REQUESTED_CWD_PATTERN = /^(?:~|~\/.*|\/.*)$/u;
/** A path the client reports: absolute. */
export const CONNECT_ABSOLUTE_PATH_PATTERN = /^\/.*$/u;

// Paths. Device API: Bearer device token only, never cookies.
export const CONNECT_DEVICE_API_PREFIX = "/connect-api/v1";
export const CONNECT_PAIRINGS_PATH = `${CONNECT_DEVICE_API_PREFIX}/pairings`;
export const CONNECT_PAIRING_POLL_PATH = `${CONNECT_DEVICE_API_PREFIX}/pairings/poll`;
export const CONNECT_DEVICE_STREAM_PATH = `${CONNECT_DEVICE_API_PREFIX}/stream`;
export const CONNECT_DEVICE_EVENTS_PATH = `${CONNECT_DEVICE_API_PREFIX}/events`;
export const CONNECT_CLIENT_MANIFEST_PATH = `${CONNECT_DEVICE_API_PREFIX}/client`;

// Browser API: the AIQSA cookie session.
export const CONNECT_BROWSER_API_PREFIX = "/api/connect";
export const CONNECT_DEVICES_PATH = `${CONNECT_BROWSER_API_PREFIX}/devices`;
export const CONNECT_EVENTS_PATH = `${CONNECT_BROWSER_API_PREFIX}/events`;
export const CONNECT_VIEWS_PATH = `${CONNECT_BROWSER_API_PREFIX}/views`;
export const CONNECT_PAIRINGS_BY_CODE_PATH = `${CONNECT_BROWSER_API_PREFIX}/pairings/by-code`;

// Pages and public downloads.
export const CONNECT_PAGE_PATH = "/connect";
export const CONNECT_PAIR_PAGE_PATH = `${CONNECT_PAGE_PATH}/pair`;
export const CONNECT_INSTALL_SCRIPT_PATH = `${CONNECT_PAGE_PATH}/install.sh`;
export const CONNECT_CLIENT_DOWNLOAD_PREFIX = `${CONNECT_PAGE_PATH}/download`;
export const CONNECT_CLIENT_CHECKSUMS_PATH = `${CONNECT_PAGE_PATH}/checksums.txt`;
export const CONNECT_CLIENT_BINARY_PREFIX = "aiqsa-connect";

const segment = encodeURIComponent;

export function connectPairingByCodePath(userCode: string): string {
  return `${CONNECT_PAIRINGS_BY_CODE_PATH}/${segment(userCode)}`;
}
export function connectDevicePath(deviceId: string): string {
  return `${CONNECT_DEVICES_PATH}/${segment(deviceId)}`;
}
export function connectDeviceSessionsPath(deviceId: string): string {
  return `${connectDevicePath(deviceId)}/sessions`;
}
export function connectDeviceSessionPath(deviceId: string, sessionId: string): string {
  return `${connectDeviceSessionsPath(deviceId)}/${segment(sessionId)}`;
}
export function connectSessionHistoryPath(deviceId: string, sessionId: string): string {
  return `${connectDeviceSessionPath(deviceId, sessionId)}/history`;
}
export function connectSessionOptionsPath(deviceId: string, sessionId: string): string {
  return `${connectDeviceSessionPath(deviceId, sessionId)}/options`;
}
export function connectRecentDirsPath(deviceId: string): string {
  return `${connectDevicePath(deviceId)}/recent-dirs`;
}
export function connectViewPath(viewId: string): string {
  return `${CONNECT_VIEWS_PATH}/${segment(viewId)}`;
}
export function connectViewStreamPath(viewId: string): string {
  return `${connectViewPath(viewId)}/stream`;
}
export function connectViewInputPath(viewId: string): string {
  return `${connectViewPath(viewId)}/input`;
}
export function connectViewResizePath(viewId: string): string {
  return `${connectViewPath(viewId)}/resize`;
}
export function connectViewVisibilityPath(viewId: string): string {
  return `${connectViewPath(viewId)}/visibility`;
}
export function connectPairPagePath(userCode: string): string {
  return `${CONNECT_PAIR_PAGE_PATH}?code=${segment(userCode)}`;
}
export function connectSessionPath(deviceId: string, sessionId: string): string {
  return `${CONNECT_PAGE_PATH}/${segment(deviceId)}/${segment(sessionId)}`;
}
export function connectClientBinaryName(os: ConnectOs, arch: ConnectArch): string {
  return `${CONNECT_CLIENT_BINARY_PREFIX}-${os}-${arch}`;
}
export function connectClientDownloadPath(os: ConnectOs, arch: ConnectArch): string {
  return `${CONNECT_CLIENT_DOWNLOAD_PREFIX}/${connectClientBinaryName(os, arch)}`;
}

/** Upper-cases a typed pairing code, accepts it with or without the dash; null when it is not a code. */
export function normalizeConnectUserCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/gu, "");
  if (compact.length !== 8) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return CONNECT_USER_CODE_PATTERN.test(code) ? code : null;
}

/** UTF-8 byte length; a lone surrogate counts as U+FFFD, as the Go decoder reads it. */
export function connectUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) index += 1;
    length += 1;
  }
  return length;
}

function base64DecodedLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Non-empty text without control characters, at most `max` code points. */
function textSchema(max: number) {
  return z.string()
    .min(1)
    .max(max * 2)
    .refine((value) => codePointLength(value) <= max, "text too long")
    .refine((value) => !CONNECT_CONTROL_CHARACTER_PATTERN.test(value), "text contains control characters");
}

function pathSchema(pattern: RegExp) {
  return textSchema(CONNECT_MAX_CWD_LENGTH).regex(pattern);
}

/** UTF-8 text of `min`..`max` bytes; control characters allowed (terminal input, history). */
function bytesTextSchema(min: number, max: number) {
  return z.string()
    .max(max)
    .refine((value) => {
      const bytes = connectUtf8ByteLength(value);
      return bytes >= min && bytes <= max;
    }, "text size out of range");
}

function boundedInt(min: number, max: number) {
  return z.number().int().min(min).max(max);
}

const idSchema = z.string().regex(CONNECT_ID_PATTERN);
const sessionIdSchema = z.string().regex(CONNECT_SESSION_ID_PATTERN);
const versionSchema = z.string().regex(CONNECT_VERSION_PATTERN);
const timestampSchema = z.string()
  .regex(CONNECT_TIMESTAMP_PATTERN)
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
/** An absolute `https://` or `http://` URL without credentials. */
const urlSchema = z.string().max(CONNECT_MAX_URL_LENGTH).regex(CONNECT_URL_PREFIX_PATTERN).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}, "invalid url");
const userCodeSchema = z.string().regex(CONNECT_USER_CODE_PATTERN);
const osSchema = z.enum(CONNECT_OS_VALUES);
const archSchema = z.enum(CONNECT_ARCH_VALUES);
const programSchema = z.enum(CONNECT_PROGRAMS);
const statusSchema = z.enum(CONNECT_SESSION_STATUSES);
const colsSchema = boundedInt(CONNECT_MIN_COLS, CONNECT_MAX_COLS);
const rowsSchema = boundedInt(CONNECT_MIN_ROWS, CONNECT_MAX_ROWS);
const seqSchema = boundedInt(0, CONNECT_MAX_SEQ);
const titleSchema = textSchema(CONNECT_MAX_TITLE_LENGTH);
const requestedCwdSchema = pathSchema(CONNECT_REQUESTED_CWD_PATTERN);
const absolutePathSchema = pathSchema(CONNECT_ABSOLUTE_PATH_PATTERN);
const inputDataSchema = bytesTextSchema(1, CONNECT_MAX_INPUT_BYTES);
/** Standard padded base64 of 1..64 KiB of terminal output. */
const outputDataSchema = z.string()
  .min(4)
  .max(Math.ceil(CONNECT_MAX_OUTPUT_CHUNK_BYTES / 3) * 4)
  .regex(CONNECT_BASE64_PATTERN)
  .refine((value) => base64DecodedLength(value) <= CONNECT_MAX_OUTPUT_CHUNK_BYTES, "output chunk too large");
const emptySchema = z.strictObject({});

function uniqueBy<T>(key: (item: T) => string) {
  return (items: readonly T[]) => new Set(items.map(key)).size === items.length;
}

export const connectErrorResponseSchema = z.strictObject({
  code: z.enum(CONNECT_REASON_CODES)
});

export const connectSessionSchema = z.strictObject({
  id: sessionIdSchema,
  title: titleSchema,
  cwd: absolutePathSchema,
  program: programSchema,
  status: statusSchema,
  statusAt: timestampSchema,
  createdAt: timestampSchema,
  attachedClients: boundedInt(0, CONNECT_MAX_ATTACHED_CLIENTS)
});
const sessionListSchema = z.array(connectSessionSchema)
  .max(CONNECT_MAX_SNAPSHOT_SESSIONS)
  .refine(uniqueBy((session: { id: string }) => session.id), "duplicate session id");

// Device pairing: unauthenticated device API calls.
export const connectPairingCreateRequestSchema = z.strictObject({
  name: textSchema(CONNECT_MAX_DEVICE_NAME_LENGTH),
  hostname: textSchema(CONNECT_MAX_HOSTNAME_LENGTH),
  os: osSchema,
  arch: archSchema,
  clientVersion: versionSchema
});

export const connectPairingCreateResponseSchema = z.strictObject({
  pairingId: idSchema,
  userCode: userCodeSchema,
  /** The complete approval page URL, code included. */
  verificationUri: urlSchema,
  pollSecret: z.string().regex(CONNECT_POLL_SECRET_PATTERN),
  expiresAt: timestampSchema,
  intervalSeconds: boundedInt(CONNECT_PAIRING_POLL_INTERVAL_SECONDS, CONNECT_PAIRING_POLL_INTERVAL_MAX_SECONDS)
});

export const connectPairingPollRequestSchema = z.strictObject({
  pairingId: idSchema,
  pollSecret: z.string().regex(CONNECT_POLL_SECRET_PATTERN)
});

export const connectPairingPollResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    status: z.literal("approved"),
    deviceId: idSchema,
    deviceToken: z.string().regex(CONNECT_DEVICE_TOKEN_PATTERN)
  }),
  z.strictObject({ status: z.literal("denied") }),
  z.strictObject({ status: z.literal("expired") })
]);

// Browser pairing approval.
export const connectPairingLookupResponseSchema = z.strictObject({
  pairing: z.strictObject({
    name: textSchema(CONNECT_MAX_DEVICE_NAME_LENGTH),
    hostname: textSchema(CONNECT_MAX_HOSTNAME_LENGTH),
    os: osSchema,
    arch: archSchema,
    clientVersion: versionSchema,
    expiresAt: timestampSchema
  })
});

export const connectPairingDecisionRequestSchema = z.strictObject({
  decision: z.enum(CONNECT_PAIRING_DECISIONS)
});

export const connectPairingDecisionResponseSchema = z.strictObject({
  status: z.enum(["approved", "denied"])
});

// Device stream `/connect-api/v1/stream`.
export const connectHelloLimitsSchema = z.strictObject({
  maxEventsPerPost: boundedInt(1, CONNECT_MAX_EVENTS_PER_POST),
  maxEventsBodyBytes: boundedInt(1, CONNECT_MAX_EVENTS_BODY_BYTES),
  maxOutputChunkBytes: boundedInt(1, CONNECT_MAX_OUTPUT_CHUNK_BYTES),
  maxInputBytes: boundedInt(1, CONNECT_MAX_INPUT_BYTES),
  maxHistoryBytes: boundedInt(1, CONNECT_MAX_HISTORY_BYTES),
  maxSessions: boundedInt(1, CONNECT_MAX_SESSIONS_PER_DEVICE),
  maxViews: boundedInt(1, CONNECT_MAX_VIEWS_PER_DEVICE),
  maxSnapshotSessions: boundedInt(1, CONNECT_MAX_SNAPSHOT_SESSIONS),
  maxRecentDirs: boundedInt(1, CONNECT_MAX_RECENT_DIRS),
  heartbeatSeconds: boundedInt(1, CONNECT_HEARTBEAT_SECONDS),
  replyTimeoutSeconds: boundedInt(1, CONNECT_REPLY_TIMEOUT_SECONDS)
});
export type ConnectHelloLimits = z.infer<typeof connectHelloLimitsSchema>;

/** The limits a server announces in `hello` when it enforces the contract maxima. */
export const CONNECT_DEFAULT_HELLO_LIMITS: ConnectHelloLimits = Object.freeze({
  maxEventsPerPost: CONNECT_MAX_EVENTS_PER_POST,
  maxEventsBodyBytes: CONNECT_MAX_EVENTS_BODY_BYTES,
  maxOutputChunkBytes: CONNECT_MAX_OUTPUT_CHUNK_BYTES,
  maxInputBytes: CONNECT_MAX_INPUT_BYTES,
  maxHistoryBytes: CONNECT_MAX_HISTORY_BYTES,
  maxSessions: CONNECT_MAX_SESSIONS_PER_DEVICE,
  maxViews: CONNECT_MAX_VIEWS_PER_DEVICE,
  maxSnapshotSessions: CONNECT_MAX_SNAPSHOT_SESSIONS,
  maxRecentDirs: CONNECT_MAX_RECENT_DIRS,
  heartbeatSeconds: CONNECT_HEARTBEAT_SECONDS,
  replyTimeoutSeconds: CONNECT_REPLY_TIMEOUT_SECONDS
});

export const connectHelloSchema = z.strictObject({
  protocol: z.literal(CONNECT_PROTOCOL_VERSION),
  deviceId: idSchema,
  serverVersion: versionSchema,
  minClientVersion: versionSchema,
  limits: connectHelloLimitsSchema
});

export const connectDeviceStreamClosedSchema = z.strictObject({
  code: z.enum(CONNECT_DEVICE_STREAM_CLOSED_CODES)
});

// Server commands, the `command` event data.
export const connectViewOpenCommandSchema = z.strictObject({
  type: z.literal("view_open"),
  viewId: idSchema,
  sessionId: sessionIdSchema,
  cols: colsSchema,
  rows: rowsSchema
});
export const connectViewInputCommandSchema = z.strictObject({
  type: z.literal("view_input"),
  viewId: idSchema,
  data: inputDataSchema
});
export const connectViewResizeCommandSchema = z.strictObject({
  type: z.literal("view_resize"),
  viewId: idSchema,
  cols: colsSchema,
  rows: rowsSchema
});
export const connectViewCloseCommandSchema = z.strictObject({
  type: z.literal("view_close"),
  viewId: idSchema
});
export const connectSessionCreateCommandSchema = z.strictObject({
  type: z.literal("session_create"),
  requestId: idSchema,
  program: programSchema,
  cwd: requestedCwdSchema,
  title: titleSchema.optional()
});
export const connectSessionKillCommandSchema = z.strictObject({
  type: z.literal("session_kill"),
  requestId: idSchema,
  sessionId: sessionIdSchema
});
export const connectSessionHistoryCommandSchema = z.strictObject({
  type: z.literal("session_history"),
  requestId: idSchema,
  sessionId: sessionIdSchema
});
export const connectSessionOptionsCommandSchema = z.strictObject({
  type: z.literal("session_options"),
  requestId: idSchema,
  sessionId: sessionIdSchema
});
export const connectRecentDirsCommandSchema = z.strictObject({
  type: z.literal("recent_dirs"),
  requestId: idSchema
});

export const connectServerCommandSchema = z.discriminatedUnion("type", [
  connectViewOpenCommandSchema,
  connectViewInputCommandSchema,
  connectViewResizeCommandSchema,
  connectViewCloseCommandSchema,
  connectSessionCreateCommandSchema,
  connectSessionKillCommandSchema,
  connectSessionHistoryCommandSchema,
  connectSessionOptionsCommandSchema,
  connectRecentDirsCommandSchema
]);
export type ConnectServerCommand = z.infer<typeof connectServerCommandSchema>;
export type ConnectServerCommandType = ConnectServerCommand["type"];

export const connectDeviceStreamEventSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("hello"), data: connectHelloSchema }),
  z.strictObject({ event: z.literal("command"), data: connectServerCommandSchema }),
  z.strictObject({ event: z.literal("ping"), data: emptySchema }),
  z.strictObject({ event: z.literal("replaced"), data: emptySchema }),
  z.strictObject({ event: z.literal("closed"), data: connectDeviceStreamClosedSchema })
]);
export type ConnectDeviceStreamEvent = z.infer<typeof connectDeviceStreamEventSchema>;
export type ConnectDeviceStreamEventName = ConnectDeviceStreamEvent["event"];

// Command results: the `reply.result` of each request command, and the matching browser response.
export const connectSessionCreateResultSchema = z.strictObject({ sessionId: sessionIdSchema });
export const connectSessionKillResultSchema = emptySchema;
export const connectSessionHistoryResultSchema = z.strictObject({
  text: bytesTextSchema(0, CONNECT_MAX_HISTORY_BYTES)
});
export const connectSessionOptionSchema = z.strictObject({
  key: z.string().regex(CONNECT_OPTION_KEY_PATTERN),
  label: textSchema(CONNECT_MAX_OPTION_LABEL_LENGTH)
});
export const connectSessionOptionsResultSchema = z.strictObject({
  options: z.array(connectSessionOptionSchema)
    .max(CONNECT_MAX_SESSION_OPTIONS)
    .refine(uniqueBy((option: { key: string }) => option.key), "duplicate option key")
});
export const connectRecentDirsResultSchema = z.strictObject({
  home: absolutePathSchema,
  dirs: z.array(absolutePathSchema).max(CONNECT_MAX_RECENT_DIRS)
});

export const connectCommandResultSchemas = {
  session_create: connectSessionCreateResultSchema,
  session_kill: connectSessionKillResultSchema,
  session_history: connectSessionHistoryResultSchema,
  session_options: connectSessionOptionsResultSchema,
  recent_dirs: connectRecentDirsResultSchema
} as const;
export type ConnectRequestCommandType = keyof typeof connectCommandResultSchemas;
export type ConnectCommandResult<T extends ConnectRequestCommandType> = z.infer<
  (typeof connectCommandResultSchemas)[T]
>;

/** Validates a `reply.result` against the command the server sent; null when it does not match. */
export function parseConnectCommandResult<T extends ConnectRequestCommandType>(
  type: T,
  result: unknown
): ConnectCommandResult<T> | null {
  const decoded = connectCommandResultSchemas[type].safeParse(result);
  return decoded.success ? decoded.data as ConnectCommandResult<T> : null;
}

// Device events, POSTed in batches to `/connect-api/v1/events`.
export const connectSessionsEventSchema = z.strictObject({
  type: z.literal("sessions"),
  sessions: sessionListSchema
});
export const connectStatusEventSchema = z.strictObject({
  type: z.literal("status"),
  sessionId: sessionIdSchema,
  status: statusSchema,
  statusAt: timestampSchema,
  reason: z.enum(CONNECT_STATUS_REASONS).optional()
});
export const connectOutputEventSchema = z.strictObject({
  type: z.literal("output"),
  viewId: idSchema,
  seq: seqSchema,
  data: outputDataSchema
});
export const connectViewClosedEventSchema = z.strictObject({
  type: z.literal("view_closed"),
  viewId: idSchema,
  reason: z.enum(CONNECT_VIEW_CLOSED_REASONS)
});
export const connectReplyEventSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("reply"),
    requestId: idSchema,
    ok: z.literal(true),
    /** Exactly one command's result shape; `parseConnectCommandResult` checks it against the sent command. */
    result: z.union([
      connectSessionCreateResultSchema,
      connectSessionHistoryResultSchema,
      connectSessionOptionsResultSchema,
      connectRecentDirsResultSchema,
      connectSessionKillResultSchema
    ])
  }),
  z.strictObject({
    type: z.literal("reply"),
    requestId: idSchema,
    ok: z.literal(false),
    code: z.enum(CONNECT_REPLY_ERROR_CODES)
  })
]);

export const connectDeviceEventSchema = z.discriminatedUnion("type", [
  connectSessionsEventSchema,
  connectStatusEventSchema,
  connectOutputEventSchema,
  connectViewClosedEventSchema,
  connectReplyEventSchema
]);
export type ConnectDeviceEvent = z.infer<typeof connectDeviceEventSchema>;

export const connectDeviceEventBatchSchema = z.strictObject({
  events: z.array(connectDeviceEventSchema).min(1).max(CONNECT_MAX_EVENTS_PER_POST)
});

// Public client manifest `/connect-api/v1/client`.
export const connectClientTargetSchema = z.strictObject({
  os: osSchema,
  arch: archSchema,
  sha256: z.string().regex(CONNECT_SHA256_PATTERN),
  size: boundedInt(1, CONNECT_MAX_CLIENT_BINARY_BYTES)
});
export const connectClientManifestSchema = z.strictObject({
  version: versionSchema,
  targets: z.array(connectClientTargetSchema)
    .min(1)
    .max(CONNECT_MAX_CLIENT_TARGETS)
    .refine(uniqueBy((target: { os: string; arch: string }) => `${target.os}-${target.arch}`), "duplicate target")
});

// Browser API `/api/connect`.
export const connectDeviceSchema = z.strictObject({
  id: idSchema,
  name: textSchema(CONNECT_MAX_DEVICE_NAME_LENGTH),
  hostname: textSchema(CONNECT_MAX_HOSTNAME_LENGTH),
  os: osSchema,
  arch: archSchema,
  clientVersion: versionSchema,
  online: z.boolean(),
  lastSeenAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  sessions: sessionListSchema
});
export const connectDevicesResponseSchema = z.strictObject({
  devices: z.array(connectDeviceSchema)
    .max(CONNECT_MAX_DEVICES_PER_USER)
    .refine(uniqueBy((device: { id: string }) => device.id), "duplicate device id")
});
export const connectSessionCreateRequestSchema = z.strictObject({
  program: programSchema,
  cwd: requestedCwdSchema,
  title: titleSchema.optional()
});
export const connectSessionCreateResponseSchema = connectSessionCreateResultSchema;
export const connectSessionHistoryResponseSchema = connectSessionHistoryResultSchema;
export const connectSessionOptionsResponseSchema = connectSessionOptionsResultSchema;
export const connectRecentDirsResponseSchema = connectRecentDirsResultSchema;
export const connectViewCreateRequestSchema = z.strictObject({
  deviceId: idSchema,
  sessionId: sessionIdSchema,
  cols: colsSchema,
  rows: rowsSchema
});
export const connectViewCreateResponseSchema = z.strictObject({ viewId: idSchema });
export const connectViewInputRequestSchema = z.strictObject({ data: inputDataSchema });
export const connectViewResizeRequestSchema = z.strictObject({ cols: colsSchema, rows: rowsSchema });
export const connectViewVisibilityRequestSchema = z.strictObject({ visible: z.boolean() });

/** `/api/connect/events`: a `devices` snapshot (resent after a device is added or removed), then `device` updates. */
export const connectEventsStreamEventSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("devices"), data: connectDevicesResponseSchema }),
  z.strictObject({ event: z.literal("device"), data: z.strictObject({ device: connectDeviceSchema }) }),
  z.strictObject({
    event: z.literal("closed"),
    data: z.strictObject({ code: z.enum(CONNECT_EVENTS_STREAM_CLOSED_CODES) })
  }),
  z.strictObject({ event: z.literal("ping"), data: emptySchema })
]);
export type ConnectEventsStreamEvent = z.infer<typeof connectEventsStreamEventSchema>;
export type ConnectEventsStreamEventName = ConnectEventsStreamEvent["event"];

/** `/api/connect/views/<viewId>/stream`. */
export const connectViewStreamEventSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("output"), data: z.strictObject({ seq: seqSchema, data: outputDataSchema }) }),
  z.strictObject({
    event: z.literal("closed"),
    data: z.strictObject({ reason: z.enum(CONNECT_VIEW_STREAM_CLOSED_REASONS) })
  }),
  z.strictObject({ event: z.literal("ping"), data: emptySchema })
]);
export type ConnectViewStreamEvent = z.infer<typeof connectViewStreamEventSchema>;
export type ConnectViewStreamEventName = ConnectViewStreamEvent["event"];

export const CONNECT_DEVICE_STREAM_EVENTS = ["hello", "command", "ping", "replaced", "closed"] as const satisfies
  readonly ConnectDeviceStreamEventName[];
export const CONNECT_EVENTS_STREAM_EVENTS = ["devices", "device", "closed", "ping"] as const satisfies
  readonly ConnectEventsStreamEventName[];
export const CONNECT_VIEW_STREAM_EVENTS = ["output", "closed", "ping"] as const satisfies
  readonly ConnectViewStreamEventName[];

export type ConnectErrorResponse = z.infer<typeof connectErrorResponseSchema>;
export type ConnectSession = z.infer<typeof connectSessionSchema>;
export type ConnectPairingCreateRequest = z.infer<typeof connectPairingCreateRequestSchema>;
export type ConnectPairingCreateResponse = z.infer<typeof connectPairingCreateResponseSchema>;
export type ConnectPairingPollRequest = z.infer<typeof connectPairingPollRequestSchema>;
export type ConnectPairingPollResponse = z.infer<typeof connectPairingPollResponseSchema>;
export type ConnectPairingLookupResponse = z.infer<typeof connectPairingLookupResponseSchema>;
export type ConnectPairingDecisionRequest = z.infer<typeof connectPairingDecisionRequestSchema>;
export type ConnectPairingDecisionResponse = z.infer<typeof connectPairingDecisionResponseSchema>;
export type ConnectHello = z.infer<typeof connectHelloSchema>;
export type ConnectDeviceStreamClosed = z.infer<typeof connectDeviceStreamClosedSchema>;
export type ConnectSessionOption = z.infer<typeof connectSessionOptionSchema>;
export type ConnectSessionsEvent = z.infer<typeof connectSessionsEventSchema>;
export type ConnectStatusEvent = z.infer<typeof connectStatusEventSchema>;
export type ConnectOutputEvent = z.infer<typeof connectOutputEventSchema>;
export type ConnectViewClosedEvent = z.infer<typeof connectViewClosedEventSchema>;
export type ConnectReplyEvent = z.infer<typeof connectReplyEventSchema>;
export type ConnectDeviceEventBatch = z.infer<typeof connectDeviceEventBatchSchema>;
export type ConnectClientTarget = z.infer<typeof connectClientTargetSchema>;
export type ConnectClientManifest = z.infer<typeof connectClientManifestSchema>;
export type ConnectDevice = z.infer<typeof connectDeviceSchema>;
export type ConnectDevicesResponse = z.infer<typeof connectDevicesResponseSchema>;
export type ConnectSessionCreateRequest = z.infer<typeof connectSessionCreateRequestSchema>;
export type ConnectSessionCreateResponse = z.infer<typeof connectSessionCreateResponseSchema>;
export type ConnectSessionHistoryResponse = z.infer<typeof connectSessionHistoryResponseSchema>;
export type ConnectSessionOptionsResponse = z.infer<typeof connectSessionOptionsResponseSchema>;
export type ConnectRecentDirsResponse = z.infer<typeof connectRecentDirsResponseSchema>;
export type ConnectViewCreateRequest = z.infer<typeof connectViewCreateRequestSchema>;
export type ConnectViewCreateResponse = z.infer<typeof connectViewCreateResponseSchema>;
export type ConnectViewInputRequest = z.infer<typeof connectViewInputRequestSchema>;
export type ConnectViewResizeRequest = z.infer<typeof connectViewResizeRequestSchema>;
export type ConnectViewVisibilityRequest = z.infer<typeof connectViewVisibilityRequestSchema>;

// Browser decoders: null on any invalid value.
function decoder<T>(schema: z.ZodType<T>): (value: unknown) => T | null {
  return (value) => {
    const decoded = schema.safeParse(value);
    return decoded.success ? decoded.data : null;
  };
}

export const decodeConnectErrorResponse = decoder(connectErrorResponseSchema);
export const decodeConnectDevicesResponse = decoder(connectDevicesResponseSchema);
export const decodeConnectPairingLookupResponse = decoder(connectPairingLookupResponseSchema);
export const decodeConnectPairingDecisionResponse = decoder(connectPairingDecisionResponseSchema);
export const decodeConnectSessionCreateResponse = decoder(connectSessionCreateResponseSchema);
export const decodeConnectSessionHistoryResponse = decoder(connectSessionHistoryResponseSchema);
export const decodeConnectSessionOptionsResponse = decoder(connectSessionOptionsResponseSchema);
export const decodeConnectRecentDirsResponse = decoder(connectRecentDirsResponseSchema);
export const decodeConnectViewCreateResponse = decoder(connectViewCreateResponseSchema);

const decodeEventsStreamEvent = decoder(connectEventsStreamEventSchema);
const decodeViewStreamEvent = decoder(connectViewStreamEventSchema);

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** Decodes one `/api/connect/events` frame from `MessageEvent.type` and its raw `data`. */
export function decodeConnectEventsStreamEvent(event: string, data: string): ConnectEventsStreamEvent | null {
  return decodeEventsStreamEvent({ event, data: parseEventData(data) });
}

/** Decodes one view-stream frame from `MessageEvent.type` and its raw `data`. */
export function decodeConnectViewStreamEvent(event: string, data: string): ConnectViewStreamEvent | null {
  return decodeViewStreamEvent({ event, data: parseEventData(data) });
}
