import { z } from "zod";

export const MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION =
  "memory-confirmation-v1" as const;
export const MEMORY_CONSUMER_STATEMENT_MAX_LENGTH = 2_000;
export const MEMORY_CONSUMER_QUERY_MAX_LENGTH = 500;
export const MEMORY_CONSUMER_PAGE_SIZE_MAX = 20;
export const MEMORY_CONSUMER_REF_MAX_LENGTH = 4_096;

export const MEMORY_CONSUMER_STATUSES = [
  "ON",
  "PREPARING",
  "UNAVAILABLE",
  "NEEDS_ADMIN_SETUP",
  "PAUSED"
] as const;

export const MEMORY_CONSUMER_RESET_STATES = [
  "IDLE",
  "IN_PROGRESS"
] as const;

export const MEMORY_CONSUMER_CATEGORIES = [
  "ABOUT_YOU",
  "PREFERENCES",
  "WORK",
  "GOALS",
  "CONSTRAINTS_AND_ROUTINES",
  "OTHER"
] as const;

export const MEMORY_CONSUMER_PROVENANCES = ["LEARNED", "SAVED"] as const;

export const MEMORY_CONSUMER_ITEM_ACTIONS = ["EDIT", "FORGET"] as const;

export const MEMORY_CONSUMER_ERROR_CODES = [
  "memory_contract_invalid",
  "memory_unavailable",
  "memory_preparing",
  "memory_not_found",
  "memory_changed",
  "memory_secret_rejected",
  "memory_action_failed",
  "memory_reset_in_progress"
] as const;

export type MemoryConsumerDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ code: "memory_contract_invalid"; ok: false }>;

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = safeInteger.min(1);
const safeText = (maxLength: number) => z.string().min(1).max(maxLength)
  .refine((value) => value.trim().length > 0, "text is blank")
  .refine((value) => !value.includes("\u0000"), "text contains a null byte");
const opaqueRefSchema = z.string().min(1).max(MEMORY_CONSUMER_REF_MAX_LENGTH)
  .refine((value) => !/[\u0000-\u0020\u007f]/u.test(value), "invalid opaque reference");
const requestIdSchema = z.string().trim().min(16).max(256)
  .refine((value) => !/[\u0000-\u0020\u007f]/u.test(value), "invalid request id");
const isoTimestampSchema = z.string().max(64).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}, "invalid ISO timestamp");

function decode<T>(
  schema: z.ZodType<T>,
  value: unknown
): MemoryConsumerDecodeResult<T> {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { code: "memory_contract_invalid", ok: false };
}

const memoryConsumerSettingsResponseSchema = z.strictObject({
  capabilities: z.strictObject({
    automaticLearningAvailable: z.boolean(),
    managementAvailable: z.boolean(),
    naturalLanguageActionsAvailable: z.boolean(),
    permanentChatDeletion: z.boolean(),
    pastChatIndexingAvailable: z.boolean(),
    retrievalAvailable: z.boolean(),
    temporaryChats: z.boolean()
  }),
  resetState: z.enum(MEMORY_CONSUMER_RESET_STATES),
  settings: z.strictObject({
    learnAutomatically: z.boolean(),
    referenceChatHistory: z.boolean(),
    useMemoryFacts: z.boolean()
  }),
  status: z.enum(MEMORY_CONSUMER_STATUSES)
});

export type MemoryConsumerSettingsResponse = z.infer<
  typeof memoryConsumerSettingsResponseSchema
>;

export function decodeMemoryConsumerSettingsResponse(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerSettingsResponse> {
  return decode(memoryConsumerSettingsResponseSchema, value);
}

const memoryConsumerSettingsPatchSchema = z.strictObject({
  learnAutomatically: z.boolean().optional(),
  referenceChatHistory: z.boolean().optional(),
  useMemoryFacts: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "empty settings patch");

export type MemoryConsumerSettingsPatch = z.infer<
  typeof memoryConsumerSettingsPatchSchema
>;

export function decodeMemoryConsumerSettingsPatch(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerSettingsPatch> {
  return decode(memoryConsumerSettingsPatchSchema, value);
}

const memoryConsumerItemSchema = z.strictObject({
  allowedActions: z.array(z.enum(MEMORY_CONSUMER_ITEM_ACTIONS)).max(2)
    .refine((values) => new Set(values).size === values.length, "duplicate action"),
  category: z.enum(MEMORY_CONSUMER_CATEGORIES),
  createdAt: isoTimestampSchema,
  memoryRef: opaqueRefSchema,
  provenance: z.enum(["LEARNED", "SAVED"]),
  sourceAvailable: z.boolean(),
  statement: safeText(MEMORY_CONSUMER_STATEMENT_MAX_LENGTH),
  updatedAt: isoTimestampSchema
});

export type MemoryConsumerItem = z.infer<typeof memoryConsumerItemSchema>;

const memoryConsumerListResponseSchema = z.strictObject({
  items: z.array(memoryConsumerItemSchema).max(MEMORY_CONSUMER_PAGE_SIZE_MAX),
  nextCursor: opaqueRefSchema.nullable()
});

export type MemoryConsumerListResponse = z.infer<
  typeof memoryConsumerListResponseSchema
>;

export function decodeMemoryConsumerListResponse(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerListResponse> {
  return decode(memoryConsumerListResponseSchema, value);
}

const memoryConsumerListInputSchema = z.strictObject({
  category: z.enum(MEMORY_CONSUMER_CATEGORIES).optional(),
  cursor: opaqueRefSchema.nullable().optional(),
  pageSize: positiveInteger.max(MEMORY_CONSUMER_PAGE_SIZE_MAX).optional(),
  provenance: z.enum(MEMORY_CONSUMER_PROVENANCES).optional()
});

export type MemoryConsumerListInput = z.infer<typeof memoryConsumerListInputSchema>;

export function decodeMemoryConsumerListInput(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerListInput> {
  return decode(memoryConsumerListInputSchema, value);
}

const memoryConsumerSearchInputSchema = memoryConsumerListInputSchema.extend({
  query: safeText(MEMORY_CONSUMER_QUERY_MAX_LENGTH)
});

export type MemoryConsumerSearchInput = z.infer<typeof memoryConsumerSearchInputSchema>;

export function decodeMemoryConsumerSearchInput(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerSearchInput> {
  return decode(memoryConsumerSearchInputSchema, value);
}

const memoryConsumerStatementMutationSchema = z.strictObject({
  requestId: requestIdSchema,
  statement: safeText(MEMORY_CONSUMER_STATEMENT_MAX_LENGTH)
});

export type MemoryConsumerStatementMutation = z.infer<
  typeof memoryConsumerStatementMutationSchema
>;

export function decodeMemoryConsumerStatementMutation(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerStatementMutation> {
  return decode(memoryConsumerStatementMutationSchema, value);
}

const memoryConsumerMutationResponseSchema = z.strictObject({
  item: memoryConsumerItemSchema
});

export type MemoryConsumerMutationResponse = z.infer<
  typeof memoryConsumerMutationResponseSchema
>;

export function decodeMemoryConsumerMutationResponse(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerMutationResponse> {
  return decode(memoryConsumerMutationResponseSchema, value);
}

const memoryConsumerForgetInputSchema = z.strictObject({ requestId: requestIdSchema });

export type MemoryConsumerForgetInput = z.infer<typeof memoryConsumerForgetInputSchema>;

export function decodeMemoryConsumerForgetInput(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerForgetInput> {
  return decode(memoryConsumerForgetInputSchema, value);
}

const memoryConsumerForgetResponseSchema = z.strictObject({
  status: z.literal("FORGOTTEN")
});

export type MemoryConsumerForgetResponse = z.infer<
  typeof memoryConsumerForgetResponseSchema
>;

export function decodeMemoryConsumerForgetResponse(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerForgetResponse> {
  return decode(memoryConsumerForgetResponseSchema, value);
}

const memoryConsumerResetInputSchema = z.strictObject({
  confirmationCopyVersion: z.literal(MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION),
  requestId: requestIdSchema
});

export type MemoryConsumerResetInput = z.infer<typeof memoryConsumerResetInputSchema>;

export function decodeMemoryConsumerResetInput(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerResetInput> {
  return decode(memoryConsumerResetInputSchema, value);
}

const memoryConsumerResetResponseSchema = z.strictObject({
  status: z.enum(["COMPLETE", "IN_PROGRESS"])
});

export type MemoryConsumerResetResponse = z.infer<
  typeof memoryConsumerResetResponseSchema
>;

export function decodeMemoryConsumerResetResponse(
  value: unknown
): MemoryConsumerDecodeResult<MemoryConsumerResetResponse> {
  return decode(memoryConsumerResetResponseSchema, value);
}

const memoryConsumerErrorResponseSchema = z.strictObject({
  error: z.enum(MEMORY_CONSUMER_ERROR_CODES)
});

export type MemoryConsumerErrorResponse = z.infer<
  typeof memoryConsumerErrorResponseSchema
>;

export function decodeMemoryConsumerErrorResponse(
  value: unknown
): MemoryConsumerErrorResponse | null {
  const result = memoryConsumerErrorResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}
