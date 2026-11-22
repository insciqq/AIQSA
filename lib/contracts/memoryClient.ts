import { z } from "zod";

/** Client-safe chat Memory-mode primitives (Excluded and Temporary chats, permanent chat deletion) shared by browser
 * projections and the server routes that produce and check them. The names keep their Memory prefix from the retired
 * Personal Memory contracts so the wire values and their importers stay as they are. */
export const MEMORY_CONFIRMATION_COPY_VERSION = "memory-confirmation-v1" as const;
/** The database pins this value on every Temporary chat (`temporaryRetentionPolicyVersion`). */
export const MEMORY_TEMPORARY_RETENTION_POLICY_VERSION = "temporary-24h-v1" as const;

export const MEMORY_CHAT_MODES = ["NORMAL", "EXCLUDED", "TEMPORARY"] as const;
export type MemoryChatMode = (typeof MEMORY_CHAT_MODES)[number];

export const MEMORY_CONSUMER_CHAT_MODE_ACTIONS = ["EXCLUDE", "RESUME"] as const;

export const MEMORY_CONSUMER_PERMANENT_DELETE_STATUSES = [
  "COMPLETE",
  "IN_PROGRESS",
  "NEEDS_ATTENTION"
] as const;

export type MemoryClientDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ code: "memory_contract_invalid"; ok: false }>;

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

/** Why a chat's Memory mode cannot change: an imported chat (or a copy of one) stays Excluded. */
export const MEMORY_CHAT_MODE_LOCK_REASONS = ["IMPORTED"] as const;

const memoryConsumerChatModeResponseSchema = z.strictObject({
  allowedActions: z.array(z.enum(MEMORY_CONSUMER_CHAT_MODE_ACTIONS)).max(1),
  archived: z.boolean(),
  lockedReason: z.enum(MEMORY_CHAT_MODE_LOCK_REASONS).optional(),
  mode: z.enum(MEMORY_CHAT_MODES),
  temporaryRetentionDeadline: isoTimestampSchema.nullable()
}).superRefine((value, context) => {
  const action = value.allowedActions[0];
  const valid = value.lockedReason !== undefined
    ? value.mode === "EXCLUDED" && action === undefined
    : (value.mode === "NORMAL" && action === "EXCLUDE") ||
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

const memoryInitialChatModeSchema = z.discriminatedUnion("chatMode", [
  z.strictObject({ chatMode: z.literal("NORMAL") }),
  z.strictObject({
    chatMode: z.literal("TEMPORARY"),
    temporaryRetentionPolicyVersion: z.literal(MEMORY_TEMPORARY_RETENTION_POLICY_VERSION)
  })
]);

/** The mode a new chat's first send asks for: an ordinary chat, or a Temporary one under the current policy. */
export type MemoryInitialChatMode = z.infer<typeof memoryInitialChatModeSchema>;

export function decodeMemoryInitialChatMode(
  value: unknown
): MemoryClientDecodeResult<MemoryInitialChatMode> {
  return decode(memoryInitialChatModeSchema, value);
}
