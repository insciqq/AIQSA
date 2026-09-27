import {
  MEMORY_ACTION_INTENT_MAX_SOURCE_TEXT_LENGTH,
  memoryActionIntentSourceTextMatchesCurrentUser
} from "../../../contracts/memoryActionIntent";

export const MEMORY_ACTION_ADMISSION_VERSION =
  "memory-action-admission-v5" as const;

export const MEMORY_ACTION_ADMISSION_STATES = [
  "EXPLICIT_CANDIDATE",
  "SEMANTIC_CANDIDATE",
  "INPUT_TOO_LONG",
  "ORDINARY"
] as const;

export type MemoryActionAdmissionState =
  (typeof MEMORY_ACTION_ADMISSION_STATES)[number];

export type MemoryActionAdmission = Readonly<{
  reason: "MEMORY_COMMAND" | "CURRENT_USER_TEXT" | "INPUT_TOO_LONG" | "INPUT_UNSUPPORTED";
  state: MemoryActionAdmissionState;
  version: typeof MEMORY_ACTION_ADMISSION_VERSION;
}>;

/** Bound classifier input without interpreting its language or meaning.
 * Every supported current-user turn reaches the strict semantic decision,
 * including a directive after the statement bound. A turn beyond the source
 * budget is reported as too long instead of being classified from a prefix or
 * silently treated as ordinary text. Admission grants no action, target, or
 * mutation authority. */
export function admitMemoryAction(
  text: string,
  options: Readonly<{ sourceTooLong?: boolean }> = {}
): MemoryActionAdmission {
  if (options.sourceTooLong === true ||
    text.length > MEMORY_ACTION_INTENT_MAX_SOURCE_TEXT_LENGTH) {
    return Object.freeze({
      reason: "INPUT_TOO_LONG",
      state: "INPUT_TOO_LONG",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
  }
  if (!text.trim() || !memoryActionIntentSourceTextMatchesCurrentUser(text, text)) {
    return Object.freeze({
      reason: "INPUT_UNSUPPORTED",
      state: "ORDINARY",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
  }
  const explicitCommand = /^\/memory(?:\s|$)/iu.test(text.trimStart());
  return Object.freeze({
    reason: explicitCommand ? "MEMORY_COMMAND" : "CURRENT_USER_TEXT",
    state: explicitCommand ? "EXPLICIT_CANDIDATE" : "SEMANTIC_CANDIDATE",
    version: MEMORY_ACTION_ADMISSION_VERSION
  });
}

/** Whether the admitted turn may reach the one Memory control decision. */
export function memoryActionControlAdmitted(
  admission: MemoryActionAdmission,
  deterministicRead: boolean
): boolean {
  if (admission.state === "INPUT_TOO_LONG") return false;
  return !deterministicRead || admission.state !== "ORDINARY";
}
