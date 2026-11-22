/** Content-free estimate shared by the chat header and the session tool.
 * It describes one request/answer, never accumulated billing usage. */
export type SessionContextStatus = Readonly<{
  approximateInputTokens: number;
  contextWindow: number | null;
  droppedMessages: number;
  loadedTools: number;
  maxOutputTokens: number;
  modelId: string;
  phase: "after_answer" | "request";
  provider: string;
  safetyMarginTokens: number;
  version: 1;
}>;

const fields = [
  "approximateInputTokens", "contextWindow", "droppedMessages", "loadedTools",
  "maxOutputTokens", "modelId", "phase", "provider", "safetyMarginTokens", "version"
];
const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function decodeSessionContextStatus(value: unknown): SessionContextStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length ||
    Object.keys(record).some((key) => !fields.includes(key)) ||
    record.version !== 1 ||
    (record.phase !== "after_answer" && record.phase !== "request") ||
    !nonNegativeInteger(record.approximateInputTokens) ||
    !nonNegativeInteger(record.droppedMessages) ||
    !nonNegativeInteger(record.loadedTools) ||
    !nonNegativeInteger(record.maxOutputTokens) ||
    !nonNegativeInteger(record.safetyMarginTokens) ||
    !(record.contextWindow === null || (nonNegativeInteger(record.contextWindow) && record.contextWindow > 0)) ||
    typeof record.modelId !== "string" || !record.modelId || record.modelId.length > 512 ||
    typeof record.provider !== "string" || !record.provider || record.provider.length > 128) return null;
  return record as SessionContextStatus;
}
