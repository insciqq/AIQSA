import { z } from "zod";

/** Consumer-safe Memory primitives shared by browser projections and the
 * server serializers that produce them. Rich persistence/admin contracts
 * belong in the server-only legacy contract instead. */
export const MEMORY_CONFIRMATION_COPY_VERSION = "memory-confirmation-v1" as const;
export const MEMORY_TEMPORARY_RETENTION_POLICY_VERSION = "temporary-24h-v1" as const;
export const MEMORY_STATEMENT_MAX_LENGTH = 2_000;
export const MEMORY_CLIENT_PAGE_SIZE_MAX = 20;
export const MEMORY_ANSWER_SOURCE_MAX_ITEMS = 40;

export const MEMORY_CHAT_MODES = ["NORMAL", "EXCLUDED", "TEMPORARY"] as const;
export type MemoryChatMode = (typeof MEMORY_CHAT_MODES)[number];

export const MEMORY_CONSUMER_CHAT_MODE_ACTIONS = ["EXCLUDE", "RESUME"] as const;

export const MEMORY_CONSUMER_PERMANENT_DELETE_STATUSES = [
  "COMPLETE",
  "IN_PROGRESS",
  "NEEDS_ATTENTION"
] as const;

export const MEMORY_ACTION_FEEDBACK_OPERATIONS = [
  "SAVE",
  "UPDATE",
  "FORGET",
  "LIST",
  "SEARCH",
  "RESET"
] as const;
export const MEMORY_ACTION_RESULT_STATUSES = [
  "AMBIGUOUS",
  "COMMITTED",
  "COMPLETE",
  "CONFIRMATION_REQUIRED",
  "REJECTED",
  "THIS_CHAT_ONLY"
] as const;
export const MEMORY_ANSWER_SOURCE_ACTIONS = [
  "CORRECT",
  "FORGET",
  "NOT_RELEVANT",
  "OPEN_SOURCE"
] as const;

export type MemoryClientDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ code: "memory_contract_invalid"; ok: false }>;

const safeText = (maxLength: number) => z.string().min(1).max(maxLength)
  .refine((value) => value.trim().length > 0, "text is blank")
  .refine((value) => !value.includes("\u0000"), "text contains a null byte");
const opaqueRefSchema = z.string().trim().min(1).max(2_048)
  .refine((value) => !/[\u0000-\u0020\u007f]/u.test(value), "invalid opaque reference");
const requestNonceSchema = z.string().trim().min(1).max(256)
  .refine((value) => !/[\u0000-\u0020\u007f]/u.test(value), "invalid request nonce");
const isoTimestampSchema = z.string().max(64).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}, "invalid ISO timestamp");

function decode<T>(schema: z.ZodType<T>, value: unknown): MemoryClientDecodeResult<T> {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { code: "memory_contract_invalid", ok: false };
}

const memoryConsumerChatModeResponseSchema = z.strictObject({
  allowedActions: z.array(z.enum(MEMORY_CONSUMER_CHAT_MODE_ACTIONS)).max(1),
  archived: z.boolean(),
  mode: z.enum(MEMORY_CHAT_MODES),
  temporaryRetentionDeadline: isoTimestampSchema.nullable()
}).superRefine((value, context) => {
  const action = value.allowedActions[0];
  const valid =
    (value.mode === "NORMAL" && action === "EXCLUDE") ||
    (value.mode === "EXCLUDED" && action === "RESUME") ||
    (value.mode === "TEMPORARY" && action === undefined);
  if (!valid || ((value.mode === "TEMPORARY") !==
    (value.temporaryRetentionDeadline !== null))) {
    context.addIssue({ code: "custom", message: "invalid chat Memory state" });
  }
});

export type MemoryConsumerChatModeResponse = z.infer<
  typeof memoryConsumerChatModeResponseSchema
>;

export function decodeMemoryConsumerChatModeResponse(
  value: unknown
): MemoryClientDecodeResult<MemoryConsumerChatModeResponse> {
  return decode(memoryConsumerChatModeResponseSchema, value);
}

const memoryConsumerChatModePatchSchema = z.strictObject({
  mode: z.enum(["NORMAL", "EXCLUDED"]),
  resumeDisclosureCopyVersion: z.literal(MEMORY_CONFIRMATION_COPY_VERSION).optional()
}).superRefine((value, context) => {
  if ((value.mode === "NORMAL") !==
    (value.resumeDisclosureCopyVersion === MEMORY_CONFIRMATION_COPY_VERSION)) {
    context.addIssue({ code: "custom", message: "Resume requires current disclosure" });
  }
});

export type MemoryConsumerChatModePatch = z.infer<
  typeof memoryConsumerChatModePatchSchema
>;

export function decodeMemoryConsumerChatModePatch(
  value: unknown
): MemoryClientDecodeResult<MemoryConsumerChatModePatch> {
  return decode(memoryConsumerChatModePatchSchema, value);
}

const memoryConsumerPermanentChatDeleteInputSchema = z.strictObject({
  alsoForgetOriginMemories: z.boolean(),
  confirmationCopyVersion: z.literal(MEMORY_CONFIRMATION_COPY_VERSION),
  requestId: requestNonceSchema
});

export type MemoryConsumerPermanentChatDeleteInput = z.infer<
  typeof memoryConsumerPermanentChatDeleteInputSchema
>;

export function decodeMemoryConsumerPermanentChatDeleteInput(
  value: unknown
): MemoryClientDecodeResult<MemoryConsumerPermanentChatDeleteInput> {
  return decode(memoryConsumerPermanentChatDeleteInputSchema, value);
}

const memoryConsumerPermanentChatDeleteResponseSchema = z.strictObject({
  status: z.enum(MEMORY_CONSUMER_PERMANENT_DELETE_STATUSES)
});

export type MemoryConsumerPermanentChatDeleteResponse = z.infer<
  typeof memoryConsumerPermanentChatDeleteResponseSchema
>;

export function decodeMemoryConsumerPermanentChatDeleteResponse(
  value: unknown
): MemoryClientDecodeResult<MemoryConsumerPermanentChatDeleteResponse> {
  return decode(memoryConsumerPermanentChatDeleteResponseSchema, value);
}

const memoryActionResultItemSchema = z.strictObject({
  category: safeText(64),
  createdAt: isoTimestampSchema,
  memoryRef: opaqueRefSchema,
  provenance: z.enum(["LEARNED", "SAVED"]),
  sensitivity: z.enum(["NORMAL", "SENSITIVE"]),
  statement: safeText(MEMORY_STATEMENT_MAX_LENGTH)
});

export type MemoryActionResultItem = z.infer<typeof memoryActionResultItemSchema>;

const memoryActionFeedbackSchema = z.strictObject({
  candidates: z.array(memoryActionResultItemSchema).min(2).max(5).optional(),
  items: z.array(memoryActionResultItemSchema).max(MEMORY_CLIENT_PAGE_SIZE_MAX).optional(),
  memoryRef: opaqueRefSchema.optional(),
  operation: z.enum(MEMORY_ACTION_FEEDBACK_OPERATIONS),
  statement: safeText(MEMORY_STATEMENT_MAX_LENGTH).optional(),
  status: z.enum(MEMORY_ACTION_RESULT_STATUSES)
}).superRefine((value, context) => {
  const mutation = value.operation === "SAVE" || value.operation === "UPDATE" ||
    value.operation === "FORGET";
  const committedTarget = value.operation === "FORGET"
    ? value.memoryRef === undefined && value.statement === undefined
    : value.memoryRef !== undefined && value.statement !== undefined;
  const valid =
    (value.status === "COMMITTED" && mutation && committedTarget &&
      value.items === undefined && value.candidates === undefined) ||
    (value.status === "COMPLETE" &&
      (value.operation === "LIST" || value.operation === "SEARCH") &&
      value.items !== undefined && value.candidates === undefined &&
      value.memoryRef === undefined && value.statement === undefined) ||
    (value.status === "CONFIRMATION_REQUIRED" && value.operation === "RESET" &&
      value.items === undefined && value.candidates === undefined &&
      value.memoryRef === undefined && value.statement === undefined) ||
    (value.status === "AMBIGUOUS" &&
      (value.operation === "UPDATE" || value.operation === "FORGET") &&
      value.candidates !== undefined && value.items === undefined &&
      value.memoryRef === undefined &&
      ((value.operation === "UPDATE" && value.statement !== undefined) ||
        (value.operation === "FORGET" && value.statement === undefined))) ||
    (value.status === "REJECTED" && mutation && value.items === undefined &&
      value.candidates === undefined && value.memoryRef === undefined &&
      value.statement === undefined) ||
    (value.status === "THIS_CHAT_ONLY" && value.operation === "SAVE" &&
      value.statement !== undefined && value.items === undefined &&
      value.candidates === undefined && value.memoryRef === undefined);
  if (!valid) context.addIssue({ code: "custom", message: "memory action result is invalid" });
});

export type MemoryActionFeedback = z.infer<typeof memoryActionFeedbackSchema>;

export function decodeMemoryActionFeedback(
  value: unknown
): MemoryClientDecodeResult<MemoryActionFeedback> {
  return decode(memoryActionFeedbackSchema, value);
}

const memoryAnswerSourceBaseSchema = {
  date: isoTimestampSchema,
} as const;

const availableMemoryAnswerSourceBaseSchema = {
  ...memoryAnswerSourceBaseSchema,
  memoryRef: opaqueRefSchema,
  sourceAvailable: z.literal(true),
  text: safeText(1_000)
} as const;

const unavailableMemoryAnswerSourceBaseSchema = {
  ...memoryAnswerSourceBaseSchema,
  actions: z.array(z.enum(MEMORY_ANSWER_SOURCE_ACTIONS)).length(0),
  memoryRef: z.undefined().optional(),
  sourceAvailable: z.literal(false),
  text: z.undefined().optional()
} as const;

const memoryAnswerSourceSchema = z.union([
  z.strictObject({
    ...availableMemoryAnswerSourceBaseSchema,
    actions: z.tuple([
      z.literal("CORRECT"),
      z.literal("FORGET"),
      z.literal("NOT_RELEVANT"),
      z.literal("OPEN_SOURCE")
    ]),
    sourceType: z.literal("LEARNED_MEMORY")
  }),
  z.strictObject({
    ...availableMemoryAnswerSourceBaseSchema,
    actions: z.tuple([
      z.literal("CORRECT"),
      z.literal("FORGET"),
      z.literal("NOT_RELEVANT")
    ]),
    sourceType: z.literal("LEARNED_MEMORY")
  }),
  z.strictObject({
    ...availableMemoryAnswerSourceBaseSchema,
    actions: z.tuple([
      z.literal("CORRECT"),
      z.literal("FORGET"),
      z.literal("NOT_RELEVANT"),
      z.literal("OPEN_SOURCE")
    ]),
    origin: safeText(200).optional(),
    sourceType: z.literal("PAST_CHAT")
  }),
  z.strictObject({
    ...availableMemoryAnswerSourceBaseSchema,
    actions: z.tuple([
      z.literal("CORRECT"),
      z.literal("FORGET"),
      z.literal("NOT_RELEVANT")
    ]),
    sourceType: z.literal("SAVED_MEMORY")
  }),
  z.strictObject({
    ...unavailableMemoryAnswerSourceBaseSchema,
    sourceType: z.literal("LEARNED_MEMORY")
  }),
  z.strictObject({
    ...unavailableMemoryAnswerSourceBaseSchema,
    sourceType: z.literal("PAST_CHAT")
  }),
  z.strictObject({
    ...unavailableMemoryAnswerSourceBaseSchema,
    sourceType: z.literal("SAVED_MEMORY")
  })
]);

export type MemoryAnswerSource = z.infer<typeof memoryAnswerSourceSchema>;

export function decodeMemoryAnswerSource(
  value: unknown
): MemoryClientDecodeResult<MemoryAnswerSource> {
  return decode(memoryAnswerSourceSchema, value);
}

const memorySourceActionCommonSchema = z.strictObject({
  memoryRef: opaqueRefSchema,
  requestNonce: requestNonceSchema
});

const memorySourceActionInputSchema = z.discriminatedUnion("action", [
  memorySourceActionCommonSchema.extend({
    action: z.literal("CORRECT"),
    statement: safeText(MEMORY_STATEMENT_MAX_LENGTH)
  }),
  memorySourceActionCommonSchema.extend({ action: z.literal("FORGET") }),
  memorySourceActionCommonSchema.extend({ action: z.literal("NOT_RELEVANT") }),
  memorySourceActionCommonSchema.extend({ action: z.literal("OPEN_SOURCE") })
]);

export type MemorySourceActionInput = z.infer<typeof memorySourceActionInputSchema>;

export function decodeMemorySourceActionInput(
  value: unknown
): MemoryClientDecodeResult<MemorySourceActionInput> {
  return decode(memorySourceActionInputSchema, value);
}

export function isSafeMemorySourceActionHref(value: unknown): value is string {
  if (typeof value !== "string" ||
    !value.startsWith("/api/me/memory/source-actions/open?") ||
    value.startsWith("//") || /[\u0000-\u001f\u007f\s]/u.test(value)) return false;
  try {
    const url = new URL(value, "https://aiqsa.invalid");
    const refs = url.searchParams.getAll("memoryRef");
    return url.origin === "https://aiqsa.invalid" &&
      url.pathname === "/api/me/memory/source-actions/open" &&
      url.hash === "" && url.searchParams.size === 1 && refs.length === 1 &&
      refs[0]!.length > 0 && refs[0]!.length <= 2_048 &&
      refs[0]!.trim() === refs[0] &&
      !/[\u0000-\u0020\u007f]/u.test(refs[0]!);
  } catch {
    return false;
  }
}

const memorySourceActionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("COMMITTED") }),
  z.strictObject({
    href: z.string().max(2_048).refine(isSafeMemorySourceActionHref, "unsafe source action href"),
    status: z.literal("READY")
  })
]);

export type MemorySourceActionResponse = z.infer<typeof memorySourceActionResponseSchema>;

export function decodeMemorySourceActionResponse(
  value: unknown
): MemoryClientDecodeResult<MemorySourceActionResponse> {
  return decode(memorySourceActionResponseSchema, value);
}
