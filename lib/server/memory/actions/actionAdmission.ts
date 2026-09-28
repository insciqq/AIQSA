import {
  MEMORY_ACTION_INTENT_MAX_SOURCE_TEXT_LENGTH,
  memoryActionIntentSourceTextMatchesCurrentUser
} from "../../../contracts/memoryActionIntent";

export const MEMORY_ACTION_ADMISSION_VERSION =
  "memory-action-admission-v6" as const;

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

/** The literal protocol boundary is independent of classifier input limits. */
export function hasExplicitMemoryCommandBoundary(text: string): boolean {
  return /^\/memory(?:\s|$)/iu.test(text.trimStart());
}

/** Bound classifier input without interpreting its language or meaning.
 * A supported current-user turn is a semantic candidate, including a
 * directive after the statement bound. A qualified optional screen may
 * confidently rule out a command before strict classification. A turn beyond
 * the source budget is reported as too long instead of using a prefix or
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
  const explicitCommand = hasExplicitMemoryCommandBoundary(text);
  return Object.freeze({
    reason: explicitCommand ? "MEMORY_COMMAND" : "CURRENT_USER_TEXT",
    state: explicitCommand ? "EXPLICIT_CANDIDATE" : "SEMANTIC_CANDIDATE",
    version: MEMORY_ACTION_ADMISSION_VERSION
  });
}

/** Synchronous control belongs to the explicit protocol boundary. Ordinary
 * natural-language commands are classified by the durable command worker;
 * reads do not wait for their classification or mutation. The legacy policy
 * remains available only for already accepted execution compatibility. */
export function memoryActionControlAdmitted(
  admission: MemoryActionAdmission,
  deterministicRead: boolean
): boolean {
  if (admission.state === "INPUT_TOO_LONG") return false;
  return !deterministicRead || admission.state === "EXPLICIT_CANDIDATE";
}
