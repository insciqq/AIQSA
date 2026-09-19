import { decodeSkillIds } from "./skills";

export type SkillSuggestionRequest = Readonly<{
  requestId: string;
  draft: string;
  chatId: string | null;
  expectedActiveLeafMessageId: string | null;
  projectId: string | null;
  excludedIds: readonly string[];
}>;
export type SkillSuggestion = Readonly<{ id: string; name: string; description: string }>;
export type SkillSuggestionResponse = Readonly<{
  status: "ready" | "disabled" | "unavailable";
  skills: readonly SkillSuggestion[];
}>;

export function decodeSkillSuggestionRequest(value: unknown): SkillSuggestionRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["requestId", "draft", "chatId", "expectedActiveLeafMessageId", "projectId", "excludedIds"].includes(key)) ||
    typeof input.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.requestId) ||
    typeof input.draft !== "string") return null;
  const identifier = (v: unknown): v is string | null => v === null || typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 64;
  if (!identifier(input.chatId) || !identifier(input.projectId) || !identifier(input.expectedActiveLeafMessageId) ||
    input.chatId === null && input.expectedActiveLeafMessageId !== null) return null;
  const excluded = decodeSkillIds(input.excludedIds);
  if (!excluded.ok) return null;
  return { requestId: input.requestId, draft: input.draft, chatId: input.chatId, projectId: input.projectId,
    expectedActiveLeafMessageId: input.expectedActiveLeafMessageId, excludedIds: excluded.ids };
}
