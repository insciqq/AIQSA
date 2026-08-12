import { z } from "zod";

export const MEMORY_CONFIRMATION_COPY_VERSION = "memory-confirmation-v1" as const;
export const MEMORY_TEMPORARY_RETENTION_POLICY_VERSION = "temporary-24h-v1" as const;
export const MEMORY_STATEMENT_MAX_LENGTH = 2_000;
export const MEMORY_QUERY_MAX_LENGTH = 500;
export const MEMORY_CURSOR_MAX_LENGTH = 2_048;
export const MEMORY_PAGE_SIZE_MAX = 20;
export const MEMORY_RECEIPT_ITEM_TEXT_MAX_LENGTH = 4_000;
export const MEMORY_SEARCH_SNIPPET_MAX_LENGTH = 1_000;
export const MEMORY_FEEDBACK_COMMENT_MAX_LENGTH = 1_000;
export const MEMORY_FORGET_UNDO_WINDOW_MS = 60_000;

export const MEMORY_UI_LOCALES = ["RU", "EN"] as const;
export type MemoryUiLocale = (typeof MEMORY_UI_LOCALES)[number];

export const MEMORY_CHAT_MODES = ["NORMAL", "EXCLUDED", "TEMPORARY"] as const;
export type MemoryChatMode = (typeof MEMORY_CHAT_MODES)[number];

export const MEMORY_EGRESS_CONSENT_MODES = ["ADMIN", "PER_USER"] as const;
export type MemoryEgressConsentMode = (typeof MEMORY_EGRESS_CONSENT_MODES)[number];

export const MEMORY_SCOPE_TYPES = ["GLOBAL_USER", "FOLDER", "ASSISTANT", "CHAT"] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export const MEMORY_SCOPE_STATES = ["ACTIVE", "ORPHANED", "RETRACTED"] as const;
export type MemoryScopeState = (typeof MEMORY_SCOPE_STATES)[number];

export const MEMORY_CANDIDATE_STATES = [
  "PENDING",
  "DEFERRED",
  "PROMOTED",
  "REJECTED",
  "STALE"
] as const;
export type MemoryCandidateState = (typeof MEMORY_CANDIDATE_STATES)[number];

export const MEMORY_FACT_STATES = [
  "ACTIVE",
  "CONFLICTED",
  "ORPHANED",
  "EXPIRED",
  "RETRACTED",
  "FORGOTTEN"
] as const;
export type MemoryFactState = (typeof MEMORY_FACT_STATES)[number];

export const MEMORY_FACT_VERSION_STATES = [
  "ACTIVE",
  "CONFLICTING",
  "ORPHANED",
  "SUPERSEDED",
  "EXPIRED",
  "RETRACTED",
  "FORGOTTEN"
] as const;
export type MemoryFactVersionState = (typeof MEMORY_FACT_VERSION_STATES)[number];

export const MEMORY_SOURCE_MODES = ["EXPLICIT", "AUTOMATIC"] as const;
export type MemorySourceMode = (typeof MEMORY_SOURCE_MODES)[number];

export const MEMORY_FEEDBACK_TYPES = [
  "CORRECT",
  "INCORRECT",
  "NOT_USEFUL",
  "WRONG_SCOPE",
  "OUTDATED",
  "TOO_SENSITIVE",
  "RETRACT"
] as const;
export type MemoryFeedbackType = (typeof MEMORY_FEEDBACK_TYPES)[number];

export const MEMORY_MODALITIES = [
  "STATE",
  "PREFERENCE",
  "CONSTRAINT",
  "CONSIDERATION",
  "INTENTION",
  "PLAN",
  "EVENT",
  "HABIT",
  "WORKFLOW"
] as const;
export type MemoryModality = (typeof MEMORY_MODALITIES)[number];

export const MEMORY_SENSITIVITY_CLASSES = [
  "NORMAL",
  "SENSITIVE",
  "HIGHLY_SENSITIVE",
  "SECRET"
] as const;
export type MemorySensitivityClass = (typeof MEMORY_SENSITIVITY_CLASSES)[number];

export const MEMORY_JOB_STATES = [
  "QUEUED",
  "CLAIMED",
  "WAITING_FOR_EGRESS_CONSENT",
  "SUCCEEDED",
  "RETRYABLE_FAILED",
  "TERMINAL_FAILED",
  "STALE",
  "CANCELLED"
] as const;
export type MemoryJobState = (typeof MEMORY_JOB_STATES)[number];

export const MEMORY_RETRIEVAL_ATTEMPT_STATES = [
  "PENDING",
  "EXECUTING",
  "READY",
  "CONSUMED",
  "STALE",
  "FAILED",
  "CANCELLED",
  "EXPIRED"
] as const;
export type MemoryRetrievalAttemptState = (typeof MEMORY_RETRIEVAL_ATTEMPT_STATES)[number];

export const MEMORY_EXECUTION_STATES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "OUTCOME_UNKNOWN"
] as const;
export type MemoryExecutionState = (typeof MEMORY_EXECUTION_STATES)[number];

export const MEMORY_INDEX_GENERATION_STATES = [
  "BUILDING",
  "CATCHING_UP",
  "READY",
  "ACTIVE",
  "SUPERSEDED",
  "FAILED",
  "CANCELLED"
] as const;
export type MemoryIndexGenerationState = (typeof MEMORY_INDEX_GENERATION_STATES)[number];

export const MEMORY_DELETION_STATES = [
  "PENDING",
  "RUNNING",
  "RETRY_WAIT",
  "BLOCKED_REQUIRES_ADMIN",
  "SUCCEEDED",
  "CANCELLED"
] as const;
export type MemoryDeletionState = (typeof MEMORY_DELETION_STATES)[number];

export const MEMORY_BULK_DELETE_OPERATIONS = [
  "DELETE_EXPLICIT",
  "DELETE_LEARNED",
  "CLEAR_HISTORY_INDEX",
  "DELETE_ALL_REUSABLE"
] as const;
export type MemoryBulkDeleteOperation = (typeof MEMORY_BULK_DELETE_OPERATIONS)[number];

export const MEMORY_REBUILD_OPERATIONS = [
  "REBUILD_SEARCH_INDEX",
  "REEMBED",
  "REDREAM_EXISTING_CHATS"
] as const;
export type MemoryRebuildOperation = (typeof MEMORY_REBUILD_OPERATIONS)[number];

export const MEMORY_CONFIRMABLE_BULK_OPERATIONS = [
  ...MEMORY_BULK_DELETE_OPERATIONS,
  "REDREAM_EXISTING_CHATS"
] as const;

export const MEMORY_REBUILD_STATES = [
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_EGRESS_CONSENT",
  "CATCHING_UP",
  "READY",
  "SUCCEEDED",
  "FAILED",
  "STALE",
  "CANCELLED"
] as const;
export type MemoryRebuildState = (typeof MEMORY_REBUILD_STATES)[number];

export const MEMORY_ITEM_INDEXING_STATES = [
  "LEXICAL_READY",
  "VECTOR_PENDING",
  "HYBRID_READY",
  "DEGRADED"
] as const;
export type MemoryItemIndexingState = (typeof MEMORY_ITEM_INDEXING_STATES)[number];

export const MEMORY_HISTORY_LEXICAL_STATES = [
  "READY",
  "DISABLED",
  "UNAVAILABLE"
] as const;
export type MemoryHistoryLexicalState =
  (typeof MEMORY_HISTORY_LEXICAL_STATES)[number];

export const MEMORY_HISTORY_VECTOR_STATES = [
  "READY",
  "DISABLED",
  "NOT_CONFIGURED",
  "DEGRADED"
] as const;
export type MemoryHistoryVectorState =
  (typeof MEMORY_HISTORY_VECTOR_STATES)[number];

export const MEMORY_HISTORY_DEGRADATION_CODES = [
  "memory_index_unavailable",
  "memory_vector_generation_stale",
  "memory_vector_profile_unsupported",
  "memory_vector_unavailable"
] as const;
export type MemoryHistoryDegradationCode =
  (typeof MEMORY_HISTORY_DEGRADATION_CODES)[number];

export const MEMORY_RECEIPT_OUTCOMES = [
  "USED",
  "EMPTY",
  "DISABLED",
  "DEGRADED",
  "FAILED_SAFE"
] as const;
export type MemoryReceiptOutcome = (typeof MEMORY_RECEIPT_OUTCOMES)[number];

export const MEMORY_RECEIPT_ITEM_TYPES = [
  "FACT_VERSION",
  "EPISODE",
  "RECALL_CHUNK",
  "PROFILE"
] as const;
export type MemoryReceiptItemType = (typeof MEMORY_RECEIPT_ITEM_TYPES)[number];

export const MEMORY_RECEIPT_LIFECYCLE_STATES = [
  "CURRENT",
  "LATER_FORGOTTEN",
  "SOURCE_DELETED"
] as const;
export type MemoryReceiptLifecycleState = (typeof MEMORY_RECEIPT_LIFECYCLE_STATES)[number];

export const MEMORY_ACTION_FEEDBACK_OPERATIONS = [
  "SAVE",
  "UPDATE",
  "FORGET",
  "MARK_INCORRECT"
] as const;
export type MemoryActionFeedbackOperation =
  (typeof MEMORY_ACTION_FEEDBACK_OPERATIONS)[number];

export const MEMORY_ERROR_CODES = [
  "memory_contract_invalid",
  "memory_not_enabled",
  "memory_not_found",
  "memory_target_unavailable",
  "memory_target_ambiguous",
  "memory_version_stale",
  "memory_scope_invalid",
  "memory_scope_unavailable",
  "memory_statement_invalid",
  "memory_secret_rejected",
  "memory_sensitive_requires_explicit",
  "memory_temporary_chat_forbidden",
  "memory_temporary_chat_expired",
  "memory_temporary_policy_review_required",
  "memory_generation_changed",
  "memory_source_stale",
  "memory_index_unavailable",
  "memory_embedding_unavailable",
  "memory_model_unavailable",
  "memory_rebuild_in_progress",
  "memory_rebuild_not_found",
  "memory_action_failed",
  "memory_intent_confirmation_required",
  "memory_undo_unavailable",
  "memory_egress_consent_required",
  "memory_egress_admin_owned",
  "memory_purge_blocked_requires_admin"
] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export type MemoryContractDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ code: "memory_contract_invalid"; ok: false }>;

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = safeInteger.min(1);
const idSchema = z.string().trim().min(1).max(256).refine(
  (value) => !/[\u0000-\u0020\u007f]/u.test(value),
  "invalid opaque id"
);
const cursorSchema = z.string().min(1).max(MEMORY_CURSOR_MAX_LENGTH).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  "invalid opaque cursor"
).nullable();
const hashSchema = z.string().trim().min(16).max(512).refine(
  (value) => !/[\u0000-\u0020\u007f]/u.test(value),
  "invalid hash"
);
const utilityEgressFingerprintSchema = z.string().trim().min(16).max(128).refine(
  (value) => !/[\u0000-\u0020\u007f]/u.test(value),
  "invalid utility egress fingerprint"
);
const utilityPolicyVersionSchema = z.string().trim().min(1).max(64).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
  "invalid utility policy version"
);
const safeText = (maxLength: number) => z.string().min(1).max(maxLength)
  .refine((value) => value.trim().length > 0, "text is blank")
  .refine((value) => !/\u0000/u.test(value), "text contains a null byte");
const memoryStatementSchema = safeText(MEMORY_STATEMENT_MAX_LENGTH);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u, "invalid SHA-256 hash");
const isoTimestampSchema = z.string().max(64).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}, "invalid ISO timestamp");
const nullableTimestampSchema = isoTimestampSchema.nullable();
const categorySchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u);
const preferredLanguageSchema = z.union([
  z.literal("AUTO"),
  z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u)
]);

const memoryScopeSelectionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("GLOBAL_USER") }),
  z.strictObject({ targetId: idSchema, type: z.literal("FOLDER") }),
  z.strictObject({ targetId: idSchema, type: z.literal("ASSISTANT") }),
  z.strictObject({ targetId: idSchema, type: z.literal("CHAT") })
]);

export type MemoryScopeSelection = z.infer<typeof memoryScopeSelectionSchema>;

function decode<T>(schema: z.ZodType<T>, value: unknown): MemoryContractDecodeResult<T> {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { code: "memory_contract_invalid", ok: false };
}

export function decodeMemoryScopeSelection(
  value: unknown
): MemoryContractDecodeResult<MemoryScopeSelection> {
  return decode(memoryScopeSelectionSchema, value);
}

const memorySettingsPatchSchema = z.strictObject({
  embeddingDeploymentId: idSchema.nullable().optional(),
  expectedMemoryRevision: safeInteger.optional(),
  expectedSettingsRevision: safeInteger,
  learnAutomatically: z.boolean().optional(),
  memoryUiLocale: z.enum(MEMORY_UI_LOCALES).optional(),
  preferredProfileLanguage: preferredLanguageSchema.optional(),
  referenceChatHistory: z.boolean().optional(),
  sensitiveAutomaticPolicy: z.literal("EXPLICIT_ONLY").optional(),
  useMemoryFacts: z.boolean().optional()
}).superRefine((value, context) => {
  const mutationKeys = [
    "embeddingDeploymentId",
    "learnAutomatically",
    "memoryUiLocale",
    "preferredProfileLanguage",
    "referenceChatHistory",
    "sensitiveAutomaticPolicy",
    "useMemoryFacts"
  ] as const;
  const changed = mutationKeys.filter((key) => Object.hasOwn(value, key));
  if (changed.length === 0) {
    context.addIssue({ code: "custom", message: "empty settings patch" });
  }
  const memoryVisible = changed.some((key) => key !== "memoryUiLocale");
  if (memoryVisible && value.expectedMemoryRevision === undefined) {
    context.addIssue({ code: "custom", message: "memory-visible patch requires revision" });
  }
  if (!memoryVisible && value.expectedMemoryRevision !== undefined) {
    context.addIssue({ code: "custom", message: "locale-only patch must not claim a memory revision" });
  }
});

export type MemorySettingsPatch = z.infer<typeof memorySettingsPatchSchema>;

export function decodeMemorySettingsPatch(
  value: unknown
): MemoryContractDecodeResult<MemorySettingsPatch> {
  return decode(memorySettingsPatchSchema, value);
}

const memoryConsentInputSchema = z.strictObject({
  confirmationCopyVersion: z.literal(MEMORY_CONFIRMATION_COPY_VERSION),
  currentUtilityEgressFingerprint: utilityEgressFingerprintSchema,
  currentUtilityPolicyVersion: utilityPolicyVersionSchema,
  expectedMemoryConsentRevision: safeInteger,
  expectedMemoryRevision: safeInteger,
  expectedSettingsRevision: safeInteger
});

export type MemoryConsentInput = z.infer<typeof memoryConsentInputSchema>;

export function decodeMemoryConsentInput(
  value: unknown
): MemoryContractDecodeResult<MemoryConsentInput> {
  return decode(memoryConsentInputSchema, value);
}

export type MemorySettingsMutation =
  | Readonly<{ kind: "accept_utility_egress"; value: MemoryConsentInput }>
  | Readonly<{ kind: "patch"; value: MemorySettingsPatch }>;

export function decodeMemorySettingsMutation(
  value: unknown
): MemoryContractDecodeResult<MemorySettingsMutation> {
  const patch = memorySettingsPatchSchema.safeParse(value);
  const consent = memoryConsentInputSchema.safeParse(value);
  if (patch.success && !consent.success) {
    return { ok: true, value: { kind: "patch", value: patch.data } };
  }
  if (consent.success && !patch.success) {
    return {
      ok: true,
      value: { kind: "accept_utility_egress", value: consent.data }
    };
  }
  return { code: "memory_contract_invalid", ok: false };
}

const mutationAuthorizationCommonSchema = z.strictObject({
  confirmationCopyVersion: z.literal(MEMORY_CONFIRMATION_COPY_VERSION),
  requestNonce: idSchema
});

const memoryMutationAuthorizationInputSchema = z.discriminatedUnion("action", [
  mutationAuthorizationCommonSchema.extend({
    action: z.literal("SAVE"),
    exactStatementHash: sha256HexSchema
  }),
  mutationAuthorizationCommonSchema.extend({
    action: z.literal("EDIT"),
    expectedTargetVersionId: idSchema,
    targetFactId: idSchema
  }),
  mutationAuthorizationCommonSchema.extend({
    action: z.literal("MOVE_SCOPE"),
    expectedTargetVersionId: idSchema,
    targetFactId: idSchema
  }),
  mutationAuthorizationCommonSchema.extend({
    action: z.literal("FORGET"),
    expectedTargetVersionId: idSchema,
    targetFactId: idSchema
  }),
  mutationAuthorizationCommonSchema.extend({
    action: z.literal("BULK_DELETE"),
    expectedMemoryRevision: safeInteger,
    expectedSettingsRevision: safeInteger,
    operation: z.enum(MEMORY_CONFIRMABLE_BULK_OPERATIONS)
  })
]);

export type MemoryMutationAuthorizationInput = z.infer<
  typeof memoryMutationAuthorizationInputSchema
>;

export function decodeMemoryMutationAuthorizationInput(
  value: unknown
): MemoryContractDecodeResult<MemoryMutationAuthorizationInput> {
  return decode(memoryMutationAuthorizationInputSchema, value);
}

const memoryMutationAuthorizationResponseSchema = z.strictObject({
  expiresAt: isoTimestampSchema,
  mutationAuthorizationId: idSchema
});

export type MemoryMutationAuthorizationResponse = z.infer<
  typeof memoryMutationAuthorizationResponseSchema
>;

export function decodeMemoryMutationAuthorizationResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryMutationAuthorizationResponse> {
  return decode(memoryMutationAuthorizationResponseSchema, value);
}

const memoryCreateInputSchema = z.strictObject({
  category: categorySchema.nullable().optional(),
  modality: z.enum(MEMORY_MODALITIES).nullable().optional(),
  mutationAuthorizationId: idSchema,
  scope: memoryScopeSelectionSchema,
  statement: memoryStatementSchema,
  validFrom: nullableTimestampSchema.optional(),
  validTo: nullableTimestampSchema.optional()
}).superRefine((value, context) => {
  if (value.validFrom && value.validTo && Date.parse(value.validFrom) >= Date.parse(value.validTo)) {
    context.addIssue({ code: "custom", message: "valid interval must be half-open and non-empty" });
  }
});

export type MemoryCreateInput = z.infer<typeof memoryCreateInputSchema>;

export function decodeMemoryCreateInput(
  value: unknown
): MemoryContractDecodeResult<MemoryCreateInput> {
  return decode(memoryCreateInputSchema, value);
}

const memoryListSearchInputSchema = z.strictObject({
  cursor: cursorSchema.optional(),
  pageSize: positiveInteger.max(MEMORY_PAGE_SIZE_MAX).optional(),
  query: safeText(MEMORY_QUERY_MAX_LENGTH),
  scope: memoryScopeSelectionSchema.optional(),
  sourceMode: z.enum(MEMORY_SOURCE_MODES).optional(),
  state: z.enum(MEMORY_FACT_STATES).optional()
});

const memoryListInputSchema = z.strictObject({
  cursor: cursorSchema.optional(),
  pageSize: positiveInteger.max(MEMORY_PAGE_SIZE_MAX).optional(),
  scope: memoryScopeSelectionSchema.optional(),
  sourceMode: z.enum(MEMORY_SOURCE_MODES).optional(),
  state: z.enum(MEMORY_FACT_STATES).optional()
});

export type MemoryListInput = z.infer<typeof memoryListInputSchema>;

export function decodeMemoryListInput(
  value: unknown
): MemoryContractDecodeResult<MemoryListInput> {
  return decode(memoryListInputSchema, value);
}

export type MemoryListSearchInput = z.infer<typeof memoryListSearchInputSchema>;

export function decodeMemoryListSearchInput(
  value: unknown
): MemoryContractDecodeResult<MemoryListSearchInput> {
  return decode(memoryListSearchInputSchema, value);
}

const memoryUpdateInputSchema = z.strictObject({
  category: categorySchema.optional(),
  expectedVersionId: idSchema,
  modality: z.enum(MEMORY_MODALITIES).optional(),
  mutationAuthorizationId: idSchema,
  pinned: z.boolean().optional(),
  scope: memoryScopeSelectionSchema.optional(),
  statement: memoryStatementSchema.optional(),
  validFrom: nullableTimestampSchema.optional(),
  validTo: nullableTimestampSchema.optional()
}).superRefine((value, context) => {
  const patchKeys = ["category", "modality", "pinned", "scope", "statement", "validFrom", "validTo"] as const;
  if (!patchKeys.some((key) => Object.hasOwn(value, key))) {
    context.addIssue({ code: "custom", message: "empty memory patch" });
  }
  if (value.validFrom && value.validTo && Date.parse(value.validFrom) >= Date.parse(value.validTo)) {
    context.addIssue({ code: "custom", message: "valid interval must be half-open and non-empty" });
  }
});

export type MemoryUpdateInput = z.infer<typeof memoryUpdateInputSchema>;

export function decodeMemoryUpdateInput(
  value: unknown
): MemoryContractDecodeResult<MemoryUpdateInput> {
  return decode(memoryUpdateInputSchema, value);
}

const memoryForgetInputSchema = z.strictObject({
  expectedVersionId: idSchema,
  mutationAuthorizationId: idSchema
});

export type MemoryForgetInput = z.infer<typeof memoryForgetInputSchema>;

export function decodeMemoryForgetInput(
  value: unknown
): MemoryContractDecodeResult<MemoryForgetInput> {
  return decode(memoryForgetInputSchema, value);
}

const memoryUndoForgetInputSchema = z.strictObject({
  deletionId: idSchema,
  mutationAuthorizationId: idSchema
});

export type MemoryUndoForgetInput = z.infer<typeof memoryUndoForgetInputSchema>;

export function decodeMemoryUndoForgetInput(
  value: unknown
): MemoryContractDecodeResult<MemoryUndoForgetInput> {
  return decode(memoryUndoForgetInputSchema, value);
}

const memoryBulkDeleteInputSchema = z.strictObject({
  expectedMemoryRevision: safeInteger,
  expectedSettingsRevision: safeInteger,
  mutationAuthorizationId: idSchema,
  operation: z.enum(MEMORY_BULK_DELETE_OPERATIONS)
});

export type MemoryBulkDeleteInput = z.infer<typeof memoryBulkDeleteInputSchema>;

export function decodeMemoryBulkDeleteInput(
  value: unknown
): MemoryContractDecodeResult<MemoryBulkDeleteInput> {
  return decode(memoryBulkDeleteInputSchema, value);
}

const memoryHistorySearchInputSchema = z.strictObject({
  chatIds: z.array(idSchema).max(20).refine(
    (values) => new Set(values).size === values.length,
    "duplicate chat id"
  ),
  cursor: cursorSchema,
  folderId: idSchema.nullable(),
  from: nullableTimestampSchema,
  pageSize: positiveInteger.max(MEMORY_PAGE_SIZE_MAX),
  query: safeText(MEMORY_QUERY_MAX_LENGTH),
  to: nullableTimestampSchema
}).superRefine((value, context) => {
  if (value.from && value.to && Date.parse(value.from) >= Date.parse(value.to)) {
    context.addIssue({ code: "custom", message: "history interval must be half-open and non-empty" });
  }
});

export type MemoryHistorySearchInput = z.infer<typeof memoryHistorySearchInputSchema>;

export function decodeMemoryHistorySearchInput(
  value: unknown
): MemoryContractDecodeResult<MemoryHistorySearchInput> {
  return decode(memoryHistorySearchInputSchema, value);
}

const memoryRebuildInputSchema = z.strictObject({
  embeddingDeploymentId: idSchema.nullable().optional(),
  expectedMemoryRevision: safeInteger,
  expectedSettingsRevision: safeInteger,
  mutationAuthorizationId: idSchema.optional(),
  operation: z.enum(MEMORY_REBUILD_OPERATIONS)
}).superRefine((value, context) => {
  if (value.operation === "REEMBED" && !value.embeddingDeploymentId) {
    context.addIssue({ code: "custom", message: "re-embedding requires a deployment" });
  }
  if (value.operation === "REDREAM_EXISTING_CHATS" && !value.mutationAuthorizationId) {
    context.addIssue({ code: "custom", message: "redream requires explicit authorization" });
  }
  if (value.operation !== "REDREAM_EXISTING_CHATS" && value.mutationAuthorizationId) {
    context.addIssue({ code: "custom", message: "authorization is valid only for redream" });
  }
  if (value.operation !== "REEMBED" && Object.hasOwn(value, "embeddingDeploymentId")) {
    context.addIssue({ code: "custom", message: "deployment is valid only for re-embedding" });
  }
});

export type MemoryRebuildInput = z.infer<typeof memoryRebuildInputSchema>;

export function decodeMemoryRebuildInput(
  value: unknown
): MemoryContractDecodeResult<MemoryRebuildInput> {
  return decode(memoryRebuildInputSchema, value);
}

const memoryChatModePatchSchema = z.strictObject({
  expectedChatRevision: safeInteger,
  expectedMemoryRevision: safeInteger,
  mode: z.enum(["NORMAL", "EXCLUDED"]),
  resumeDisclosureCopyVersion: z.literal(MEMORY_CONFIRMATION_COPY_VERSION).optional()
}).superRefine((value, context) => {
  if (value.mode === "NORMAL" && !value.resumeDisclosureCopyVersion) {
    context.addIssue({ code: "custom", message: "resume requires current disclosure" });
  }
  if (value.mode === "EXCLUDED" && value.resumeDisclosureCopyVersion) {
    context.addIssue({ code: "custom", message: "exclude does not accept resume disclosure" });
  }
});

export type MemoryChatModePatch = z.infer<typeof memoryChatModePatchSchema>;

export function decodeMemoryChatModePatch(
  value: unknown
): MemoryContractDecodeResult<MemoryChatModePatch> {
  return decode(memoryChatModePatchSchema, value);
}

const memoryInitialChatModeSchema = z.discriminatedUnion("chatMode", [
  z.strictObject({ chatMode: z.literal("NORMAL") }),
  z.strictObject({
    chatMode: z.literal("TEMPORARY"),
    temporaryRetentionPolicyVersion: z.literal(MEMORY_TEMPORARY_RETENTION_POLICY_VERSION)
  })
]);

export type MemoryInitialChatMode = z.infer<typeof memoryInitialChatModeSchema>;

export function decodeMemoryInitialChatMode(
  value: unknown
): MemoryContractDecodeResult<MemoryInitialChatMode> {
  return decode(memoryInitialChatModeSchema, value);
}

const memorySettingsResponseSchema = z.strictObject({
  capabilities: z.strictObject({
    automaticLearning: z.boolean(),
    explicitMemory: z.boolean(),
    historyRecall: z.boolean(),
    permanentChatDeletion: z.boolean(),
    russianQualified: z.boolean(),
    temporaryChats: z.boolean()
  }),
  egress: z.strictObject({
    acceptedAt: nullableTimestampSchema,
    acceptedUtilityEgressFingerprint: utilityEgressFingerprintSchema.nullable(),
    acceptedUtilityPolicyVersion: utilityPolicyVersionSchema.nullable(),
    consentMode: z.enum(MEMORY_EGRESS_CONSENT_MODES),
    currentUtilityEgressFingerprint: utilityEgressFingerprintSchema,
    currentUtilityPolicyVersion: utilityPolicyVersionSchema,
    embeddingDestination: safeText(256).nullable(),
    remoteRerankerDestination: safeText(256).nullable(),
    reviewRequired: z.boolean(),
    systemModelDestination: safeText(256).nullable()
  }),
  historyIndexing: z.strictObject({
    completedChats: safeInteger,
    state: z.enum(["DISABLED", "INDEXING", "READY"]),
    totalChats: safeInteger
  }),
  settings: z.strictObject({
    embeddingDeployment: z.strictObject({
      connectionDisplayName: safeText(128),
      id: idSchema,
      modelDisplayName: safeText(128)
    }).nullable(),
    learnAutomatically: z.boolean(),
    memoryConsentRevision: safeInteger,
    memoryGeneration: safeInteger,
    memoryRevision: safeInteger,
    memoryUiLocale: z.enum(MEMORY_UI_LOCALES),
    preferredProfileLanguage: preferredLanguageSchema,
    referenceChatHistory: z.boolean(),
    sensitiveAutomaticPolicy: z.literal("EXPLICIT_ONLY"),
    settingsRevision: safeInteger,
    updatedAt: isoTimestampSchema,
    useMemoryFacts: z.boolean()
  })
}).superRefine((value, context) => {
  const accepted = value.egress.acceptedUtilityEgressFingerprint;
  const acceptedPolicy = value.egress.acceptedUtilityPolicyVersion;
  const acceptedAt = value.egress.acceptedAt;
  if (
    (accepted === null) !== (acceptedPolicy === null) ||
    (accepted === null) !== (acceptedAt === null)
  ) {
    context.addIssue({ code: "custom", message: "accepted egress evidence is all-or-none" });
  }
  const reviewRequired = value.egress.consentMode === "PER_USER" && (
    accepted === null ||
    accepted !== value.egress.currentUtilityEgressFingerprint ||
    acceptedPolicy !== value.egress.currentUtilityPolicyVersion
  );
  if (value.egress.reviewRequired !== reviewRequired) {
    context.addIssue({ code: "custom", message: "utility egress review state mismatch" });
  }
  if (value.historyIndexing.completedChats > value.historyIndexing.totalChats) {
    context.addIssue({ code: "custom", message: "history indexing progress exceeds total" });
  }
  const expectedHistoryState = !value.settings.referenceChatHistory
    ? "DISABLED"
    : value.historyIndexing.completedChats < value.historyIndexing.totalChats
      ? "INDEXING"
      : "READY";
  if (value.historyIndexing.state !== expectedHistoryState) {
    context.addIssue({ code: "custom", message: "history indexing state mismatch" });
  }
});

export type MemorySettingsResponse = z.infer<typeof memorySettingsResponseSchema>;

export function decodeMemorySettingsResponse(
  value: unknown
): MemoryContractDecodeResult<MemorySettingsResponse> {
  return decode(memorySettingsResponseSchema, value);
}

const memorySummarySchema = z.strictObject({
  actionVersionId: idSchema.nullable().optional(),
  category: categorySchema,
  createdAt: isoTimestampSchema,
  currentVersionId: idSchema.nullable(),
  deferredCandidateCount: safeInteger.optional(),
  displayText: safeText(MEMORY_STATEMENT_MAX_LENGTH).nullable(),
  factState: z.enum(MEMORY_FACT_STATES),
  id: idSchema,
  indexingState: z.enum(MEMORY_ITEM_INDEXING_STATES),
  lastConfirmedAt: nullableTimestampSchema,
  lastUsedAt: nullableTimestampSchema,
  modality: z.enum(MEMORY_MODALITIES),
  pinned: z.boolean(),
  scope: memoryScopeSelectionSchema,
  sensitivityClass: z.enum(MEMORY_SENSITIVITY_CLASSES),
  sourceCount: safeInteger,
  sourceMode: z.enum(MEMORY_SOURCE_MODES),
  updatedAt: isoTimestampSchema,
  validFrom: nullableTimestampSchema,
  validTo: nullableTimestampSchema,
  versionState: z.enum(MEMORY_FACT_VERSION_STATES)
}).superRefine((value, context) => {
  const expectedVersionState: Record<MemoryFactState, MemoryFactVersionState> = {
    ACTIVE: "ACTIVE",
    CONFLICTED: "CONFLICTING",
    EXPIRED: "EXPIRED",
    FORGOTTEN: "FORGOTTEN",
    ORPHANED: "ORPHANED",
    RETRACTED: "RETRACTED"
  };
  if (value.versionState !== expectedVersionState[value.factState]) {
    context.addIssue({ code: "custom", message: "fact/version state mismatch" });
  }
  if (value.factState === "ACTIVE") {
    if (value.currentVersionId === null || value.displayText === null) {
      context.addIssue({ code: "custom", message: "active fact requires current visible version" });
    }
    if (value.actionVersionId !== undefined && value.actionVersionId !== value.currentVersionId) {
      context.addIssue({ code: "custom", message: "active action version must be current" });
    }
  } else if (value.currentVersionId !== null) {
    context.addIssue({ code: "custom", message: "non-active fact cannot have a current version" });
  }
  if ((value.factState === "ORPHANED" || value.factState === "CONFLICTED") &&
    !value.actionVersionId) {
    context.addIssue({ code: "custom", message: "reviewable fact requires an exact action version" });
  }
  if (
    value.factState !== "ACTIVE" &&
    value.factState !== "ORPHANED" &&
    value.factState !== "CONFLICTED" &&
    value.actionVersionId != null
  ) {
    context.addIssue({ code: "custom", message: "inactive fact cannot expose an action version" });
  }
  if (value.validFrom && value.validTo && Date.parse(value.validFrom) >= Date.parse(value.validTo)) {
    context.addIssue({ code: "custom", message: "invalid fact validity interval" });
  }
});

export type MemorySummary = z.infer<typeof memorySummarySchema>;

export const MEMORY_PROFILE_VIEW_STATES = [
  "DISABLED",
  "EMPTY",
  "PENDING",
  "WAITING_FOR_EGRESS_CONSENT",
  "READY",
  "UNAVAILABLE"
] as const;
export type MemoryProfileViewState = (typeof MEMORY_PROFILE_VIEW_STATES)[number];

const memoryProfileContributorSchema = z.strictObject({
  displayText: safeText(500),
  factId: idSchema,
  factVersionId: idSchema,
  ordinal: z.number().int().min(0).max(5),
  pinned: z.boolean(),
  sourceMode: z.enum(MEMORY_SOURCE_MODES),
  temperatureClass: z.enum(["HOT", "WARM", "COLD"])
});

export type MemoryProfileContributor = z.infer<typeof memoryProfileContributorSchema>;

const memoryProfileProjectionSchema = z.strictObject({
  asOf: isoTimestampSchema,
  contributors: z.array(memoryProfileContributorSchema).min(1).max(6),
  createdAt: isoTimestampSchema,
  id: idSchema,
  languageCode: z.enum(["ru", "en"]),
  memoryRevision: safeInteger,
  redactionState: z.enum(["NOT_NEEDED", "REDACTED"]),
  summary: safeText(4_000)
}).superRefine((value, context) => {
  const expected = value.contributors.map(({ displayText }) => displayText).join("\n");
  if (expected !== value.summary) {
    context.addIssue({ code: "custom", message: "profile summary is not contributor-exact" });
  }
  if (value.contributors.some((item, ordinal) => item.ordinal !== ordinal)) {
    context.addIssue({ code: "custom", message: "profile contributor order is not contiguous" });
  }
});

export type MemoryProfileProjection = z.infer<typeof memoryProfileProjectionSchema>;

const memoryProfileResponseSchema = z.strictObject({
  memoryRevision: safeInteger,
  profile: memoryProfileProjectionSchema.nullable(),
  state: z.enum(MEMORY_PROFILE_VIEW_STATES)
}).superRefine((value, context) => {
  if ((value.state === "READY") !== (value.profile !== null)) {
    context.addIssue({ code: "custom", message: "profile readiness mismatch" });
  }
  if (value.profile && value.profile.memoryRevision > value.memoryRevision) {
    context.addIssue({ code: "custom", message: "profile revision is from the future" });
  }
});

export type MemoryProfileResponse = z.infer<typeof memoryProfileResponseSchema>;

export function decodeMemoryProfileResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryProfileResponse> {
  return decode(memoryProfileResponseSchema, value);
}

const memoryListResponseSchema = z.strictObject({
  memories: z.array(memorySummarySchema).max(100),
  nextCursor: cursorSchema
});

export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;

export function decodeMemoryListResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryListResponse> {
  return decode(memoryListResponseSchema, value);
}

const memoryMutationResponseSchema = z.strictObject({ memory: memorySummarySchema });
export type MemoryMutationResponse = z.infer<typeof memoryMutationResponseSchema>;

export function decodeMemoryMutationResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryMutationResponse> {
  return decode(memoryMutationResponseSchema, value);
}

const memoryForgetUndoDescriptorSchema = z.strictObject({
  deletionId: idSchema,
  expiresAt: isoTimestampSchema,
  versionId: idSchema
});

export type MemoryForgetUndoDescriptor = z.infer<
  typeof memoryForgetUndoDescriptorSchema
>;

const memoryForgetResponseSchema = z.strictObject({
  memory: memorySummarySchema,
  undo: memoryForgetUndoDescriptorSchema
});

export type MemoryForgetResponse = z.infer<typeof memoryForgetResponseSchema>;

export function decodeMemoryForgetResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryForgetResponse> {
  return decode(memoryForgetResponseSchema, value);
}

const memoryVersionHistoryItemSchema = z.strictObject({
  category: categorySchema,
  createdAt: isoTimestampSchema,
  displayText: safeText(MEMORY_STATEMENT_MAX_LENGTH).nullable(),
  id: idSchema,
  modality: z.enum(MEMORY_MODALITIES),
  sensitivityClass: z.enum(MEMORY_SENSITIVITY_CLASSES),
  sourceCount: safeInteger,
  sourceMode: z.enum(MEMORY_SOURCE_MODES),
  state: z.enum(MEMORY_FACT_VERSION_STATES),
  systemFrom: isoTimestampSchema,
  systemTo: nullableTimestampSchema,
  validFrom: nullableTimestampSchema,
  validTo: nullableTimestampSchema
}).superRefine((value, context) => {
  if (value.systemTo && Date.parse(value.systemTo) <= Date.parse(value.systemFrom)) {
    context.addIssue({ code: "custom", message: "invalid system interval" });
  }
  if (value.validFrom && value.validTo && Date.parse(value.validTo) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: "custom", message: "invalid valid interval" });
  }
});

export type MemoryVersionHistoryItem = z.infer<typeof memoryVersionHistoryItemSchema>;

const memoryLifecycleHistoryItemSchema = z.strictObject({
  actorType: z.enum(["USER", "SYSTEM", "JOB"]),
  createdAt: isoTimestampSchema,
  factVersionId: idSchema.nullable(),
  id: idSchema,
  operation: z.enum([
    "EXPLICIT_SAVE",
    "AUTO_PROPOSE",
    "PROMOTE",
    "REINFORCE",
    "EDIT",
    "SUPERSEDE",
    "CONFLICT",
    "EXPIRE",
    "RETRACT",
    "FORGET",
    "SOURCE_INVALIDATE",
    "SCOPE_CHANGE",
    "PIN",
    "UNPIN",
    "USER_FEEDBACK",
    "INDEX_SWITCH",
    "REBUILD"
  ]),
  sourceAvailable: z.boolean()
});

export type MemoryLifecycleHistoryItem = z.infer<typeof memoryLifecycleHistoryItemSchema>;

const memoryFeedbackRecordSchema = z.strictObject({
  comment: safeText(MEMORY_FEEDBACK_COMMENT_MAX_LENGTH).nullable(),
  createdAt: isoTimestampSchema,
  feedbackType: z.enum(MEMORY_FEEDBACK_TYPES).exclude(["RETRACT"]),
  id: idSchema,
  retractedAt: nullableTimestampSchema,
  targetVersionId: idSchema
});

export type MemoryFeedbackRecord = z.infer<typeof memoryFeedbackRecordSchema>;

const memoryDetailResponseSchema = z.strictObject({
  feedback: z.array(memoryFeedbackRecordSchema).max(MEMORY_PAGE_SIZE_MAX),
  history: z.array(memoryLifecycleHistoryItemSchema).max(50),
  memory: memorySummarySchema,
  versions: z.array(memoryVersionHistoryItemSchema).max(50)
}).superRefine((value, context) => {
  const versionIds = new Set(value.versions.map(({ id }) => id));
  if (value.memory.actionVersionId && !versionIds.has(value.memory.actionVersionId)) {
    context.addIssue({ code: "custom", message: "action version missing from detail" });
  }
  for (const feedback of value.feedback) {
    if (!versionIds.has(feedback.targetVersionId)) {
      context.addIssue({ code: "custom", message: "feedback target missing from detail" });
    }
  }
  if (value.memory.factState === "FORGOTTEN" && (
    value.feedback.length > 0 || value.versions.some(({ displayText }) => displayText !== null)
  )) {
    context.addIssue({ code: "custom", message: "forgotten detail must redact private content" });
  }
});

export type MemoryDetailResponse = z.infer<typeof memoryDetailResponseSchema>;

export function decodeMemoryDetailResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryDetailResponse> {
  return decode(memoryDetailResponseSchema, value);
}

const memoryFeedbackInputSchema = z.strictObject({
  comment: safeText(MEMORY_FEEDBACK_COMMENT_MAX_LENGTH).optional(),
  expectedVersionId: idSchema,
  feedbackType: z.enum(MEMORY_FEEDBACK_TYPES),
  modelRunId: idSchema.optional(),
  modelRunMemoryItemId: idSchema.optional(),
  modelRunToolCallId: idSchema.optional(),
  requestId: idSchema,
  retractsFeedbackId: idSchema.optional()
}).superRefine((value, context) => {
  const provenanceTargets = Number(value.modelRunMemoryItemId !== undefined) +
    Number(value.modelRunToolCallId !== undefined);
  if ((value.modelRunId === undefined && provenanceTargets !== 0) ||
    (value.modelRunId !== undefined && provenanceTargets !== 1)) {
    context.addIssue({ code: "custom", message: "run feedback provenance is invalid" });
  }
  if (value.feedbackType === "RETRACT") {
    if (!value.retractsFeedbackId || value.comment !== undefined) {
      context.addIssue({ code: "custom", message: "retraction requires only its target" });
    }
  } else if (value.retractsFeedbackId) {
    context.addIssue({ code: "custom", message: "only retraction names prior feedback" });
  }
});

export type MemoryFeedbackInput = z.infer<typeof memoryFeedbackInputSchema>;

export function decodeMemoryFeedbackInput(
  value: unknown
): MemoryContractDecodeResult<MemoryFeedbackInput> {
  return decode(memoryFeedbackInputSchema, value);
}

const memoryFeedbackMutationResponseSchema = z.strictObject({
  createdAt: isoTimestampSchema,
  feedbackId: idSchema,
  feedbackType: z.enum(MEMORY_FEEDBACK_TYPES),
  retractedFeedbackId: idSchema.nullable(),
  targetVersionId: idSchema
}).superRefine((value, context) => {
  if ((value.feedbackType === "RETRACT") !== (value.retractedFeedbackId !== null)) {
    context.addIssue({ code: "custom", message: "feedback retraction result is inconsistent" });
  }
});

export type MemoryFeedbackMutationResponse = z.infer<
  typeof memoryFeedbackMutationResponseSchema
>;

export function decodeMemoryFeedbackMutationResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryFeedbackMutationResponse> {
  return decode(memoryFeedbackMutationResponseSchema, value);
}

const memoryConflictResolutionInputSchema = z.strictObject({
  expectedVersionIds: z.array(idSchema).min(2).max(20).refine(
    (values) => new Set(values).size === values.length,
    "duplicate conflict version"
  ).refine(
    (values) => values.every((value, index) => index === 0 || values[index - 1]! < value),
    "conflict versions must be sorted"
  ),
  mutationAuthorizationId: idSchema,
  resolution: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("CHOOSE"), versionId: idSchema }),
    z.strictObject({ kind: z.literal("CORRECT"), statement: memoryStatementSchema })
  ])
}).superRefine((value, context) => {
  if (value.resolution.kind === "CHOOSE" &&
    !value.expectedVersionIds.includes(value.resolution.versionId)) {
    context.addIssue({ code: "custom", message: "chosen version is outside conflict snapshot" });
  }
});

export type MemoryConflictResolutionInput = z.infer<
  typeof memoryConflictResolutionInputSchema
>;

export function decodeMemoryConflictResolutionInput(
  value: unknown
): MemoryContractDecodeResult<MemoryConflictResolutionInput> {
  return decode(memoryConflictResolutionInputSchema, value);
}

const memoryEvidenceItemSchema = z.strictObject({
  factVersionId: idSchema,
  id: idSchema,
  observedAt: isoTimestampSchema,
  safeExcerpt: safeText(MEMORY_STATEMENT_MAX_LENGTH),
  safetyClass: z.enum(MEMORY_SENSITIVITY_CLASSES),
  sourceChatId: idSchema.nullable(),
  sourceMessageId: idSchema.nullable(),
  sourceRole: z.string().trim().min(1).max(32).nullable(),
  sourceType: z.enum(["MESSAGE", "EXPLICIT_ACTION", "EPISODE"]),
  stance: z.enum(["SUPPORTS", "CONTRADICTS"])
}).superRefine((value, context) => {
  if (
    value.sourceType === "EXPLICIT_ACTION" &&
    (value.sourceChatId !== null ||
      value.sourceMessageId !== null ||
      value.sourceRole !== null)
  ) {
    context.addIssue({ code: "custom", message: "explicit evidence has no source message" });
  }
  if (
    value.sourceType === "MESSAGE" &&
    (value.sourceChatId === null ||
      value.sourceMessageId === null ||
      value.sourceRole === null)
  ) {
    context.addIssue({ code: "custom", message: "message evidence requires source metadata" });
  }
});

export type MemoryEvidenceItem = z.infer<typeof memoryEvidenceItemSchema>;

const memoryEvidenceResponseSchema = z.strictObject({
  evidence: z.array(memoryEvidenceItemSchema).max(MEMORY_PAGE_SIZE_MAX),
  nextCursor: cursorSchema
});

export type MemoryEvidenceResponse = z.infer<typeof memoryEvidenceResponseSchema>;

export function decodeMemoryEvidenceResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryEvidenceResponse> {
  return decode(memoryEvidenceResponseSchema, value);
}

const memoryDeletionStatusSchema = z.strictObject({
  completedUnits: safeInteger,
  deletionId: idSchema,
  lastAuditAt: nullableTimestampSchema,
  memoryGeneration: safeInteger,
  memoryRevision: safeInteger,
  operation: z.enum(MEMORY_BULK_DELETE_OPERATIONS),
  settingsRevision: safeInteger,
  state: z.enum(MEMORY_DELETION_STATES),
  totalUnits: safeInteger.nullable(),
  updatedAt: isoTimestampSchema
}).superRefine((value, context) => {
  if (value.totalUnits !== null && value.completedUnits > value.totalUnits) {
    context.addIssue({ code: "custom", message: "deletion progress exceeds total" });
  }
  if (value.state === "SUCCEEDED" && value.lastAuditAt === null) {
    context.addIssue({ code: "custom", message: "completed deletion requires audit evidence" });
  }
});

export type MemoryDeletionStatus = z.infer<typeof memoryDeletionStatusSchema>;

export function decodeMemoryDeletionStatus(
  value: unknown
): MemoryContractDecodeResult<MemoryDeletionStatus> {
  return decode(memoryDeletionStatusSchema, value);
}

const memoryReceiptItemSchema = z.strictObject({
  factId: idSchema.nullable().optional(),
  feedbackState: z.enum(["AVAILABLE", "RECORDED", "UNAVAILABLE"]).optional(),
  includedText: safeText(MEMORY_RECEIPT_ITEM_TEXT_MAX_LENGTH),
  itemType: z.enum(MEMORY_RECEIPT_ITEM_TYPES),
  lifecycleState: z.enum(MEMORY_RECEIPT_LIFECYCLE_STATES),
  ordinal: safeInteger,
  scopeType: z.enum(MEMORY_SCOPE_TYPES).nullable(),
  selectionReason: z.string().trim().min(1).max(128),
  sourceChatId: idSchema.nullable(),
  sourceMessageIds: z.array(idSchema).max(50),
  sourceMode: z.enum(["EXPLICIT", "AUTOMATIC", "HISTORY", "PROFILE"]),
  runItemId: idSchema.nullable().optional(),
  runId: idSchema.nullable().optional(),
  versionId: idSchema.nullable()
}).superRefine((value, context) => {
  if (value.lifecycleState === "SOURCE_DELETED" && value.sourceChatId !== null) {
    context.addIssue({ code: "custom", message: "deleted source cannot retain a live link" });
  }
  if (value.itemType === "FACT_VERSION" && value.versionId === null) {
    context.addIssue({ code: "custom", message: "fact receipt requires a frozen version id" });
  }
  if (value.itemType === "FACT_VERSION" && value.factId === null) {
    context.addIssue({ code: "custom", message: "fact receipt cannot carry a null fact id" });
  }
  if (value.itemType !== "FACT_VERSION" && value.factId != null) {
    context.addIssue({ code: "custom", message: "non-fact receipt cannot carry a fact id" });
  }
  if (value.feedbackState !== undefined && (value.runItemId == null || value.runId == null)) {
    context.addIssue({ code: "custom", message: "feedback state requires run provenance" });
  }
});

export type MemoryReceiptItem = z.infer<typeof memoryReceiptItemSchema>;

const memoryReceiptSchema = z.strictObject({
  degradationCode: z.string().trim().min(1).max(128).nullable(),
  itemCount: safeInteger,
  items: z.array(memoryReceiptItemSchema).max(50),
  outcome: z.enum(MEMORY_RECEIPT_OUTCOMES),
  summary: safeText(500)
}).superRefine((value, context) => {
  if (value.itemCount !== value.items.length) {
    context.addIssue({ code: "custom", message: "receipt item count mismatch" });
  }
  if (!value.items.every((item, index) => item.ordinal === index)) {
    context.addIssue({ code: "custom", message: "receipt ordinals must be contiguous and ordered" });
  }
  if (value.items.some((item) => new Set(item.sourceMessageIds).size !== item.sourceMessageIds.length)) {
    context.addIssue({ code: "custom", message: "duplicate receipt source message" });
  }
  if ((value.outcome === "USED" || value.outcome === "DEGRADED") && value.items.length === 0) {
    context.addIssue({ code: "custom", message: "visible receipt outcome requires items" });
  }
  if (value.outcome !== "USED" && value.outcome !== "DEGRADED" && value.items.length !== 0) {
    context.addIssue({ code: "custom", message: "non-visible receipt outcome cannot carry items" });
  }
  if (value.outcome === "DEGRADED" && value.degradationCode === null) {
    context.addIssue({ code: "custom", message: "degraded receipt requires a code" });
  }
  if (value.outcome !== "DEGRADED" && value.degradationCode !== null) {
    context.addIssue({ code: "custom", message: "only degraded receipt carries a degradation code" });
  }
});

export type MemoryReceipt = z.infer<typeof memoryReceiptSchema>;

export function decodeMemoryReceipt(
  value: unknown
): MemoryContractDecodeResult<MemoryReceipt> {
  return decode(memoryReceiptSchema, value);
}

const memoryActionFeedbackSchema = z.strictObject({
  deletionId: idSchema.optional(),
  expiresAt: isoTimestampSchema.optional(),
  factId: idSchema.optional(),
  operation: z.enum(MEMORY_ACTION_FEEDBACK_OPERATIONS),
  statement: safeText(MEMORY_STATEMENT_MAX_LENGTH).optional(),
  versionId: idSchema.optional(),
  status: z.literal("COMMITTED")
}).superRefine((value, context) => {
  const targetCount = Number(value.factId !== undefined) +
    Number(value.statement !== undefined) + Number(value.versionId !== undefined);
  if (targetCount !== 0 && targetCount !== 3) {
    context.addIssue({ code: "custom", message: "memory action target is incomplete" });
  }
  const undoCount = Number(value.deletionId !== undefined) +
    Number(value.expiresAt !== undefined);
  if (
    (undoCount !== 0 && undoCount !== 2) ||
    (undoCount === 2 && (value.operation !== "FORGET" || targetCount !== 3))
  ) {
    context.addIssue({ code: "custom", message: "memory action undo is invalid" });
  }
});

export type MemoryActionFeedback = z.infer<typeof memoryActionFeedbackSchema>;

export function decodeMemoryActionFeedback(
  value: unknown
): MemoryContractDecodeResult<MemoryActionFeedback> {
  return decode(memoryActionFeedbackSchema, value);
}

const memoryHistorySearchResponseSchema = z.strictObject({
  indexing: z.strictObject({
    degradationCode: z.enum(MEMORY_HISTORY_DEGRADATION_CODES).nullable(),
    lexicalState: z.enum(MEMORY_HISTORY_LEXICAL_STATES),
    vectorState: z.enum(MEMORY_HISTORY_VECTOR_STATES)
  }),
  nextCursor: cursorSchema,
  results: z.array(z.strictObject({
    indexingState: z.enum(MEMORY_ITEM_INDEXING_STATES),
    itemType: z.enum(["EPISODE", "RECALL_CHUNK"]),
    occurredAt: isoTimestampSchema,
    sourceChatId: idSchema,
    sourceChatTitle: safeText(200),
    sourceFolderId: idSchema.nullable(),
    sourceFolderName: safeText(200).nullable(),
    sourceMessageIds: z.array(idSchema).min(1).max(50),
    sourceState: z.enum(["AVAILABLE", "ARCHIVED"]),
    snippet: safeText(MEMORY_SEARCH_SNIPPET_MAX_LENGTH)
  })).max(MEMORY_PAGE_SIZE_MAX)
}).superRefine((value, context) => {
  const { degradationCode, lexicalState, vectorState } = value.indexing;
  const disabled = lexicalState === "DISABLED";
  const unavailable = lexicalState === "UNAVAILABLE";
  if (
    (disabled && (vectorState !== "DISABLED" || degradationCode !== null)) ||
    (unavailable && (
      vectorState !== "DISABLED" || degradationCode !== "memory_index_unavailable"
    )) ||
    (lexicalState === "READY" && vectorState === "DISABLED") ||
    (vectorState === "DEGRADED" && (
      degradationCode === null || degradationCode === "memory_index_unavailable"
    )) ||
    (vectorState !== "DEGRADED" && !unavailable && degradationCode !== null)
  ) {
    context.addIssue({ code: "custom", message: "history indexing state mismatch" });
  }
  if ((disabled || unavailable) && (value.results.length > 0 || value.nextCursor !== null)) {
    context.addIssue({ code: "custom", message: "inactive history index cannot return results" });
  }
  for (const result of value.results) {
    if ((result.sourceFolderId === null) !== (result.sourceFolderName === null)) {
      context.addIssue({ code: "custom", message: "history folder metadata is all-or-none" });
    }
    if (new Set(result.sourceMessageIds).size !== result.sourceMessageIds.length) {
      context.addIssue({ code: "custom", message: "duplicate history source message" });
    }
  }
});

export type MemoryHistorySearchResponse = z.infer<typeof memoryHistorySearchResponseSchema>;

export function decodeMemoryHistorySearchResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryHistorySearchResponse> {
  return decode(memoryHistorySearchResponseSchema, value);
}

const memoryRebuildStatusSchema = z.strictObject({
  completedUnits: safeInteger,
  createdAt: isoTimestampSchema,
  errorCode: z.enum(MEMORY_ERROR_CODES).nullable(),
  jobId: idSchema,
  operation: z.enum(MEMORY_REBUILD_OPERATIONS),
  state: z.enum(MEMORY_REBUILD_STATES),
  totalUnits: safeInteger.nullable(),
  updatedAt: isoTimestampSchema
}).superRefine((value, context) => {
  if (value.totalUnits !== null && value.completedUnits > value.totalUnits) {
    context.addIssue({ code: "custom", message: "rebuild progress exceeds total" });
  }
  if (value.state === "FAILED" && value.errorCode === null) {
    context.addIssue({ code: "custom", message: "failed rebuild requires a stable error" });
  }
  if (value.state !== "FAILED" && value.errorCode !== null) {
    context.addIssue({ code: "custom", message: "non-failed rebuild cannot carry an error" });
  }
});

export type MemoryRebuildStatus = z.infer<typeof memoryRebuildStatusSchema>;

export function decodeMemoryRebuildStatus(
  value: unknown
): MemoryContractDecodeResult<MemoryRebuildStatus> {
  return decode(memoryRebuildStatusSchema, value);
}

const memoryChatModeResponseSchema = z.strictObject({
  chatId: idSchema,
  memoryGeneration: safeInteger,
  memoryRevision: safeInteger,
  mode: z.enum(MEMORY_CHAT_MODES),
  sourceRevision: safeInteger
});

export type MemoryChatModeResponse = z.infer<typeof memoryChatModeResponseSchema>;

export function decodeMemoryChatModeResponse(
  value: unknown
): MemoryContractDecodeResult<MemoryChatModeResponse> {
  return decode(memoryChatModeResponseSchema, value);
}

const memoryErrorResponseSchema = z.strictObject({ error: z.enum(MEMORY_ERROR_CODES) });
export type MemoryErrorResponse = z.infer<typeof memoryErrorResponseSchema>;

export function decodeMemoryErrorResponse(value: unknown): MemoryErrorResponse | null {
  const result = memoryErrorResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}
