import { z } from "zod";

/**
 * Wire contract of AIQSA Connect: the device API under `/connect-api/v1`, the
 * browser API under `/api/connect`, their SSE streams and the public client
 * downloads. The Go client mirrors every name, key, limit and pattern in
 * `connect/internal/protocol`; both test suites load the same fixtures from
 * `connect/internal/protocol/testdata`.
 */

/**
 * Protocol 2: the agent works on the user's computer through `op` commands.
 * Protocol 2 clients send {@link CONNECT_PROTOCOL_HEADER} on every device API
 * request and expect {@link connectHelloV2Schema}. Protocol 1 (the terminal
 * relay) is gone: a stream request without the header answers 426
 * `connect_client_outdated` and its client updates itself from the legacy
 * manifest ({@link connectLegacyClientManifestSchema}, D-03).
 */
export const CONNECT_PROTOCOL_VERSION = 2;
/** The protocol of terminal clients, which no longer get a stream. */
export const CONNECT_LEGACY_PROTOCOL_VERSION = 1;

// Limits. Byte limits count UTF-8 bytes; text limits count Unicode code points so Go and TypeScript agree.
export const CONNECT_MAX_DEVICES_PER_USER = 10;
export const CONNECT_MAX_EVENTS_PER_POST = 64;
export const CONNECT_MAX_EVENTS_BODY_BYTES = 1_048_576;
export const CONNECT_HEARTBEAT_SECONDS = 15;
export const CONNECT_PAIRING_TTL_SECONDS = 600;
export const CONNECT_PAIRING_POLL_INTERVAL_SECONDS = 2;
/** The highest poll interval a server may ask for when it slows a client down. */
export const CONNECT_PAIRING_POLL_INTERVAL_MAX_SECONDS = 60;
export const CONNECT_MAX_CWD_LENGTH = 1_024;
export const CONNECT_MAX_RECENT_DIRS = 20;
export const CONNECT_MAX_DEVICE_NAME_LENGTH = 64;
export const CONNECT_MAX_HOSTNAME_LENGTH = 255;
/** Who approved a pairing, as `login` prints it: the account's email, then its display name. */
export const CONNECT_MAX_ACCOUNT_LABEL_LENGTH = 400;
export const CONNECT_MAX_URL_LENGTH = 2_048;
export const CONNECT_MAX_CLIENT_BINARY_BYTES = 134_217_728;
export const CONNECT_MAX_CLIENT_TARGETS = 6;
/** What a protocol 1 client accepts in a manifest: it decodes strictly, so it gets only {@link CONNECT_LEGACY_CLIENT_TARGETS}. */
export const CONNECT_LEGACY_MAX_CLIENT_TARGETS = 4;
/** The largest size, duration or count the protocol carries. */
export const CONNECT_MAX_SEQ = Number.MAX_SAFE_INTEGER;

// Protocol 2 limits: the device's agent operations (`op`).
/** Operations one device runs at once; more answer `computer_limit`. */
export const CONNECT_MAX_CONCURRENT_OPS = 16;
/** Background jobs one device keeps at once; more answer `computer_limit`. */
export const CONNECT_MAX_JOBS = 8;
/** One `reply` event as JSON; a batch of events stays within {@link CONNECT_MAX_EVENTS_BODY_BYTES}. */
export const CONNECT_MAX_REPLY_BYTES = 524_288;
/** `write.content`, `edit.oldString` and `edit.newString`, in UTF-8 bytes. */
export const CONNECT_MAX_WRITE_BYTES = 1_048_576;
export const CONNECT_DEFAULT_SHELL_TIMEOUT_SECONDS = 120;
export const CONNECT_MAX_SHELL_TIMEOUT_SECONDS = 600;
/** The longest `deadlineMs` of one operation: the longest shell timeout and a minute for the device to answer. */
export const CONNECT_MAX_OP_DEADLINE_MS = 660_000;
export const CONNECT_MAX_JOB_WAIT_SECONDS = 30;
/** A background job's output buffer on the device (a ring); older output is dropped. */
export const CONNECT_MAX_JOB_BUFFER_BYTES = 1_048_576;
/** A command's output keeps its first and last bytes of each stream; the middle is dropped and `truncated` set. */
export const CONNECT_OUTPUT_HEAD_BYTES = 32_768;
export const CONNECT_OUTPUT_TAIL_BYTES = 98_304;
export const CONNECT_MAX_STREAM_OUTPUT_BYTES = CONNECT_OUTPUT_HEAD_BYTES + CONNECT_OUTPUT_TAIL_BYTES;
export const CONNECT_MAX_COMMAND_BYTES = 65_536;
export const CONNECT_DEFAULT_READ_LINES = 2_000;
export const CONNECT_MAX_READ_LINES = 2_000;
/** The device cuts a longer line of a file or a `grep` match to this many characters. */
export const CONNECT_MAX_READ_LINE_LENGTH = 2_000;
/** One line of a `grep` match in UTF-8 bytes: {@link CONNECT_MAX_READ_LINE_LENGTH} characters of up to four bytes. */
export const CONNECT_MAX_LINE_BYTES = 8_000;
/** `read.content` in UTF-8 bytes; the device stops earlier and sets `truncated`. */
export const CONNECT_MAX_READ_BYTES = 262_144;
export const CONNECT_MAX_LINE_NUMBER = 2_147_483_647;
export const CONNECT_MAX_GLOB_PATHS = 1_000;
export const CONNECT_MAX_GREP_MATCHES = 1_000;
export const CONNECT_MAX_GREP_CONTEXT = 5;
/** `glob` and `grep` patterns, in code points. */
export const CONNECT_MAX_PATTERN_LENGTH = 1_024;
export const CONNECT_MAX_LIST_DIRS = 500;
export const CONNECT_MAX_DIR_NAME_LENGTH = 255;
export const CONNECT_MAX_OS_VERSION_LENGTH = 128;
export const CONNECT_MAX_SHELL_NAME_LENGTH = 64;
export const CONNECT_MAX_SHELL_VERSION_LENGTH = 64;
/** Exit codes: negative for a signal on Unix, up to 0xFFFFFFFF on Windows. */
export const CONNECT_MIN_EXIT_CODE = -2_147_483_648;
export const CONNECT_MAX_EXIT_CODE = 4_294_967_295;

export const CONNECT_REASON_CODES = [
  "connect_disabled",
  "connect_unauthorized",
  "connect_device_offline",
  "connect_device_limit",
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

export const CONNECT_OS_VALUES = ["darwin", "linux", "windows"] as const;
export type ConnectOs = (typeof CONNECT_OS_VALUES)[number];
/** The systems a protocol 1 client knows; its manifest names no others (D-03). */
export const CONNECT_LEGACY_OS_VALUES = ["darwin", "linux"] as const satisfies readonly ConnectOs[];
export type ConnectLegacyOs = (typeof CONNECT_LEGACY_OS_VALUES)[number];
export const CONNECT_ARCH_VALUES = ["amd64", "arm64"] as const;
export type ConnectArch = (typeof CONNECT_ARCH_VALUES)[number];
/** The four targets of the manifest a protocol 1 client gets, in this order. */
export const CONNECT_LEGACY_CLIENT_TARGETS: readonly Readonly<{ os: ConnectLegacyOs; arch: ConnectArch }>[] = Object.freeze(
  CONNECT_LEGACY_OS_VALUES.flatMap((os) => CONNECT_ARCH_VALUES.map((arch) => Object.freeze({ os, arch })))
);

/** Agent operations of protocol 2, the `op` of an `op` command. */
export const CONNECT_OPS = [
  "shell",
  "job_output",
  "job_stop",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "stat",
  "list_dirs",
  "recent_dirs"
] as const;
export type ConnectOp = (typeof CONNECT_OPS)[number];
/** The shell `shell` runs: Windows PowerShell 5.1, PowerShell 7+ or the user's POSIX login shell. */
export const CONNECT_SHELL_KINDS = ["powershell", "pwsh", "posix"] as const;
export type ConnectShellKind = (typeof CONNECT_SHELL_KINDS)[number];
export const CONNECT_GREP_MODES = ["files", "content", "count"] as const;
export type ConnectGrepMode = (typeof CONNECT_GREP_MODES)[number];
/** A file's line endings as `read` found them; `edit` keeps them. */
export const CONNECT_LINE_ENDINGS = ["lf", "crlf", "mixed", "none"] as const;
export type ConnectLineEnding = (typeof CONNECT_LINE_ENDINGS)[number];
export const CONNECT_STAT_KINDS = ["file", "dir", "other"] as const;
export type ConnectStatKind = (typeof CONNECT_STAT_KINDS)[number];

/**
 * Codes a protocol 2 device may put in `reply {ok: false}` for an `op`.
 * `connect_unsupported` answers an op this client does not know;
 * `connect_device_error` is any other failure on the device.
 */
export const CONNECT_OP_ERROR_CODES = [
  "computer_timeout",
  "computer_cancelled",
  "computer_path_not_found",
  "computer_not_a_directory",
  "computer_is_a_directory",
  "computer_permission_denied",
  "computer_file_binary",
  "computer_file_too_large",
  "computer_edit_no_match",
  "computer_edit_ambiguous",
  "computer_job_not_found",
  "computer_limit",
  "computer_pattern_invalid",
  "connect_unsupported",
  "connect_device_error"
] as const;
export type ConnectOpErrorCode = (typeof CONNECT_OP_ERROR_CODES)[number];
export const CONNECT_PAIRING_DECISIONS = ["approve", "deny"] as const;
export type ConnectPairingDecision = (typeof CONNECT_PAIRING_DECISIONS)[number];

/** Pairing code alphabet: digits and capitals without 0, 1, I, L, O and U. */
export const CONNECT_USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export const CONNECT_USER_CODE_PATTERN = new RegExp(
  `^[${CONNECT_USER_CODE_ALPHABET}]{4}-[${CONNECT_USER_CODE_ALPHABET}]{4}$`,
  "u"
);
export const CONNECT_DEVICE_TOKEN_PATTERN = /^aiqsa_connect_[A-Za-z0-9_-]{43}$/u;
export const CONNECT_POLL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
/** Device, pairing, request and run ids: lowercase UUIDs. */
export const CONNECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A release version from `package.json`, or `dev` for an unstamped client build. */
export const CONNECT_VERSION_PATTERN =
  /^(?:dev|(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,32})?)$/u;
export const CONNECT_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
export const CONNECT_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
/** Display text and paths never carry C0/C1 control characters or DEL. */
export const CONNECT_CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f-\x9f]/u;
export const CONNECT_URL_PREFIX_PATTERN = /^https?:\/\//u;
/** A protocol 2 client's absolute path: POSIX, a Windows drive (`C:\` or `C:/`) or a UNC share. */
export const CONNECT_DEVICE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\).*$/u;
/** A background job id the device chose. */
export const CONNECT_JOB_ID_PATTERN = /^job-[a-z0-9]{6,16}$/u;
/** A text encoding's lowercase name as `read` reports it, for example `utf-8`, `utf-16le` or `windows-1251`. */
export const CONNECT_ENCODING_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

// Paths. Device API: Bearer device token only, never cookies.
export const CONNECT_DEVICE_API_PREFIX = "/connect-api/v1";
export const CONNECT_PAIRINGS_PATH = `${CONNECT_DEVICE_API_PREFIX}/pairings`;
export const CONNECT_PAIRING_POLL_PATH = `${CONNECT_DEVICE_API_PREFIX}/pairings/poll`;
export const CONNECT_DEVICE_STREAM_PATH = `${CONNECT_DEVICE_API_PREFIX}/stream`;
export const CONNECT_DEVICE_EVENTS_PATH = `${CONNECT_DEVICE_API_PREFIX}/events`;
export const CONNECT_CLIENT_MANIFEST_PATH = `${CONNECT_DEVICE_API_PREFIX}/client`;
/** `DELETE`: the device revokes itself (tray "Disconnect this computer", uninstall, `logout`; D-16). */
export const CONNECT_DEVICE_SELF_PATH = `${CONNECT_DEVICE_API_PREFIX}/device`;
/** The client version on every device API request; the server records it on the device when the stream opens. */
export const CONNECT_CLIENT_VERSION_HEADER = "X-AIQSA-Connect-Version";
/**
 * `2` on every device API request of a protocol 2 client. A stream request
 * without it answers 426 `connect_client_outdated` and a manifest request
 * without it gets the legacy manifest (D-03).
 */
export const CONNECT_PROTOCOL_HEADER = "X-AIQSA-Connect-Protocol";

// Browser API: the AIQSA cookie session.
export const CONNECT_BROWSER_API_PREFIX = "/api/connect";
export const CONNECT_DEVICES_PATH = `${CONNECT_BROWSER_API_PREFIX}/devices`;
export const CONNECT_EVENTS_PATH = `${CONNECT_BROWSER_API_PREFIX}/events`;
export const CONNECT_PAIRINGS_BY_CODE_PATH = `${CONNECT_BROWSER_API_PREFIX}/pairings/by-code`;

// Pages and public downloads.
export const CONNECT_PAGE_PATH = "/connect";
export const CONNECT_PAIR_PAGE_PATH = `${CONNECT_PAGE_PATH}/pair`;
export const CONNECT_INSTALL_SCRIPT_PATH = `${CONNECT_PAGE_PATH}/install.sh`;
export const CONNECT_CLIENT_DOWNLOAD_PREFIX = `${CONNECT_PAGE_PATH}/download`;
export const CONNECT_CLIENT_CHECKSUMS_PATH = `${CONNECT_PAGE_PATH}/checksums.txt`;
export const CONNECT_CLIENT_BINARY_PREFIX = "aiqsa-connect";
export const CONNECT_WINDOWS_EXECUTABLE_SUFFIX = ".exe";

const segment = encodeURIComponent;

export function connectPairingByCodePath(userCode: string): string {
  return `${CONNECT_PAIRINGS_BY_CODE_PATH}/${segment(userCode)}`;
}
export function connectDevicePath(deviceId: string): string {
  return `${CONNECT_DEVICES_PATH}/${segment(deviceId)}`;
}
export function connectRecentDirsPath(deviceId: string): string {
  return `${connectDevicePath(deviceId)}/recent-dirs`;
}
export function connectPairPagePath(userCode: string): string {
  return `${CONNECT_PAIR_PAGE_PATH}?code=${segment(userCode)}`;
}
/** The release file name of one target, for example `aiqsa-connect-linux-amd64` or `aiqsa-connect-windows-arm64.exe`. */
export function connectClientBinaryName(os: ConnectOs, arch: ConnectArch): string {
  return `${CONNECT_CLIENT_BINARY_PREFIX}-${os}-${arch}${os === "windows" ? CONNECT_WINDOWS_EXECUTABLE_SUFFIX : ""}`;
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

/** UTF-8 text of `min`..`max` bytes; control characters allowed (commands, file content, output). */
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
const emptySchema = z.strictObject({});

function uniqueBy<T>(key: (item: T) => string) {
  return (items: readonly T[]) => new Set(items.map(key)).size === items.length;
}

export const connectErrorResponseSchema = z.strictObject({
  code: z.enum(CONNECT_REASON_CODES)
});

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
    deviceToken: z.string().regex(CONNECT_DEVICE_TOKEN_PATTERN),
    account: textSchema(CONNECT_MAX_ACCOUNT_LABEL_LENGTH)
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
export const connectDeviceStreamClosedSchema = z.strictObject({
  code: z.enum(CONNECT_DEVICE_STREAM_CLOSED_CODES)
});

// Protocol 2: the device stream, `op` commands and their results.

/** A path argument the device resolves: absolute, `~`, `~/…` or relative to the operation's `cwd`; on Windows `\` or `/`, drives and UNC. */
const argPathSchema = textSchema(CONNECT_MAX_CWD_LENGTH);
/** An absolute path the device reports. */
const devicePathSchema = pathSchema(CONNECT_DEVICE_PATH_PATTERN);
const jobIdSchema = z.string().regex(CONNECT_JOB_ID_PATTERN);
/** A non-negative safe integer: sizes, durations and counts. */
const countSchema = boundedInt(0, CONNECT_MAX_SEQ);
const exitCodeSchema = boundedInt(CONNECT_MIN_EXIT_CODE, CONNECT_MAX_EXIT_CODE);
const lineNumberSchema = boundedInt(1, CONNECT_MAX_LINE_NUMBER);
const streamOutputSchema = bytesTextSchema(0, CONNECT_MAX_STREAM_OUTPUT_BYTES);
const patternSchema = textSchema(CONNECT_MAX_PATTERN_LENGTH);

export const connectHelloV2LimitsSchema = z.strictObject({
  maxEventsPerPost: boundedInt(1, CONNECT_MAX_EVENTS_PER_POST),
  maxEventsBodyBytes: boundedInt(1, CONNECT_MAX_EVENTS_BODY_BYTES),
  maxReplyBytes: boundedInt(1, CONNECT_MAX_REPLY_BYTES),
  maxWriteBytes: boundedInt(1, CONNECT_MAX_WRITE_BYTES),
  maxConcurrentOps: boundedInt(1, CONNECT_MAX_CONCURRENT_OPS),
  maxJobs: boundedInt(1, CONNECT_MAX_JOBS),
  maxShellTimeoutSeconds: boundedInt(1, CONNECT_MAX_SHELL_TIMEOUT_SECONDS),
  maxRecentDirs: boundedInt(1, CONNECT_MAX_RECENT_DIRS),
  maxListDirs: boundedInt(1, CONNECT_MAX_LIST_DIRS),
  heartbeatSeconds: boundedInt(1, CONNECT_HEARTBEAT_SECONDS)
});
export type ConnectHelloV2Limits = z.infer<typeof connectHelloV2LimitsSchema>;

/** The limits a protocol 2 server announces when it enforces the contract maxima. */
export const CONNECT_DEFAULT_HELLO_V2_LIMITS: ConnectHelloV2Limits = Object.freeze({
  maxEventsPerPost: CONNECT_MAX_EVENTS_PER_POST,
  maxEventsBodyBytes: CONNECT_MAX_EVENTS_BODY_BYTES,
  maxReplyBytes: CONNECT_MAX_REPLY_BYTES,
  maxWriteBytes: CONNECT_MAX_WRITE_BYTES,
  maxConcurrentOps: CONNECT_MAX_CONCURRENT_OPS,
  maxJobs: CONNECT_MAX_JOBS,
  maxShellTimeoutSeconds: CONNECT_MAX_SHELL_TIMEOUT_SECONDS,
  maxRecentDirs: CONNECT_MAX_RECENT_DIRS,
  maxListDirs: CONNECT_MAX_LIST_DIRS,
  heartbeatSeconds: CONNECT_HEARTBEAT_SECONDS
});

/** The first event of a protocol 2 device stream. */
export const connectHelloV2Schema = z.strictObject({
  protocol: z.literal(CONNECT_PROTOCOL_VERSION),
  deviceId: idSchema,
  serverVersion: versionSchema,
  minClientVersion: versionSchema,
  limits: connectHelloV2LimitsSchema
});

// `op` arguments. The server resolves every default before it sends an op, so every key but the optional ones is required.
export const connectShellArgsSchema = z.strictObject({
  /** The command line; newlines and tabs allowed, never NUL. */
  command: bytesTextSchema(1, CONNECT_MAX_COMMAND_BYTES).refine((value) => !value.includes("\0"), "command contains NUL"),
  cwd: argPathSchema,
  timeoutSeconds: boundedInt(1, CONNECT_MAX_SHELL_TIMEOUT_SECONDS),
  /** Runs as a background job until `job_stop` or `run_ended`; the result is then `{jobId}`. */
  background: z.boolean()
});
export const connectJobOutputArgsSchema = z.strictObject({
  jobId: jobIdSchema,
  /** How long to wait for new output or the job's end. */
  waitSeconds: boundedInt(0, CONNECT_MAX_JOB_WAIT_SECONDS)
});
export const connectJobStopArgsSchema = z.strictObject({ jobId: jobIdSchema });
export const connectReadArgsSchema = z.strictObject({
  path: argPathSchema,
  cwd: argPathSchema,
  /** The first line to return, from 1. */
  offset: lineNumberSchema,
  limit: boundedInt(1, CONNECT_MAX_READ_LINES)
});
export const connectWriteArgsSchema = z.strictObject({
  path: argPathSchema,
  cwd: argPathSchema,
  content: bytesTextSchema(0, CONNECT_MAX_WRITE_BYTES)
});
export const connectEditArgsSchema = z.strictObject({
  path: argPathSchema,
  cwd: argPathSchema,
  oldString: bytesTextSchema(1, CONNECT_MAX_WRITE_BYTES),
  newString: bytesTextSchema(0, CONNECT_MAX_WRITE_BYTES),
  /** Without it, no match answers `computer_edit_no_match` and more than one `computer_edit_ambiguous`. */
  replaceAll: z.boolean()
});
export const connectGlobArgsSchema = z.strictObject({
  pattern: patternSchema,
  cwd: argPathSchema,
  /** The directory to search; `cwd` when absent. */
  path: argPathSchema.optional()
});
export const connectGrepArgsSchema = z.strictObject({
  /** An RE2 regular expression; an invalid one answers `computer_pattern_invalid`. */
  pattern: patternSchema,
  cwd: argPathSchema,
  path: argPathSchema.optional(),
  /** A glob that file names must match. */
  glob: patternSchema.optional(),
  ignoreCase: z.boolean(),
  mode: z.enum(CONNECT_GREP_MODES),
  /** Lines around each match in `content` mode. */
  context: boundedInt(0, CONNECT_MAX_GREP_CONTEXT)
});
export const connectStatArgsSchema = z.strictObject({ path: argPathSchema });
export const connectListDirsArgsSchema = z.strictObject({ path: argPathSchema });
export const connectRecentDirsArgsSchema = emptySchema;

/** Each op's arguments, in {@link CONNECT_OPS} order. */
export const connectOpArgsSchemas = {
  shell: connectShellArgsSchema,
  job_output: connectJobOutputArgsSchema,
  job_stop: connectJobStopArgsSchema,
  read: connectReadArgsSchema,
  write: connectWriteArgsSchema,
  edit: connectEditArgsSchema,
  glob: connectGlobArgsSchema,
  grep: connectGrepArgsSchema,
  stat: connectStatArgsSchema,
  list_dirs: connectListDirsArgsSchema,
  recent_dirs: connectRecentDirsArgsSchema
} as const satisfies Record<ConnectOp, z.ZodType>;
export type ConnectOpArgs<Op extends ConnectOp = ConnectOp> = z.infer<(typeof connectOpArgsSchemas)[Op]>;

function opCommandSchema<const Op extends ConnectOp>(op: Op) {
  return z.strictObject({
    type: z.literal("op"),
    requestId: idSchema,
    /** The run the operation belongs to; `run_ended` stops its processes and background jobs. */
    runId: idSchema,
    op: z.literal(op),
    args: connectOpArgsSchemas[op],
    /** How long the device may work on it, in milliseconds from receipt; then it answers `computer_timeout`. */
    deadlineMs: boundedInt(1, CONNECT_MAX_OP_DEADLINE_MS)
  });
}

/** `op`: one agent operation, answered by `reply` with the op's result or one of {@link CONNECT_OP_ERROR_CODES}. */
export const connectOpCommandSchema = z.discriminatedUnion("op", [
  opCommandSchema("shell"),
  opCommandSchema("job_output"),
  opCommandSchema("job_stop"),
  opCommandSchema("read"),
  opCommandSchema("write"),
  opCommandSchema("edit"),
  opCommandSchema("glob"),
  opCommandSchema("grep"),
  opCommandSchema("stat"),
  opCommandSchema("list_dirs"),
  opCommandSchema("recent_dirs")
]);
export type ConnectOpCommand = z.infer<typeof connectOpCommandSchema>;
/** `cancel`: the server stopped waiting for an operation; the device stops it and need not answer. */
export const connectCancelCommandSchema = z.strictObject({
  type: z.literal("cancel"),
  requestId: idSchema
});
/** `run_ended`: the run is over; the device stops every process and background job it started for it. */
export const connectRunEndedCommandSchema = z.strictObject({
  type: z.literal("run_ended"),
  runId: idSchema
});

export const connectServerCommandV2Schema = z.discriminatedUnion("type", [
  connectOpCommandSchema,
  connectCancelCommandSchema,
  connectRunEndedCommandSchema
]);
export type ConnectServerCommandV2 = z.infer<typeof connectServerCommandV2Schema>;

export const connectDeviceStreamEventV2Schema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("hello"), data: connectHelloV2Schema }),
  z.strictObject({ event: z.literal("command"), data: connectServerCommandV2Schema }),
  z.strictObject({ event: z.literal("ping"), data: emptySchema }),
  z.strictObject({ event: z.literal("replaced"), data: emptySchema }),
  z.strictObject({ event: z.literal("closed"), data: connectDeviceStreamClosedSchema })
]);
export type ConnectDeviceStreamEventV2 = z.infer<typeof connectDeviceStreamEventV2Schema>;

// `op` results, the `reply.result` of each op.
/** A foreground command's result; each stream keeps its head and tail ({@link CONNECT_OUTPUT_HEAD_BYTES}). */
export const connectShellResultSchema = z.strictObject({
  exitCode: exitCodeSchema,
  stdout: streamOutputSchema,
  stderr: streamOutputSchema,
  truncated: z.boolean(),
  /** The streams' full sizes before truncation. */
  stdoutBytes: countSchema,
  stderrBytes: countSchema,
  durationMs: countSchema
});
/** A background command's result. */
export const connectShellJobResultSchema = z.strictObject({ jobId: jobIdSchema });
export const connectShellOpResultSchema = z.union([connectShellResultSchema, connectShellJobResultSchema]);
/** The output since the previous `job_output`, and the exit code once the job has ended. */
export const connectJobOutputResultSchema = z.discriminatedUnion("running", [
  z.strictObject({
    running: z.literal(true),
    stdout: streamOutputSchema,
    stderr: streamOutputSchema,
    truncated: z.boolean()
  }),
  z.strictObject({
    running: z.literal(false),
    exitCode: exitCodeSchema,
    stdout: streamOutputSchema,
    stderr: streamOutputSchema,
    truncated: z.boolean()
  })
]);
export const connectJobStopResultSchema = z.strictObject({ stopped: z.boolean() });
export const connectReadResultSchema = z.strictObject({
  /** The lines decoded to UTF-8, each cut to {@link CONNECT_MAX_READ_LINE_LENGTH} characters. */
  content: bytesTextSchema(0, CONNECT_MAX_READ_BYTES),
  startLine: lineNumberSchema,
  totalLines: boundedInt(0, CONNECT_MAX_LINE_NUMBER),
  truncated: z.boolean(),
  encoding: z.string().regex(CONNECT_ENCODING_PATTERN),
  lineEnding: z.enum(CONNECT_LINE_ENDINGS)
});
export const connectWriteResultSchema = z.strictObject({
  /** Bytes written to the file. */
  bytes: countSchema,
  created: z.boolean()
});
export const connectEditResultSchema = z.strictObject({ replacements: boundedInt(1, CONNECT_MAX_SEQ) });
export const connectGlobResultSchema = z.strictObject({
  /** Most recently modified first. */
  paths: z.array(devicePathSchema).max(CONNECT_MAX_GLOB_PATHS),
  truncated: z.boolean()
});
function grepMatchesSchema<T extends z.ZodType>(match: T) {
  return z.array(match).max(CONNECT_MAX_GREP_MATCHES);
}
export const connectGrepResultSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("files"),
    matches: grepMatchesSchema(z.strictObject({ path: devicePathSchema })),
    truncated: z.boolean()
  }),
  z.strictObject({
    mode: z.literal("content"),
    matches: grepMatchesSchema(z.strictObject({
      path: devicePathSchema,
      line: lineNumberSchema,
      text: bytesTextSchema(0, CONNECT_MAX_LINE_BYTES),
      /** Set on a line around a match rather than a match. */
      context: z.literal(true).optional()
    })),
    truncated: z.boolean()
  }),
  z.strictObject({
    mode: z.literal("count"),
    matches: grepMatchesSchema(z.strictObject({ path: devicePathSchema, count: boundedInt(1, CONNECT_MAX_SEQ) })),
    truncated: z.boolean()
  })
]);
export const connectStatResultSchema = z.discriminatedUnion("exists", [
  z.strictObject({ exists: z.literal(false) }),
  z.strictObject({
    exists: z.literal(true),
    /** The resolved absolute path. */
    path: devicePathSchema,
    kind: z.enum(CONNECT_STAT_KINDS),
    size: countSchema,
    mtime: timestampSchema
  })
]);
export const connectListDirsResultSchema = z.strictObject({
  /** The resolved absolute path of the listed directory. */
  path: devicePathSchema,
  /** Null at a root. */
  parent: devicePathSchema.nullable(),
  /** Names of the subdirectories, sorted, without hidden ones. */
  dirs: z.array(textSchema(CONNECT_MAX_DIR_NAME_LENGTH)).max(CONNECT_MAX_LIST_DIRS),
  truncated: z.boolean()
});
/** The home directory and the working directories of recent operations, most recent first. */
export const connectOpRecentDirsResultSchema = z.strictObject({
  home: devicePathSchema,
  dirs: z.array(devicePathSchema).max(CONNECT_MAX_RECENT_DIRS)
});

/** Each op's result, in {@link CONNECT_OPS} order. */
export const connectOpResultSchemas = {
  shell: connectShellOpResultSchema,
  job_output: connectJobOutputResultSchema,
  job_stop: connectJobStopResultSchema,
  read: connectReadResultSchema,
  write: connectWriteResultSchema,
  edit: connectEditResultSchema,
  glob: connectGlobResultSchema,
  grep: connectGrepResultSchema,
  stat: connectStatResultSchema,
  list_dirs: connectListDirsResultSchema,
  recent_dirs: connectOpRecentDirsResultSchema
} as const satisfies Record<ConnectOp, z.ZodType>;
export type ConnectOpResult<Op extends ConnectOp = ConnectOp> = z.infer<(typeof connectOpResultSchemas)[Op]>;

/** Validates a `reply.result` against the op the server sent; null when it does not match. */
export function parseConnectOpResult<Op extends ConnectOp>(op: Op, result: unknown): ConnectOpResult<Op> | null {
  const decoded = (connectOpResultSchemas[op] as z.ZodType).safeParse(result);
  return decoded.success ? decoded.data as ConnectOpResult<Op> : null;
}

// Protocol 2 device events, POSTed in batches to `/connect-api/v1/events`.
export const connectOpReplyEventSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("reply"),
    requestId: idSchema,
    ok: z.literal(true),
    /** One op's result shape; `parseConnectOpResult` checks it against the sent op. */
    result: z.union([
      connectShellResultSchema,
      connectShellJobResultSchema,
      connectJobOutputResultSchema,
      connectJobStopResultSchema,
      connectReadResultSchema,
      connectWriteResultSchema,
      connectEditResultSchema,
      connectGlobResultSchema,
      connectGrepResultSchema,
      connectStatResultSchema,
      connectListDirsResultSchema,
      connectOpRecentDirsResultSchema
    ])
  }),
  z.strictObject({
    type: z.literal("reply"),
    requestId: idSchema,
    ok: z.literal(false),
    code: z.enum(CONNECT_OP_ERROR_CODES)
  })
]);
export const connectDeviceShellSchema = z.strictObject({
  kind: z.enum(CONNECT_SHELL_KINDS),
  /** For example `Windows PowerShell`, `pwsh` or `zsh`. */
  name: textSchema(CONNECT_MAX_SHELL_NAME_LENGTH),
  /** Absent when the device cannot tell. */
  version: textSchema(CONNECT_MAX_SHELL_VERSION_LENGTH).optional()
});
/** `device_info`: sent once after each `hello`; the server keeps it in memory while the stream lives. */
export const connectDeviceInfoEventSchema = z.strictObject({
  type: z.literal("device_info"),
  os: osSchema,
  /** For example `Windows 11 Pro 23H2`, `macOS 15.1` or `Ubuntu 24.04.1 LTS`. */
  osVersion: textSchema(CONNECT_MAX_OS_VERSION_LENGTH),
  arch: archSchema,
  hostname: textSchema(CONNECT_MAX_HOSTNAME_LENGTH),
  home: devicePathSchema,
  shell: connectDeviceShellSchema
});

export const connectDeviceEventV2Schema = z.discriminatedUnion("type", [
  connectOpReplyEventSchema,
  connectDeviceInfoEventSchema
]);
export type ConnectDeviceEventV2 = z.infer<typeof connectDeviceEventV2Schema>;

export const connectDeviceEventBatchV2Schema = z.strictObject({
  events: z.array(connectDeviceEventV2Schema).min(1).max(CONNECT_MAX_EVENTS_PER_POST)
});

/**
 * Field schemas other contract modules compose (`lib/contracts/computer.ts`),
 * so a computer's browser projection keeps the device API's bounds.
 */
export const connectWireFields = Object.freeze({
  arch: archSchema,
  deviceId: idSchema,
  deviceName: textSchema(CONNECT_MAX_DEVICE_NAME_LENGTH),
  devicePath: devicePathSchema,
  os: osSchema,
  osVersion: textSchema(CONNECT_MAX_OS_VERSION_LENGTH),
  shell: connectDeviceShellSchema,
  timestamp: timestampSchema,
  version: versionSchema
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
/**
 * The manifest a protocol 1 client gets (no {@link CONNECT_PROTOCOL_HEADER}):
 * what its strict decoder accepts, at most four darwin and linux targets.
 */
export const connectLegacyClientManifestSchema = z.strictObject({
  version: versionSchema,
  targets: z.array(z.strictObject({
    os: z.enum(CONNECT_LEGACY_OS_VALUES),
    arch: archSchema,
    sha256: z.string().regex(CONNECT_SHA256_PATTERN),
    size: boundedInt(1, CONNECT_MAX_CLIENT_BINARY_BYTES)
  }))
    .min(1)
    .max(CONNECT_LEGACY_MAX_CLIENT_TARGETS)
    .refine(uniqueBy((target: { os: string; arch: string }) => `${target.os}-${target.arch}`), "duplicate target")
});

/** HTTP status of each refusal; the body is always `{code}`. Clients decide by `code`, not by status. */
export const CONNECT_REASON_HTTP_STATUS = Object.freeze({
  connect_disabled: 403,
  connect_unauthorized: 401,
  connect_device_offline: 409,
  connect_device_limit: 409,
  connect_client_outdated: 426,
  /** One neutral answer for unknown, expired, consumed and already decided pairing codes. */
  connect_pairing_expired: 404,
  connect_rate_limited: 429,
  connect_input_too_large: 413,
  connect_stream_required: 409,
  connect_unsupported: 501,
  connect_client_unavailable: 503,
  /** One answer for unknown and foreign devices, for admins too. */
  connect_not_found: 404,
  connect_request_invalid: 400,
  connect_device_error: 502
} satisfies Record<ConnectReasonCode, number>);

// Admin policy `/api/admin/connect` (admin cookie session; errors use the admin `{error}` convention).
export const CONNECT_ADMIN_POLICY_PATH = "/api/admin/connect";
export const CONNECT_ADMIN_POLICY_CONFLICT_ERROR = "connect_policy_version_conflict";
export const connectAdminPolicySchema = z.strictObject({
  enabled: z.boolean(),
  version: boundedInt(1, Number.MAX_SAFE_INTEGER)
});
export const connectAdminPolicyResponseSchema = z.strictObject({ connect: connectAdminPolicySchema });
/** PATCH body; a stale `expectedVersion` answers 409 `{error: CONNECT_ADMIN_POLICY_CONFLICT_ERROR}`. */
export const connectAdminPolicyUpdateRequestSchema = z.strictObject({
  enabled: z.boolean(),
  expectedVersion: boundedInt(1, Number.MAX_SAFE_INTEGER)
});
export type ConnectAdminPolicy = z.infer<typeof connectAdminPolicySchema>;
export type ConnectAdminPolicyResponse = z.infer<typeof connectAdminPolicyResponseSchema>;
export type ConnectAdminPolicyUpdateRequest = z.infer<typeof connectAdminPolicyUpdateRequestSchema>;

export const CONNECT_DEVICE_STREAM_EVENTS = ["hello", "command", "ping", "replaced", "closed"] as const satisfies
  readonly ConnectDeviceStreamEventV2["event"][];
/** The `/api/connect/events` frames (`connectComputerEventsStreamEventSchema` in `lib/contracts/computer.ts`). */
export const CONNECT_EVENTS_STREAM_EVENTS = ["devices", "device", "closed", "ping"] as const;

export type ConnectErrorResponse = z.infer<typeof connectErrorResponseSchema>;
export type ConnectPairingCreateRequest = z.infer<typeof connectPairingCreateRequestSchema>;
export type ConnectPairingCreateResponse = z.infer<typeof connectPairingCreateResponseSchema>;
export type ConnectPairingPollRequest = z.infer<typeof connectPairingPollRequestSchema>;
export type ConnectPairingPollResponse = z.infer<typeof connectPairingPollResponseSchema>;
export type ConnectPairingLookupResponse = z.infer<typeof connectPairingLookupResponseSchema>;
export type ConnectPairingDecisionRequest = z.infer<typeof connectPairingDecisionRequestSchema>;
export type ConnectPairingDecisionResponse = z.infer<typeof connectPairingDecisionResponseSchema>;
export type ConnectDeviceStreamClosed = z.infer<typeof connectDeviceStreamClosedSchema>;
export type ConnectClientTarget = z.infer<typeof connectClientTargetSchema>;
export type ConnectClientManifest = z.infer<typeof connectClientManifestSchema>;
export type ConnectLegacyClientManifest = z.infer<typeof connectLegacyClientManifestSchema>;
export type ConnectHelloV2 = z.infer<typeof connectHelloV2Schema>;
export type ConnectCancelCommand = z.infer<typeof connectCancelCommandSchema>;
export type ConnectRunEndedCommand = z.infer<typeof connectRunEndedCommandSchema>;
export type ConnectOpReplyEvent = z.infer<typeof connectOpReplyEventSchema>;
export type ConnectDeviceShell = z.infer<typeof connectDeviceShellSchema>;
export type ConnectDeviceInfoEvent = z.infer<typeof connectDeviceInfoEventSchema>;
export type ConnectDeviceEventBatchV2 = z.infer<typeof connectDeviceEventBatchV2Schema>;

// Browser decoders: null on any invalid value.
function decoder<T>(schema: z.ZodType<T>): (value: unknown) => T | null {
  return (value) => {
    const decoded = schema.safeParse(value);
    return decoded.success ? decoded.data : null;
  };
}

export const decodeConnectErrorResponse = decoder(connectErrorResponseSchema);
export const decodeConnectPairingLookupResponse = decoder(connectPairingLookupResponseSchema);
export const decodeConnectPairingDecisionResponse = decoder(connectPairingDecisionResponseSchema);
export const decodeConnectAdminPolicyResponse = decoder(connectAdminPolicyResponseSchema);
