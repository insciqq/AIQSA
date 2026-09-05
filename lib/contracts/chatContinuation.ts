export type ChatContinuationRequest = Readonly<{ expectedLeafMessageId: string; requestId: string }>;
export type ChatContinuationResult =
  | Readonly<{ status: "complete"; chatId: string; projectId: string | null }>
  | Readonly<{ status: "running" }>;

export function decodeChatContinuationRequest(value: unknown): ChatContinuationRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.expectedLeafMessageId !== "string" ||
    !record.expectedLeafMessageId || record.expectedLeafMessageId.length > 256 ||
    typeof record.requestId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.requestId)) return null;
  return { expectedLeafMessageId: record.expectedLeafMessageId, requestId: record.requestId };
}

export function decodeChatContinuationResult(value: unknown): ChatContinuationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status === "running" && Object.keys(record).length === 1) return { status: "running" };
  if (record.status !== "complete" || Object.keys(record).length !== 3 ||
    typeof record.chatId !== "string" || !record.chatId || record.chatId.length > 256 ||
    !(record.projectId === null || typeof record.projectId === "string" && record.projectId.length > 0 && record.projectId.length <= 256)) return null;
  return { status: "complete", chatId: record.chatId, projectId: record.projectId };
}
