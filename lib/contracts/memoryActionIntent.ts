import { z } from "zod";
import {
  MEMORY_RETRIEVAL_MODES,
  MEMORY_TEMPORAL_INTENTS
} from "./memoryRetrieval";

/** Versioned, provider-neutral output contract for the single Memory control
 * decision made by the installation System Model. Every property is required
 * on the strict JSON-Schema wire and uses null when it is not applicable. */
export const MEMORY_ACTION_INTENT_SCHEMA_VERSION = "memory-action-intent-v7" as const;
export const MEMORY_ACTION_INTENT_NAME = "MemoryActionIntent" as const;
export const MEMORY_ACTION_INTENT_MAX_SYSTEM_MODEL_CALLS = 1 as const;
export const MEMORY_ACTION_INTENT_MAX_TARGET_SELECTION_CALLS = 1 as const;
export const MEMORY_ACTION_INTENT_MAX_TARGET_CALLS =
  MEMORY_ACTION_INTENT_MAX_TARGET_SELECTION_CALLS;
export const MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH = 2_000 as const;
export const MEMORY_ACTION_INTENT_MAX_QUERY_LENGTH = 500 as const;
export const MEMORY_ACTION_INTENT_MAX_REF_LENGTH = 2_048 as const;
export const MEMORY_ACTION_INTENT_MAX_ENTITY_MENTIONS = 8 as const;
export const MEMORY_ACTION_INTENT_MAX_ENTITY_MENTION_LENGTH = 256 as const;
export const MEMORY_ACTION_INTENT_MAX_ENTITY_OCCURRENCE_INDEX = 15 as const;

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
const providerNull = (value: unknown) =>
  typeof value === "string" && value.toLowerCase() === "null" ? null : value;
const nullableTimestamp = z.preprocess(
  providerNull,
  z.string().datetime({ offset: true }).max(64).nullable()
);
const categoryText = z.preprocess(
  providerNull,
  z.enum(MEMORY_ACTION_INTENT_CATEGORIES).nullable()
);
const entityMentionSchema = z.strictObject({
  occurrenceIndex: z.number().int().min(0)
    .max(MEMORY_ACTION_INTENT_MAX_ENTITY_OCCURRENCE_INDEX),
  resolvedRef: nullableText(MEMORY_ACTION_INTENT_MAX_REF_LENGTH),
  text: strictText(MEMORY_ACTION_INTENT_MAX_ENTITY_MENTION_LENGTH)
});

const memoryActionIntentWireSchema = z.strictObject({
  action: z.enum(MEMORY_ACTION_INTENT_ACTIONS),
  applyResponsePreferences: z.boolean(),
  category: categoryText,
  categoryHint: categoryText,
  confidenceBand: z.enum(MEMORY_ACTION_INTENT_CONFIDENCE_BANDS),
  entityMentions: z.array(entityMentionSchema).max(MEMORY_ACTION_INTENT_MAX_ENTITY_MENTIONS),
  includePatterns: z.boolean(),
  memoryUseful: z.boolean(),
  pastChatsUseful: z.boolean(),
  profileRequested: z.boolean(),
  queryText: nullableText(MEMORY_ACTION_INTENT_MAX_QUERY_LENGTH),
  reasonCode: z.enum(MEMORY_ACTION_INTENT_REASON_CODES),
  recencyRequested: z.boolean(),
  retrievalMode: z.enum(MEMORY_RETRIEVAL_MODES),
  referencedMemoryRef: nullableText(MEMORY_ACTION_INTENT_MAX_REF_LENGTH),
  replacementStatement: nullableText(MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH),
  responsePreference: z.boolean(),
  sensitiveDomainHint: nullableText(128),
  sensitivity: z.enum(MEMORY_ACTION_INTENT_SENSITIVITIES),
  statement: nullableText(MEMORY_ACTION_INTENT_MAX_TEXT_LENGTH),
  targetQuery: nullableText(MEMORY_ACTION_INTENT_MAX_QUERY_LENGTH),
  temporalAsOf: nullableTimestamp,
  temporalFrom: nullableTimestamp,
  temporalIntent: z.enum(MEMORY_TEMPORAL_INTENTS),
  temporalTo: nullableTimestamp,
  thisChatOnly: z.boolean()
});

const memoryActionIntentSchema = memoryActionIntentWireSchema.superRefine((value, context) => {
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
  if (dynamicRetrievalRequested && value.queryText === null) {
    context.addIssue({
      code: "custom",
      message: "answer retrieval requires queryText"
    });
  }
  if (value.profileRequested && (
    value.action !== "NONE" || !value.memoryUseful || value.recencyRequested ||
    value.retrievalMode !== "CURRENT_PROFILE" || value.pastChatsUseful
  )) {
    context.addIssue({
      code: "custom",
      message: "profile inventory requires a non-recency NONE answer retrieval"
    });
  }
  if (!value.profileRequested && value.retrievalMode === "CURRENT_PROFILE") {
    context.addIssue({ code: "custom", message: "current profile mode requires profile" });
  }
  if (value.retrievalMode === "HISTORICAL_MEMORY" && (
    !value.memoryUseful || value.pastChatsUseful || value.temporalIntent === "CURRENT"
  )) {
    context.addIssue({ code: "custom", message: "historical mode requires fact history" });
  }
  if ((value.retrievalMode === "PAST_CHAT_SEARCH" ||
      value.retrievalMode === "HISTORY_OVERVIEW") &&
      (!value.pastChatsUseful || value.memoryUseful)) {
    context.addIssue({ code: "custom", message: "chat modes require past chats" });
  }
  if (value.retrievalMode === "PAST_CHAT_SEARCH" &&
    value.temporalIntent === "HISTORICAL") {
    context.addIssue({
      code: "custom",
      message: "past chat search cannot request historical fact states"
    });
  }
  if (value.retrievalMode === "HISTORY_OVERVIEW" && value.recencyRequested) {
    context.addIssue({ code: "custom", message: "history overview cannot request recency" });
  }
  if ((value.retrievalMode === "CURRENT_PROFILE" ||
      value.retrievalMode === "TARGETED_CURRENT") && value.temporalIntent !== "CURRENT") {
    context.addIssue({ code: "custom", message: "current mode requires current time" });
  }
  const timestampShape = value.temporalIntent === "AS_OF"
    ? value.temporalAsOf !== null && value.temporalFrom === null && value.temporalTo === null
    : value.temporalIntent === "BETWEEN"
      ? value.temporalAsOf === null && (value.temporalFrom !== null || value.temporalTo !== null)
      : value.temporalAsOf === null && value.temporalFrom === null && value.temporalTo === null;
  if (!timestampShape || value.temporalFrom !== null && value.temporalTo !== null &&
    new Date(value.temporalFrom) >= new Date(value.temporalTo)) {
    context.addIssue({ code: "custom", message: "temporal request is invalid" });
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
    entityMentions: {
      items: {
        additionalProperties: false,
        properties: {
          occurrenceIndex: {
            maximum: MEMORY_ACTION_INTENT_MAX_ENTITY_OCCURRENCE_INDEX,
            minimum: 0,
            type: "integer"
          },
          resolvedRef: {
            maxLength: MEMORY_ACTION_INTENT_MAX_REF_LENGTH,
            minLength: 1,
            type: ["string", "null"]
          },
          text: {
            maxLength: MEMORY_ACTION_INTENT_MAX_ENTITY_MENTION_LENGTH,
            minLength: 1,
            type: "string"
          }
        },
        required: ["text", "occurrenceIndex", "resolvedRef"],
        type: "object"
      },
      maxItems: MEMORY_ACTION_INTENT_MAX_ENTITY_MENTIONS,
      type: "array"
    },
    includePatterns: { type: "boolean" },
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
    retrievalMode: { enum: [...MEMORY_RETRIEVAL_MODES], type: "string" },
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
    temporalAsOf: { format: "date-time", maxLength: 64, type: ["string", "null"] },
    temporalFrom: { format: "date-time", maxLength: 64, type: ["string", "null"] },
    temporalIntent: {
      description: "Use ANY for a targeted prior-chat or event lookup; HISTORICAL is reserved for earlier states of personal facts.",
      enum: [...MEMORY_TEMPORAL_INTENTS],
      type: "string"
    },
    temporalTo: { format: "date-time", maxLength: 64, type: ["string", "null"] },
    thisChatOnly: { type: "boolean" }
  },
  required: [
    "action",
    "applyResponsePreferences",
    "category",
    "categoryHint",
    "confidenceBand",
    "entityMentions",
    "includePatterns",
    "memoryUseful",
    "pastChatsUseful",
    "profileRequested",
    "queryText",
    "reasonCode",
    "recencyRequested",
    "retrievalMode",
    "referencedMemoryRef",
    "replacementStatement",
    "responsePreference",
    "sensitiveDomainHint",
    "sensitivity",
    "statement",
    "targetQuery",
    "temporalAsOf",
    "temporalFrom",
    "temporalIntent",
    "temporalTo",
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

type MemoryActionIntentWire = z.infer<typeof memoryActionIntentWireSchema>;

function validTemporalShape(value: MemoryActionIntentWire): boolean {
  if (value.temporalIntent === "AS_OF") {
    return value.temporalAsOf !== null && value.temporalFrom === null &&
      value.temporalTo === null;
  }
  if (value.temporalIntent === "BETWEEN") {
    return value.temporalAsOf === null &&
      (value.temporalFrom !== null || value.temporalTo !== null) &&
      !(value.temporalFrom !== null && value.temporalTo !== null &&
        new Date(value.temporalFrom) >= new Date(value.temporalTo));
  }
  return value.temporalAsOf === null && value.temporalFrom === null &&
    value.temporalTo === null;
}

function currentRouting(
  value: MemoryActionIntentWire,
  retrievalMode: "CURRENT_PROFILE" | "TARGETED_CURRENT"
): MemoryActionIntentWire {
  return {
    ...value,
    retrievalMode,
    temporalAsOf: null,
    temporalFrom: null,
    temporalIntent: "CURRENT",
    temporalTo: null
  };
}

/**
 * Strict-output providers guarantee the wire shape, but cannot express every
 * cross-field refinement in their portable JSON-Schema subset. Repair only
 * read-only routing fields, and only from already-affirmative retrieval flags.
 * Mutation, confidence, sensitivity, statement, target, and query fields are
 * never inferred here, so this fallback cannot mint new mutation authority.
 */
function normalizeSafeMemoryRouting(
  value: MemoryActionIntentWire
): MemoryActionIntentWire {
  if (value.action === "LIST" || value.action === "SEARCH") return value;
  if (value.action !== "NONE" && value.queryText === null) {
    return currentRouting({
      ...value,
      applyResponsePreferences: false,
      memoryUseful: false,
      pastChatsUseful: false,
      profileRequested: false,
      recencyRequested: false
    }, "TARGETED_CURRENT");
  }
  if (value.profileRequested) {
    return value.action === "NONE" && value.memoryUseful && !value.pastChatsUseful &&
      !value.recencyRequested
      ? currentRouting(value, "CURRENT_PROFILE")
      : value;
  }

  const facts = value.memoryUseful;
  const history = value.pastChatsUseful;
  const preferences = value.applyResponsePreferences;
  if (!facts && history) {
    const overview = value.retrievalMode === "HISTORY_OVERVIEW" &&
      !value.recencyRequested;
    if (!validTemporalShape(value) || value.temporalIntent === "HISTORICAL") {
      return {
        ...value,
        retrievalMode: overview ? "HISTORY_OVERVIEW" : "PAST_CHAT_SEARCH",
        temporalAsOf: null,
        temporalFrom: null,
        temporalIntent: "ANY",
        temporalTo: null
      };
    }
    return {
      ...value,
      retrievalMode: overview ? "HISTORY_OVERVIEW" : "PAST_CHAT_SEARCH"
    };
  }
  if (facts && !history && value.retrievalMode === "HISTORICAL_MEMORY" &&
    value.temporalIntent !== "CURRENT") {
    return value;
  }
  if (facts || history || preferences) {
    return currentRouting(value, "TARGETED_CURRENT");
  }
  return currentRouting(value, "TARGETED_CURRENT");
}

/** Remove fields that cannot affect the selected action. This is a
 * canonicalization only: mutation statements and target selectors required by
 * the chosen action are never repaired, inferred, or replaced. */
function normalizeUnusedActionPayload(
  value: MemoryActionIntentWire
): MemoryActionIntentWire {
  if (value.action === "RESET") return value;
  if (value.action === "SAVE") {
    return {
      ...value,
      referencedMemoryRef: null,
      replacementStatement: null,
      targetQuery: null
    };
  }
  if (value.action === "UPDATE") return { ...value, statement: null };
  if (value.action === "FORGET") {
    return { ...value, replacementStatement: null, statement: null };
  }
  if (value.action === "SEARCH") {
    return {
      ...value,
      referencedMemoryRef: null,
      replacementStatement: null,
      statement: null,
      thisChatOnly: false
    };
  }
  return {
    ...value,
    referencedMemoryRef: null,
    replacementStatement: null,
    statement: null,
    targetQuery: null,
    thisChatOnly: false
  };
}

function normalizeSafePlannerHints(value: MemoryActionIntentWire): MemoryActionIntentWire {
  const retrievalRequested = value.memoryUseful || value.pastChatsUseful ||
    value.applyResponsePreferences || value.profileRequested;
  const hintsAllowed = retrievalRequested && value.queryText !== null;
  return {
    ...value,
    entityMentions: hintsAllowed ? value.entityMentions : [],
    includePatterns: hintsAllowed && value.memoryUseful && !value.profileRequested &&
      value.retrievalMode === "TARGETED_CURRENT" && value.temporalIntent === "CURRENT"
      ? value.includePatterns
      : false
  };
}

export function decodeMemoryActionIntent(value: unknown): MemoryActionIntentDecodeResult {
  const wire = memoryActionIntentWireSchema.safeParse(value);
  if (!wire.success) return { code: "memory_action_intent_invalid", ok: false };
  const actionPayload = normalizeUnusedActionPayload(wire.data);
  const direct = memoryActionIntentSchema.safeParse(actionPayload);
  const routed = direct.success
    ? actionPayload
    : normalizeSafeMemoryRouting(actionPayload);
  const result = memoryActionIntentSchema.safeParse(normalizeSafePlannerHints(routed));
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
