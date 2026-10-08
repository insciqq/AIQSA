/**
 * Voice dictation wire shapes: the user's catalog flag, the transcription
 * route and the administrator's Speech to text role. Dependency leaf: no
 * server imports.
 */

/** The bounded audio a browser may send for one dictation. */
export const DICTATION_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
/** The composer stops recording on its own after this long. */
export const DICTATION_MAX_DURATION_MS = 5 * 60 * 1_000;
/** A transcript longer than this is refused as an invalid provider response. */
export const DICTATION_TEXT_MAX_CHARACTERS = 64_000;

export const DICTATION_AUDIO_MIME_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"] as const;
export type DictationAudioMimeType = (typeof DICTATION_AUDIO_MIME_TYPES)[number];

/** The recorder formats the composer tries, in order. */
export const DICTATION_RECORDER_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg"] as const;

const MIME_ALIASES: Readonly<Record<string, DictationAudioMimeType>> = {
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/mp4": "audio/mp4",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav"
};

/** The allowlisted base type of a browser MIME value (codec parameters are ignored), or null. */
export function dictationAudioMimeType(value: string): DictationAudioMimeType | null {
  const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_ALIASES[base] ?? null;
}

/** File name extension sent to the provider for each format. */
export function dictationAudioExtension(type: DictationAudioMimeType): string {
  return { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav" }[type];
}

/**
 * Dictation in the user's catalog. `not_configured`: no administrator role,
 * so the composer shows no microphone. `unavailable`: the role is set but its
 * provider, key or test no longer holds; the microphone is shown disabled.
 */
export type DictationUnavailableReason = "not_configured" | "unavailable";

export type CatalogDictation = Readonly<{
  available: boolean;
  unavailableReason: DictationUnavailableReason | null;
}>;

export const DICTATION_NOT_CONFIGURED: CatalogDictation = Object.freeze({ available: false, unavailableReason: "not_configured" });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeCatalogDictation(value: unknown): CatalogDictation | null {
  if (!record(value) || typeof value.available !== "boolean") return null;
  if (value.available) return value.unavailableReason === null ? { available: true, unavailableReason: null } : null;
  return value.unavailableReason === "not_configured" || value.unavailableReason === "unavailable"
    ? { available: false, unavailableReason: value.unavailableReason }
    : null;
}

export type TranscriptionResponse = Readonly<{ text: string }>;

/** Stable refusal codes of `POST /api/me/transcriptions` besides usage-limit refusals. */
export const TRANSCRIPTION_ERROR_CODES = [
  "unauthorized",
  "multipart_required",
  "audio_required",
  "audio_too_large",
  "audio_type_unsupported",
  "dictation_unavailable",
  "dictation_rate_limited",
  "usage_limits_unavailable",
  "transcription_rejected",
  "transcription_busy",
  "transcription_timed_out",
  "transcription_failed"
] as const;
export type TranscriptionErrorCode = (typeof TRANSCRIPTION_ERROR_CODES)[number];

export function decodeTranscriptionResponse(value: unknown): TranscriptionResponse | null {
  return record(value) && typeof value.text === "string" && value.text.length <= DICTATION_TEXT_MAX_CHARACTERS
    ? { text: value.text }
    : null;
}

export function isTranscriptionErrorCode(value: unknown): value is TranscriptionErrorCode {
  return typeof value === "string" && (TRANSCRIPTION_ERROR_CODES as readonly string[]).includes(value);
}

/* Administrator role */

export const SPEECH_TO_TEXT_PROVIDER_FAMILIES = ["openrouter", "openai", "openai_compatible"] as const;
export type SpeechToTextProviderFamily = (typeof SPEECH_TO_TEXT_PROVIDER_FAMILIES)[number];

export const ADMIN_SPEECH_TO_TEXT_MODEL_LIST_LIMIT = 200;

/** A connection the role can use. `ready` is false without a usable default key. */
export type AdminSpeechToTextConnection = Readonly<{
  displayName: string;
  family: SpeechToTextProviderFamily;
  id: string;
  ready: boolean;
}>;

export type AdminSpeechToTextUnavailableReason =
  /** The connection is gone, turned off or no longer of a supported kind. */
  | "connection_unavailable"
  /** Its default key is missing, turned off or revoked. */
  | "credential_unavailable"
  /** Its default key changed since the passing test. */
  | "verification_required";

export const ADMIN_SPEECH_TO_TEXT_UNAVAILABLE_REASONS: readonly AdminSpeechToTextUnavailableReason[] = [
  "connection_unavailable", "credential_unavailable", "verification_required"
];

export type AdminSpeechToTextAssignment = Readonly<{
  available: boolean;
  /** Null when the connection no longer exists. */
  connectionDisplayName: string | null;
  connectionId: string;
  modelId: string;
  unavailableReason: AdminSpeechToTextUnavailableReason | null;
}>;

export type AdminSpeechToTextRole = Readonly<{
  assignment: AdminSpeechToTextAssignment | null;
  /** The role's last explicit save or clear; sent back as the concurrency fence. */
  configuredAt: string | null;
  connections: readonly AdminSpeechToTextConnection[];
}>;

/** Why Test & save did not save, as content-free evidence. */
export const SPEECH_TO_TEXT_TEST_FAILURES = ["unauthorized", "rejected", "unreachable", "timed_out", "invalid_response"] as const;
export type SpeechToTextTestFailure = (typeof SPEECH_TO_TEXT_TEST_FAILURES)[number];

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function family(value: unknown): value is SpeechToTextProviderFamily {
  return typeof value === "string" && (SPEECH_TO_TEXT_PROVIDER_FAMILIES as readonly string[]).includes(value);
}

function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isSpeechToTextModelId(value: unknown): value is string {
  return boundedText(value, 256) && value.trim() === value;
}

export function decodeAdminSpeechToTextResponse(value: unknown): AdminSpeechToTextRole | null {
  if (!record(value) || !record(value.speechToText)) return null;
  const role = value.speechToText;
  if (!(role.configuredAt === null || instant(role.configuredAt)) || !Array.isArray(role.connections) ||
    role.connections.length > 256) return null;
  const connections: AdminSpeechToTextConnection[] = [];
  for (const entry of role.connections) {
    if (!record(entry) || !boundedText(entry.id, 256) || !boundedText(entry.displayName, 160) ||
      !family(entry.family) || typeof entry.ready !== "boolean") return null;
    connections.push({ displayName: entry.displayName, family: entry.family, id: entry.id, ready: entry.ready });
  }
  const assignment = role.assignment;
  if (assignment !== null) {
    if (!record(assignment) || !boundedText(assignment.connectionId, 256) || !isSpeechToTextModelId(assignment.modelId) ||
      !(assignment.connectionDisplayName === null || boundedText(assignment.connectionDisplayName, 160)) ||
      typeof assignment.available !== "boolean" ||
      (assignment.available ? assignment.unavailableReason !== null
        : !ADMIN_SPEECH_TO_TEXT_UNAVAILABLE_REASONS.includes(assignment.unavailableReason as AdminSpeechToTextUnavailableReason))) return null;
  }
  return {
    assignment: assignment === null ? null : {
      available: assignment.available as boolean,
      connectionDisplayName: assignment.connectionDisplayName as string | null,
      connectionId: assignment.connectionId as string,
      modelId: assignment.modelId as string,
      unavailableReason: assignment.unavailableReason as AdminSpeechToTextUnavailableReason | null
    },
    configuredAt: role.configuredAt as string | null,
    connections
  };
}

export function decodeAdminSpeechToTextModels(value: unknown): string[] | null {
  if (!record(value) || !Array.isArray(value.models) || value.models.length > ADMIN_SPEECH_TO_TEXT_MODEL_LIST_LIMIT ||
    !value.models.every(isSpeechToTextModelId)) return null;
  return [...value.models];
}
