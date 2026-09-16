export type ChatContinuationModelSelection = Readonly<{ provider: string; modelId: string }>;
export type ChatContinuationRequest = Readonly<{
  expectedLeafMessageId: string;
  requestId: string;
  modelSelection?: ChatContinuationModelSelection;
}>;
export type ChatContinuationResult =
  | Readonly<{ status: "complete"; chatId: string; projectId: string | null }>
  | Readonly<{ status: "running" }>;

export function decodeChatContinuationRequest(value: unknown): ChatContinuationRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["expectedLeafMessageId", "requestId", "modelSelection"].includes(key)) || typeof record.expectedLeafMessageId !== "string" ||
    !record.expectedLeafMessageId || record.expectedLeafMessageId.length > 256 ||
    typeof record.requestId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.requestId)) return null;
  let modelSelection: ChatContinuationModelSelection | undefined;
  if ("modelSelection" in record) {
    const selection = record.modelSelection;
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) return null;
    const model = selection as Record<string, unknown>;
    if (Object.keys(model).length !== 2 || typeof model.provider !== "string" || !model.provider || model.provider.length > 256 ||
      typeof model.modelId !== "string" || !model.modelId || model.modelId.length > 256) return null;
    modelSelection = { provider: model.provider, modelId: model.modelId };
  }
  return { expectedLeafMessageId: record.expectedLeafMessageId, requestId: record.requestId,
    ...(modelSelection ? { modelSelection } : {}) };
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
