import { z } from "zod";
import {
  CONNECT_CONTROL_CHARACTER_PATTERN,
  CONNECT_DEVICES_PATH,
  CONNECT_EVENTS_STREAM_CLOSED_CODES,
  CONNECT_ID_PATTERN,
  CONNECT_MAX_CWD_LENGTH,
  CONNECT_MAX_DEVICES_PER_USER,
  CONNECT_MAX_EXIT_CODE,
  CONNECT_MAX_TRANSFER_BYTES,
  CONNECT_MIN_EXIT_CODE,
  CONNECT_OP_ERROR_CODES,
  CONNECT_REASON_CODES,
  CONNECT_REASON_HTTP_STATUS,
  connectDevicePath,
  connectListDirsResultSchema,
  connectOpRecentDirsResultSchema,
  connectRecentDirsPath,
  connectStatResultSchema,
  connectWireFields,
  type ConnectOp,
  type ConnectReasonCode
} from "./connect";

/**
 * The agent working on the user's computer through AIQSA Connect: the chat's
 * computer binding and its send field, the agent's tool names, the stable
 * failure codes, the answer steps and the browser's computer list. The device
 * protocol itself is `lib/contracts/connect.ts`.
 */

/**
 * The send-body field that chooses the chat's computer for this and later
 * messages: `{deviceId, cwd}` chooses one, `null` stops using a computer,
 * and absent means this message runs without a computer while the chat's
 * stored choice stays as it was ({@link decodeComputerSendField}). The
 * composer always sends the field, so absent comes only from older clients
 * and paths that never offer a computer; the server never runs a message on
 * a stored choice the sender did not send.
 */
export const COMPUTER_SEND_FIELD = "computer";

/** A working folder in code points; it is where commands start, not a boundary (O-10). */
export const COMPUTER_MAX_CWD_LENGTH = CONNECT_MAX_CWD_LENGTH;

/**
 * A chat's computer: one of the user's Connect devices and the folder its
 * commands and relative paths start in, as the user wrote or picked it (`~`,
 * an absolute POSIX or Windows path); the device resolves it.
 */
export type ChatComputerBinding = Readonly<{ deviceId: string; cwd: string }>;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** A non-blank path of at most {@link COMPUTER_MAX_CWD_LENGTH} code points without NUL or other control characters. */
export function isComputerPath(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= COMPUTER_MAX_CWD_LENGTH * 2 &&
    codePointLength(value) <= COMPUTER_MAX_CWD_LENGTH &&
    !CONNECT_CONTROL_CHARACTER_PATTERN.test(value);
}

/** Exactly `{deviceId, cwd}` with a lowercase UUID and a bounded path; null for anything else. */
export function decodeChatComputerBinding(value: unknown): ChatComputerBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("deviceId") || !keys.includes("cwd")) return null;
  const { cwd, deviceId } = record;
  if (typeof deviceId !== "string" || !CONNECT_ID_PATTERN.test(deviceId) || !isComputerPath(cwd)) return null;
  return { cwd, deviceId };
}

/**
 * The send field's value: `undefined` when absent (no computer for this
 * message; the chat's stored choice is left alone), `null` for an explicit
 * "no computer" that also clears the stored choice, the binding, or "invalid"
 * for anything else ({@link COMPUTER_REFUSALS}`.invalid`). Whether the device
 * is the user's and usable is the server's check at admission.
 */
export function decodeComputerSendField(value: unknown): ChatComputerBinding | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return decodeChatComputerBinding(value) ?? "invalid";
}

/**
 * Why a send that chose a computer was refused, as the response's `error`:
 * `invalid` (400) for a malformed field; `unavailable` (409) for a device
 * that is gone, revoked or not the user's, one answer for all three;
 * `disabled` (409) while an administrator has AIQSA Connect off; `notHere`
 * (409) where a computer is never available: Assistant chats, Telegram,
 * scheduled tasks, webhooks and monitoring checks (D-07).
 */
export const COMPUTER_REFUSALS = Object.freeze({
  disabled: "connect_disabled",
  invalid: "computer_binding_invalid",
  notHere: "computer_unavailable_here",
  unavailable: "connect_device_unavailable"
} as const);
export type ComputerRefusalCode = (typeof COMPUTER_REFUSALS)[keyof typeof COMPUTER_REFUSALS];
export const COMPUTER_REFUSAL_HTTP_STATUS = Object.freeze({
  computer_binding_invalid: 400,
  computer_unavailable_here: 409,
  connect_device_unavailable: 409,
  connect_disabled: 409
} satisfies Record<ComputerRefusalCode, number>);

/**
 * The tool that gives the user a file from the computer to download from the answer (operator decision 2026-11-07):
 * it reads only, and only the main agent has it, since only the main agent's run is shown on the answer.
 */
export const COMPUTER_ATTACH_FILE_TOOL_NAME = "computer_attach_file";

/**
 * `computer_attach_file`'s bounds: a file is one device transfer; an answer takes at most `filesPerRun` of them, about
 * as many as a Workspace answer exports by default, so its list of downloads stays readable and one answer stores at
 * most 1.25 GiB. `callMs` bounds one call, the transfer and the upload to storage (`uploadMs`) together.
 */
export const COMPUTER_ATTACH_FILE_LIMITS = Object.freeze({
  callMs: 300_000,
  filesPerRun: 20,
  maxBytes: CONNECT_MAX_TRANSFER_BYTES,
  uploadMs: 60_000
});

/** The engine's computer tools, available only to a run admitted with a computer binding. */
export const COMPUTER_TOOL_NAMES = [
  "computer_shell",
  "computer_job_output",
  "computer_job_stop",
  "computer_read",
  "computer_write",
  "computer_edit",
  "computer_glob",
  "computer_grep",
  COMPUTER_ATTACH_FILE_TOOL_NAME
] as const;
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];

/** The device op each tool sends. */
export const COMPUTER_TOOL_OPS = Object.freeze({
  computer_attach_file: "read_bytes",
  computer_edit: "edit",
  computer_glob: "glob",
  computer_grep: "grep",
  computer_job_output: "job_output",
  computer_job_stop: "job_stop",
  computer_read: "read",
  computer_shell: "shell",
  computer_write: "write"
} as const satisfies Record<ComputerToolName, ConnectOp>);

export function isComputerToolName(value: unknown): value is ComputerToolName {
  return typeof value === "string" && (COMPUTER_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * Codes the server decides for an operation: the device is not connected,
 * its stream dropped while the operation waited, it is gone or not the
 * user's, or AIQSA Connect is off; or a file fetched in chunks changed
 * between them (`computer_file_changed`, `lib/server/connect/computerFileFetch.ts`); or
 * `computer_read` met an image the run's model cannot see (`computer_image_needs_vision`,
 * `lib/server/tools/computerReadFiles.ts`).
 */
export const COMPUTER_SERVER_FAILURE_CODES = [
  "connect_device_offline",
  "connect_device_disconnected",
  "connect_device_unavailable",
  "connect_disabled",
  "computer_file_changed",
  "computer_image_needs_vision"
] as const;

/** Every stable code an operation can fail with: the server's and the device's ({@link CONNECT_OP_ERROR_CODES}). */
export const COMPUTER_FAILURE_CODES = [...COMPUTER_SERVER_FAILURE_CODES, ...CONNECT_OP_ERROR_CODES] as const;
export type ComputerFailureCode = (typeof COMPUTER_FAILURE_CODES)[number];

export function isComputerFailureCode(value: unknown): value is ComputerFailureCode {
  return typeof value === "string" && (COMPUTER_FAILURE_CODES as readonly string[]).includes(value);
}

// Answer steps: `ThreadToolActivityCall` with origin `computer` (`lib/contracts/chats.ts`).

/** A computer step's one-line `summary`, in code points: the command's first line or the path or pattern. */
export const COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH = 200;

/** One line without control characters, non-blank, at most {@link COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH} code points. */
export function isComputerActivitySummary(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH * 2 &&
    codePointLength(value) <= COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH &&
    !CONNECT_CONTROL_CHARACTER_PATTERN.test(value);
}

const CONTROL_CHARACTERS = new RegExp(CONNECT_CONTROL_CHARACTER_PATTERN.source, "gu");

/**
 * A step's summary from a command, path or pattern: its first non-blank
 * line, control characters dropped, cut with an ellipsis; null when nothing
 * is left.
 */
export function computerActivitySummary(text: string): string | null {
  const line = text.split(/\r\n|\r|\n/u).map((part) => part.replace(CONTROL_CHARACTERS, "").trim()).find((part) => part !== "");
  if (!line) return null;
  const points = Array.from(line);
  if (points.length <= COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH) return line;
  return `${points.slice(0, COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH - 1).join("").trimEnd()}…`;
}

/** A step's exit code: an integer in the device protocol's range. */
export function isComputerExitCode(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= CONNECT_MIN_EXIT_CODE && (value as number) <= CONNECT_MAX_EXIT_CODE;
}

// Browser API: the owner's computers for the composer's picker and the `/connect` page.

/** What the device reported in `device_info` while it is connected. */
export const connectComputerInfoSchema = z.strictObject({
  osVersion: connectWireFields.osVersion,
  home: connectWireFields.devicePath,
  shell: connectWireFields.shell
});

/** One of the owner's computers; `info` only while it is online and has reported it. */
export const connectComputerSchema = z.strictObject({
  id: connectWireFields.deviceId,
  name: connectWireFields.deviceName,
  os: connectWireFields.os,
  arch: connectWireFields.arch,
  online: z.boolean(),
  lastSeenAt: connectWireFields.timestamp.nullable(),
  clientVersion: connectWireFields.version,
  info: connectComputerInfoSchema.optional()
});
export type ConnectComputerWire = z.infer<typeof connectComputerSchema>;
export type ConnectComputerInfoWire = z.infer<typeof connectComputerInfoSchema>;

/** `GET /api/connect/devices`. */
export const connectComputerListResponseSchema = z.strictObject({
  computers: z.array(connectComputerSchema)
    .max(CONNECT_MAX_DEVICES_PER_USER)
    .refine((computers) => new Set(computers.map((computer) => computer.id)).size === computers.length, "duplicate computer id")
});
export type ConnectComputerListResponse = z.infer<typeof connectComputerListResponseSchema>;

/** `GET /api/connect/devices/<id>/recent-dirs`: the device's home and recent working folders. */
export const connectComputerRecentDirsResponseSchema = connectOpRecentDirsResultSchema;
/** `GET /api/connect/devices/<id>/dirs?path=`: one level of subfolders, for the folder picker. */
export const connectComputerDirsResponseSchema = connectListDirsResultSchema;
/** `GET /api/connect/devices/<id>/stat?path=`: whether the chosen folder exists. */
export const connectComputerStatResponseSchema = connectStatResultSchema;
export type ConnectComputerRecentDirsResponse = z.infer<typeof connectComputerRecentDirsResponseSchema>;
export type ConnectComputerDirsResponse = z.infer<typeof connectComputerDirsResponseSchema>;
export type ConnectComputerStatResponse = z.infer<typeof connectComputerStatResponseSchema>;

/** `/api/connect/events`: a `devices` snapshot (resent after a computer is added or removed), then `device` updates. */
export const connectComputerEventsStreamEventSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("devices"), data: connectComputerListResponseSchema }),
  z.strictObject({ event: z.literal("device"), data: z.strictObject({ computer: connectComputerSchema }) }),
  z.strictObject({
    event: z.literal("closed"),
    data: z.strictObject({ code: z.enum(CONNECT_EVENTS_STREAM_CLOSED_CODES) })
  }),
  z.strictObject({ event: z.literal("ping"), data: z.strictObject({}) })
]);
export type ConnectComputerEventsStreamEvent = z.infer<typeof connectComputerEventsStreamEventSchema>;

/** A refusal of the computer routes: the Connect reasons and the operation failures. */
export type ComputerErrorCode = ConnectReasonCode | ComputerFailureCode;
export const COMPUTER_ERROR_CODES: readonly ComputerErrorCode[] = Object.freeze([
  ...new Set<ComputerErrorCode>([...CONNECT_REASON_CODES, ...COMPUTER_FAILURE_CODES])
]);
export const connectComputerErrorResponseSchema = z.strictObject({
  code: z.enum(COMPUTER_ERROR_CODES as unknown as readonly [ComputerErrorCode, ...ComputerErrorCode[]])
});

/** HTTP status of each refusal of the computer routes; the body is always `{code}`, and clients decide by `code`. */
export const COMPUTER_ERROR_HTTP_STATUS = Object.freeze({
  ...CONNECT_REASON_HTTP_STATUS,
  connect_device_disconnected: 409,
  connect_device_unavailable: 404,
  computer_timeout: 504,
  computer_cancelled: 409,
  computer_path_not_found: 404,
  computer_not_a_directory: 422,
  computer_is_a_directory: 422,
  computer_permission_denied: 403,
  computer_file_binary: 422,
  computer_file_too_large: 413,
  computer_file_changed: 409,
  computer_image_needs_vision: 422,
  computer_edit_no_match: 422,
  computer_edit_ambiguous: 422,
  computer_job_not_found: 404,
  computer_limit: 429,
  computer_pattern_invalid: 422,
  computer_text_unencodable: 422
} satisfies Record<ComputerErrorCode, number>);

/** `GET` the owner's computers; also the path of each one's own routes below. */
export const CONNECT_COMPUTERS_PATH = CONNECT_DEVICES_PATH;

export function connectComputerRecentDirsPath(deviceId: string): string {
  return connectRecentDirsPath(deviceId);
}
export function connectComputerDirsPath(deviceId: string, path: string): string {
  return `${connectDevicePath(deviceId)}/dirs?path=${encodeURIComponent(path)}`;
}
export function connectComputerStatPath(deviceId: string, path: string): string {
  return `${connectDevicePath(deviceId)}/stat?path=${encodeURIComponent(path)}`;
}

// Browser decoders: null on any invalid value.
function decoder<T>(schema: z.ZodType<T>): (value: unknown) => T | null {
  return (value) => {
    const decoded = schema.safeParse(value);
    return decoded.success ? decoded.data : null;
  };
}

export const decodeConnectComputerListResponse = decoder(connectComputerListResponseSchema);
export const decodeConnectComputerRecentDirsResponse = decoder(connectComputerRecentDirsResponseSchema);
export const decodeConnectComputerDirsResponse = decoder(connectComputerDirsResponseSchema);
export const decodeConnectComputerStatResponse = decoder(connectComputerStatResponseSchema);
export const decodeConnectComputerErrorResponse = decoder(connectComputerErrorResponseSchema);
const decodeEventsStreamEvent = decoder(connectComputerEventsStreamEventSchema);

/** Decodes one `/api/connect/events` frame from `MessageEvent.type` and its raw `data`. */
export function decodeConnectComputerEventsStreamEvent(event: string, data: string): ConnectComputerEventsStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return decodeEventsStreamEvent({ data: parsed, event });
}
