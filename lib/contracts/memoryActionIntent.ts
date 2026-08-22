import { z } from "zod";

/** Versioned, provider-neutral output contract for the single Memory control
 * decision made by the installation System Model. Every property is required
 * on the strict JSON-Schema wire and uses null when it is not applicable. */
export const MEMORY_ACTION_INTENT_SCHEMA_VERSION = "memory-action-intent-v2" as const;
export const MEMORY_ACTION_INTENT_NAME = "MemoryActionIntent" as const;
export const MEMORY_ACTION_INTENT_MAX_SYSTEM_MODEL_CALLS = 1 as const;
export const MEMORY_ACTION_INTENT_MAX_TARGET_SELECTION_CALLS = 1 as const;
export const MEMORY_ACTION_INTENT_MAX_TARGET_CALLS =
  MEMORY_ACTION_INTENT_MAX_TARGET_SELECTION_CALLS;
export const MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH = 2_000 as const;
export const MEMORY_ACTION_INTENT_MAX_QUERY_LENGTH = 500 as const;
export const MEMORY_ACTION_INTENT_MAX_REF_LENGTH = 2_048 as const;

export const MEMORY_ACTION_INTENT_ACTIONS = [
  "NONE",
  "SAVE",
  "UPDATE",
  "FORGET",
  "LIST",
  "SEARCH",
  "RESET"
] as const;
export type MemoryActionIntentAction = (typeof MEMORY_ACTION_INTENT_ACTIONS)[number];

export const MEMORY_ACTION_INTENT_CONFIDENCE_BANDS = ["HIGH", "MEDIUM", "LOW"] as const;
export type MemoryActionIntentConfidenceBand =
  (typeof MEMORY_ACTION_INTENT_CONFIDENCE_BANDS)[number];

export const MEMORY_ACTION_INTENT_SENSITIVITIES = [
  "NORMAL",
  "SENSITIVE",
  "SECRET",
  "UNCERTAIN"
] as const;
export type MemoryActionIntentSensitivity =
  (typeof MEMORY_ACTION_INTENT_SENSITIVITIES)[number];

export const MEMORY_ACTION_INTENT_CATEGORIES = [
  "about_you",
  "preferences",
  "work",
  "goals",
  "constraints_routines",
  "other",
  "sensitive"
] as const;
export type MemoryActionIntentCategory =
  (typeof MEMORY_ACTION_INTENT_CATEGORIES)[number];

/**
 * Reason codes are deliberately short and bounded. They are internal model
 * explanations, not consumer-facing copy or mutation authority.
 */
export const MEMORY_ACTION_INTENT_REASON_CODES = [
  "none",
  "no_memory_request",
  "save_request",
  "update_request",
  "forget_request",
  "list_request",
  "search_request",
  "reset_request",
  "low_confidence",
  "sensitive_content",
  "secret_content",
  "target_ambiguous",
  "this_chat_only",
  "past_chats_request",
  "response_preference",
  "unsupported",
  "uncertain"
] as const;
export type MemoryActionIntentReasonCode =
  (typeof MEMORY_ACTION_INTENT_REASON_CODES)[number];

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasUnsafeSourceControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f) return true;
  }
  return false;
}

function strictText(maxLength: number) {
  return z.string().min(1).max(maxLength)
    .refine((value) => value.trim() === value, "text must be trimmed")
    .refine((value) => !hasControlCharacter(value), "text contains a control character");
}

const nullableText = (maxLength: number) => strictText(maxLength).nullable();
const categoryText = z.enum(MEMORY_ACTION_INTENT_CATEGORIES).nullable();

const memoryActionIntentSchema = z.strictObject({
  action: z.enum(MEMORY_ACTION_INTENT_ACTIONS),
  applyResponsePreferences: z.boolean(),
  category: categoryText,
  categoryHint: categoryText,
  confidenceBand: z.enum(MEMORY_ACTION_INTENT_CONFIDENCE_BANDS),
  memoryUseful: z.boolean(),
  pastChatsUseful: z.boolean(),
  profileRequested: z.boolean(),
  queryText: nullableText(MEMORY_ACTION_INTENT_MAX_QUERY_LENGTH),
  reasonCode: z.enum(MEMORY_ACTION_INTENT_REASON_CODES),
  recencyRequested: z.boolean(),
  referencedMemoryRef: nullableText(MEMORY_ACTION_INTENT_MAX_REF_LENGTH),
  replacementStatement: nullableText(MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH),
  responsePreference: z.boolean(),
  sensitiveDomainHint: nullableText(128),
  sensitivity: z.enum(MEMORY_ACTION_INTENT_SENSITIVITIES),
  statement: nullableText(MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH),
  targetQuery: nullableText(MEMORY_ACTION_INTENT_MAX_QUERY_LENGTH),
  thisChatOnly: z.boolean()
}).superRefine((value, context) => {
  if (value.action === "SAVE" && value.statement === null) {
    context.addIssue({ code: "custom", message: "SAVE requires statement" });
  }
  if (value.action === "UPDATE" && value.replacementStatement === null) {
    context.addIssue({ code: "custom", message: "UPDATE requires replacementStatement" });
  }
  if (value.action === "SEARCH" && value.targetQuery === null) {
    context.addIssue({ code: "custom", message: "SEARCH requires targetQuery" });
  }
  const dynamicRetrievalRequested = value.memoryUseful || value.pastChatsUseful ||
    value.applyResponsePreferences || value.profileRequested;
  if ((value.action === "LIST" || value.action === "SEARCH") && (
    dynamicRetrievalRequested || value.queryText !== null
  )) {
    context.addIssue({
      code: "custom",
      message: "LIST and SEARCH cannot request answer retrieval"
    });
  }
  if (value.action === "NONE" && dynamicRetrievalRequested && value.queryText === null) {
    context.addIssue({
      code: "custom",
      message: "NONE answer retrieval requires queryText"
    });
  }
  if (value.profileRequested && (
    value.action !== "NONE" || !value.memoryUseful || value.recencyRequested
  )) {
    context.addIssue({
      code: "custom",
      message: "profile inventory requires a non-recency NONE answer retrieval"
    });
  }
  if (value.responsePreference && value.category !== "preferences" && !(
    value.sensitivity === "SENSITIVE" && value.category === "sensitive"
  )) {
    context.addIssue({
      code: "custom",
      message: "responsePreference requires a preferences category"
    });
  }
  if (value.action === "RESET" && (
    value.statement !== null || value.replacementStatement !== null ||
    value.targetQuery !== null || value.referencedMemoryRef !== null ||
    value.thisChatOnly
  )) {
    context.addIssue({ code: "custom", message: "RESET cannot carry a target or statement" });
  }
});

export type MemoryActionIntent = z.infer<typeof memoryActionIntentSchema>;

/** Strict JSON Schema sent to the provider adapter. Keep all fields required;
 * nullable values represent "not applicable" so providers cannot omit a
 * control field under a permissive interpretation of the schema. */
export const MEMORY_ACTION_INTENT_JSON_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    action: {
      description: "Use NONE for ordinary answers, including a broad personal-profile inventory. LIST is only explicit Saved Memories management, never an answer about what is known about the user.",
      enum: [...MEMORY_ACTION_INTENT_ACTIONS],
      type: "string"
    },
    applyResponsePreferences: { type: "boolean" },
    category: {
      enum: [...MEMORY_ACTION_INTENT_CATEGORIES, null],
      type: ["string", "null"]
    },
    categoryHint: {
      enum: [...MEMORY_ACTION_INTENT_CATEGORIES, null],
      type: ["string", "null"]
    },
    confidenceBand: { enum: [...MEMORY_ACTION_INTENT_CONFIDENCE_BANDS], type: "string" },
    memoryUseful: { type: "boolean" },
    pastChatsUseful: { type: "boolean" },
    profileRequested: {
      description: "True only for a broad answer summarizing everything Personal Memory knows about the user; it requires action NONE, memoryUseful true, and recencyRequested false.",
      type: "boolean"
    },
    queryText: {
      description: "A concise non-null semantic query whenever a NONE answer enables any retrieval control, including profileRequested.",
      maxLength: MEMORY_ACTION_INTENT_MAX_QUERY_LENGTH,
      minLength: 1,
      type: ["string", "null"]
    },
    reasonCode: { enum: [...MEMORY_ACTION_INTENT_REASON_CODES], type: "string" },
    recencyRequested: { type: "boolean" },
    referencedMemoryRef: {
      maxLength: MEMORY_ACTION_INTENT_MAX_REF_LENGTH,
      minLength: 1,
      type: ["string", "null"]
    },
    replacementStatement: {
      maxLength: MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH,
      minLength: 1,
      type: ["string", "null"]
    },
    responsePreference: { type: "boolean" },
    sensitiveDomainHint: { maxLength: 128, minLength: 1, type: ["string", "null"] },
    sensitivity: { enum: [...MEMORY_ACTION_INTENT_SENSITIVITIES], type: "string" },
    statement: {
      maxLength: MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH,
      minLength: 1,
      type: ["string", "null"]
    },
    targetQuery: {
      maxLength: MEMORY_ACTION_INTENT_MAX_QUERY_LENGTH,
      minLength: 1,
      type: ["string", "null"]
    },
    thisChatOnly: { type: "boolean" }
  },
  required: [
    "action",
    "applyResponsePreferences",
    "category",
    "categoryHint",
    "confidenceBand",
    "memoryUseful",
    "pastChatsUseful",
    "profileRequested",
    "queryText",
    "reasonCode",
    "recencyRequested",
    "referencedMemoryRef",
    "replacementStatement",
    "responsePreference",
    "sensitiveDomainHint",
    "sensitivity",
    "statement",
    "targetQuery",
    "thisChatOnly"
  ],
  type: "object"
} as const);

/** Compatibility aliases make the provider-facing schema discoverable under
 * either the contract or JSON-Schema naming used by callers. */
export const MEMORY_ACTION_INTENT_SCHEMA = MEMORY_ACTION_INTENT_JSON_SCHEMA;
export const memoryActionIntentJsonSchema = MEMORY_ACTION_INTENT_JSON_SCHEMA;
export const memoryActionIntentContractSchema = MEMORY_ACTION_INTENT_JSON_SCHEMA;

export type MemoryActionIntentDecodeResult =
  | Readonly<{ ok: true; value: MemoryActionIntent }>
  | Readonly<{ code: "memory_action_intent_invalid"; ok: false }>;

export function decodeMemoryActionIntent(value: unknown): MemoryActionIntentDecodeResult {
  const result = memoryActionIntentSchema.safeParse(value);
  if (!result.success) return { code: "memory_action_intent_invalid", ok: false };
  const intent = result.data;
  const ordinaryCategoryHint = intent.categoryHint === "sensitive"
    ? "about_you"
    : intent.categoryHint;
  const ordinaryCategory = intent.responsePreference
    ? "preferences"
    : intent.category === "sensitive"
      ? ordinaryCategoryHint ?? "about_you"
      : intent.category;
  return {
    ok: true,
    value: {
      ...intent,
      category: ordinaryCategory,
      categoryHint: ordinaryCategoryHint,
      sensitivity: intent.sensitivity === "SENSITIVE" ? "NORMAL" : intent.sensitivity
    }
  };
}

/** Mutation actions require evidence from the exact current direct-user turn.
 * This helper is intentionally byte-for-byte and does not interpret language. */
export function memoryActionIntentSourceTextMatchesCurrentUser(
  sourceText: unknown,
  currentUserText: unknown
): sourceText is string {
  return typeof sourceText === "string" && typeof currentUserText === "string" &&
    sourceText.length > 0 && sourceText.length <= MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH &&
    currentUserText.length > 0 && currentUserText.length <= MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH &&
    !hasUnsafeSourceControlCharacter(sourceText) &&
    !hasUnsafeSourceControlCharacter(currentUserText) &&
    sourceText === currentUserText;
}

export function memoryActionIntentRequiresCurrentUserEvidence(
  action: MemoryActionIntentAction
): boolean {
  return action === "SAVE" || action === "UPDATE" || action === "FORGET";
}

/** Server-side gate used before minting any mutation authorization. The
 * classifier may suggest an action, but only an exact current direct-user
 * source can authorize a reusable mutation. */
export function memoryActionIntentCurrentTurnAuthorizesMutation(
  intent: Pick<MemoryActionIntent, "action">,
  sourceText: unknown,
  currentUserText: unknown
): boolean {
  return !memoryActionIntentRequiresCurrentUserEvidence(intent.action) ||
    memoryActionIntentSourceTextMatchesCurrentUser(sourceText, currentUserText);
}

export function memoryActionIntentNeedsTargetSelection(
  intent: Pick<MemoryActionIntent, "action" | "referencedMemoryRef" | "targetQuery">
): boolean {
  return (intent.action === "UPDATE" || intent.action === "FORGET") &&
    intent.referencedMemoryRef === null && intent.targetQuery !== null;
}

/** Returns false once the one permitted ambiguity-resolution call has been
 * consumed. The caller must still authorize the selected target/version. */
export function memoryActionIntentTargetSelectionCallAllowed(
  action: MemoryActionIntentAction,
  callsAlreadyMade: number
): boolean {
  return (action === "UPDATE" || action === "FORGET") &&
    Number.isSafeInteger(callsAlreadyMade) &&
    callsAlreadyMade >= 0 &&
    callsAlreadyMade < MEMORY_ACTION_INTENT_MAX_TARGET_SELECTION_CALLS;
}

export { memoryActionIntentSchema };
