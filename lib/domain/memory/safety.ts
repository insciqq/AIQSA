import type { MemorySensitivityClass } from "../../contracts/memory";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memory";

export type MemoryEpisodicRecallDecision =
  | "ALLOW_GENERIC"
  | "ALLOW_EXACT_MATCH_ONLY"
  | "DENY";

export function memoryAutomaticPromotionAllowed(sensitivity: MemorySensitivityClass): boolean {
  return sensitivity === "NORMAL";
}

export function memoryDerivativePlaintextAllowed(
  sensitivity: MemorySensitivityClass,
  secretTaintedSourceWindow: boolean
): boolean {
  return !secretTaintedSourceWindow && sensitivity !== "SECRET";
}

export function memoryEpisodicRecallDecision(
  sensitivity: MemorySensitivityClass,
  exactCurrentUserQuery: boolean,
  acceptedSensitivePolicy: boolean
): MemoryEpisodicRecallDecision {
  if (sensitivity === "SECRET" || sensitivity === "HIGHLY_SENSITIVE") return "DENY";
  if (sensitivity === "NORMAL") return "ALLOW_GENERIC";
  return exactCurrentUserQuery && acceptedSensitivePolicy ? "ALLOW_EXACT_MATCH_ONLY" : "DENY";
}

export const MEMORY_MUTATION_INTENT_ORIGINS = [
  "DIRECT_UI",
  "DIRECT_API",
  "CURRENT_USER_EXACT_SPAN",
  "MODEL_PROPOSAL",
  "BACKGROUND_INFERENCE"
] as const;

export type MemoryMutationIntentOrigin = (typeof MEMORY_MUTATION_INTENT_ORIGINS)[number];
export type MemoryMutationIntentAction = "SAVE" | "EDIT" | "MOVE_SCOPE" | "FORGET" | "BULK_DELETE";

export type MemoryMutationIntent = Readonly<{
  action: MemoryMutationIntentAction;
  confirmationCopyVersion: string | null;
  exactCurrentUserSpan: boolean;
  exactTarget: boolean;
  expectedVersion: boolean;
  explicitConfirmation: boolean;
  origin: MemoryMutationIntentOrigin;
}>;

export function memoryMutationIntentAllowed(intent: MemoryMutationIntent): boolean {
  if (intent.origin === "MODEL_PROPOSAL" || intent.origin === "BACKGROUND_INFERENCE") return false;
  if (!intent.explicitConfirmation || intent.confirmationCopyVersion !== MEMORY_CONFIRMATION_COPY_VERSION) {
    return false;
  }
  if (intent.action === "SAVE") {
    return intent.exactCurrentUserSpan && !intent.exactTarget && !intent.expectedVersion;
  }
  if (intent.action === "BULK_DELETE") {
    return intent.exactTarget && !intent.expectedVersion;
  }
  return intent.exactTarget && intent.expectedVersion;
}
