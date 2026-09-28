import { z } from "zod";

export const MEMORY_COMMAND_STATUSES = [
  "PENDING", "RUNNING", "COMMITTED", "REJECTED", "AMBIGUOUS", "FAILED", "UNKNOWN", "STALE"
] as const;
export const MEMORY_COMMAND_OPERATIONS = ["UNKNOWN", "SAVE", "UPDATE", "FORGET"] as const;

const reference = z.string().min(1).max(2_048)
  .refine((value) => !/[\u0000-\u0020\u007f]/u.test(value), "invalid reference");
const timestamp = z.string().max(64).refine((value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
  !Number.isNaN(Date.parse(value)), "invalid timestamp");

/** Background progress is independent of immutable accepted-run artifacts.
 * No candidate, target, provider output, failure detail, or statement crosses
 * this boundary, including after a successful mutation. */
const memoryCommandFeedbackSchema = z.strictObject({
  commandRef: reference,
  operation: z.enum(MEMORY_COMMAND_OPERATIONS),
  status: z.enum(MEMORY_COMMAND_STATUSES),
  updatedAt: timestamp
}).superRefine((value, context) => {
  if ((value.status === "COMMITTED" && value.operation === "UNKNOWN") ||
    (value.status === "AMBIGUOUS" && value.operation !== "UPDATE" && value.operation !== "FORGET")) {
    context.addIssue({ code: "custom", message: "invalid command status" });
  }
});

export type MemoryCommandFeedback = z.infer<typeof memoryCommandFeedbackSchema>;

const memoryCommandListResponseSchema = z.strictObject({
  commands: z.array(z.strictObject({
    feedback: memoryCommandFeedbackSchema,
    messageId: reference
  })).max(100)
});
export type MemoryCommandListResponse = z.infer<typeof memoryCommandListResponseSchema>;

export function decodeMemoryCommandFeedback(value: unknown): MemoryCommandFeedback | null {
  const result = memoryCommandFeedbackSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function decodeMemoryCommandListResponse(value: unknown): MemoryCommandListResponse | null {
  const result = memoryCommandListResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function memoryCommandIsPending(command: MemoryCommandFeedback): boolean {
  return command.status === "PENDING" || command.status === "RUNNING";
}
