import { memoryActionIntentSourceTextMatchesCurrentUser } from
  "../../../contracts/memoryActionIntent";

export const MEMORY_ACTION_ADMISSION_VERSION =
  "memory-action-admission-v4" as const;

export const MEMORY_ACTION_ADMISSION_STATES = [
  "EXPLICIT_CANDIDATE",
  "SEMANTIC_CANDIDATE",
  "ORDINARY"
] as const;

export type MemoryActionAdmissionState =
  (typeof MEMORY_ACTION_ADMISSION_STATES)[number];

export type MemoryActionAdmission = Readonly<{
  reason: "MEMORY_COMMAND" | "CURRENT_USER_TEXT" | "INPUT_UNSUPPORTED";
  state: MemoryActionAdmissionState;
  version: typeof MEMORY_ACTION_ADMISSION_VERSION;
}>;

/** Bound classifier input without interpreting its language or meaning.
 * Every supported current-user turn reaches the strict semantic decision.
 * Admission grants no action, target, or mutation authority. */
export function admitMemoryAction(text: string): MemoryActionAdmission {
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
