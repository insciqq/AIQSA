import { z } from "zod";
import {
  MEMORY_CONSUMER_CATEGORIES,
  MEMORY_CONSUMER_PAGE_SIZE_MAX,
  MEMORY_CONSUMER_PROVENANCES,
  MEMORY_CONSUMER_QUERY_MAX_LENGTH,
  MEMORY_CONSUMER_REF_MAX_LENGTH,
  MEMORY_CONSUMER_STATEMENT_MAX_LENGTH,
  type MemoryConsumerItem,
  type MemoryConsumerListResponse
} from "../../contracts/memoryConsumer";

const safeText = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .refine((value) => value.trim().length > 0, "text is blank")
  .refine((value) => !value.includes("\u0000"), "text contains a null byte");

const opaqueRef = z.string()
  .min(1)
  .max(MEMORY_CONSUMER_REF_MAX_LENGTH)
  .refine(
    (value) => !/[\u0000-\u0020\u007f]/u.test(value),
    "invalid opaque reference"
  );

const isoTimestamp = z.string().max(64).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}, "invalid ISO timestamp");

export const memoryMcpPublicItemSchema = z.strictObject({
  memoryRef: opaqueRef,
  text: safeText(MEMORY_CONSUMER_STATEMENT_MAX_LENGTH),
  category: z.enum(MEMORY_CONSUMER_CATEGORIES),
  provenance: z.enum(MEMORY_CONSUMER_PROVENANCES),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp
});

export const memoryMcpItemResultSchema = z.strictObject({
  item: memoryMcpPublicItemSchema
});

export const memoryMcpListResultSchema = z.strictObject({
  items: z.array(memoryMcpPublicItemSchema).max(MEMORY_CONSUMER_PAGE_SIZE_MAX),
  nextCursor: opaqueRef.nullable()
});

export const memoryMcpSearchResultSchema = z.strictObject({
  items: z.array(memoryMcpPublicItemSchema).max(MEMORY_CONSUMER_PAGE_SIZE_MAX)
});

export const memoryMcpForgetResultSchema = z.strictObject({
  status: z.literal("FORGOTTEN")
});

export const MEMORY_MCP_ERROR_CODES = [
  "memory_contract_invalid",
  "memory_unavailable",
  "memory_preparing",
  "memory_not_found",
  "memory_changed",
  "memory_secret_rejected",
  "memory_action_failed"
] as const;

export const memoryMcpErrorResultSchema = z.strictObject({
  error: z.enum(MEMORY_MCP_ERROR_CODES)
});

export const addMemoryInputSchema = z.strictObject({
  text: safeText(MEMORY_CONSUMER_STATEMENT_MAX_LENGTH).describe(
    "One concise, already-formed fact to remember exactly as written. Do not pass a whole conversation or inferred assistant text."
  )
});

const limitField = z.number().int().min(1).max(MEMORY_CONSUMER_PAGE_SIZE_MAX)
  .optional()
  .describe(`Maximum facts to return, from 1 to ${MEMORY_CONSUMER_PAGE_SIZE_MAX}; defaults to 20.`);

const pageFields = {
  category: z.enum(MEMORY_CONSUMER_CATEGORIES).optional().describe(
    "Optional exact storage-category filter. Omit for normal recall; do not infer a category from the user's question because that can hide a relevant fact. Use only when the user explicitly asks to restrict results to a category."
  ),
  provenance: z.enum(MEMORY_CONSUMER_PROVENANCES).optional().describe(
    "Optional exact source filter: SAVED for explicit memories or LEARNED for automatically learned facts. Omit for normal recall and use only when the user explicitly asks to restrict results by source."
  ),
  limit: limitField,
  cursor: opaqueRef.nullable().optional().describe(
    "Opaque nextCursor from the preceding response; omit or pass null for the first page."
  )
} as const;

export const searchMemoriesInputSchema = z.strictObject({
  query: safeText(MEMORY_CONSUMER_QUERY_MAX_LENGTH).describe(
    "The user's natural-language question or concise retrieval intent. Semantic search can match a relevant fact even when the wording differs, so preserve the meaning instead of guessing storage keywords."
  ),
  limit: limitField
});

export const listMemoriesInputSchema = z.strictObject(pageFields);

export const getMemoryInputSchema = z.strictObject({
  memoryRef: opaqueRef.describe(
    "Exact opaque memoryRef returned by a current search, list, add, or update result."
  )
});

export const updateMemoryInputSchema = z.strictObject({
  memoryRef: opaqueRef.describe(
    "Exact opaque memoryRef for the fact to replace, obtained from a current read result."
  ),
  text: safeText(MEMORY_CONSUMER_STATEMENT_MAX_LENGTH).describe(
    "Complete replacement fact text, not a patch or an instruction."
  )
});

export const deleteMemoryInputSchema = getMemoryInputSchema;

export const memoryMcpItemOutputSchema = z.union([
  memoryMcpItemResultSchema,
  memoryMcpErrorResultSchema
]);

export const memoryMcpListOutputSchema = z.union([
  memoryMcpListResultSchema,
  memoryMcpErrorResultSchema
]);

export const memoryMcpSearchOutputSchema = z.union([
  memoryMcpSearchResultSchema,
  memoryMcpErrorResultSchema
]);

export const memoryMcpForgetOutputSchema = z.union([
  memoryMcpForgetResultSchema,
  memoryMcpErrorResultSchema
]);

export type MemoryMcpPublicItem = z.infer<typeof memoryMcpPublicItemSchema>;
export type MemoryMcpItemResult = z.infer<typeof memoryMcpItemResultSchema>;
export type MemoryMcpListResult = z.infer<typeof memoryMcpListResultSchema>;
export type MemoryMcpSearchResult = z.infer<typeof memoryMcpSearchResultSchema>;
export type MemoryMcpForgetResult = z.infer<typeof memoryMcpForgetResultSchema>;
export type MemoryMcpErrorResult = z.infer<typeof memoryMcpErrorResultSchema>;

export function projectMemoryMcpItem(item: MemoryConsumerItem): MemoryMcpPublicItem {
  return memoryMcpPublicItemSchema.parse({
    memoryRef: item.memoryRef,
    text: item.statement,
    category: item.category,
    provenance: item.provenance,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  });
}

export function projectMemoryMcpList(
  response: MemoryConsumerListResponse
): MemoryMcpListResult {
  return memoryMcpListResultSchema.parse({
    items: response.items.map(projectMemoryMcpItem),
    nextCursor: response.nextCursor
  });
}

export function projectMemoryMcpSearch(
  items: readonly MemoryConsumerItem[]
): MemoryMcpSearchResult {
  return memoryMcpSearchResultSchema.parse({
    items: items.map(projectMemoryMcpItem)
  });
}
