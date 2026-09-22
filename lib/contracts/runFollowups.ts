/** A clarification of an accepted task. Delivery is not a promise of obedience. */
export const RUN_FOLLOWUP_MAX_CHARS = 16_000;
export const RUN_FOLLOWUP_MAX_COUNT = 32;
export const RUN_FOLLOWUP_MAX_TOTAL_CHARS = 64_000;

export type RunFollowupInput = Readonly<{
  chatId: string;
  assistantMessageId: string;
  nonce: string;
  text: string;
}>;

export type RunFollowup = Readonly<{
  id: string;
  ordinal: number;
  text: string;
  author: string;
  createdAt: string;
  delivery: "accepted" | "delivered" | "undelivered";
  /** Already displayed text from the generation superseded by this batch. */
  precedingText?: string;
}>;

export type RunFollowupState = Readonly<{
  available: boolean;
  entries: readonly RunFollowup[];
}>;

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);

export function decodeRunFollowupInput(value: unknown): RunFollowupInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["chatId", "assistantMessageId", "nonce", "text"].includes(key)) ||
    !identifier(input.chatId) || !identifier(input.assistantMessageId) || !identifier(input.nonce) ||
    typeof input.text !== "string" || !input.text.trim() || input.text.length > RUN_FOLLOWUP_MAX_CHARS ||
    input.text.includes("\0")) return null;
  return { chatId: input.chatId, assistantMessageId: input.assistantMessageId, nonce: input.nonce, text: input.text.trim() };
}

export function decodeRunFollowupState(value: unknown): RunFollowupState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (typeof state.available !== "boolean" || !Array.isArray(state.entries) || state.entries.length > RUN_FOLLOWUP_MAX_COUNT) return null;
  const entries: RunFollowup[] = [];
  for (const value of state.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (!identifier(entry.id) || !Number.isSafeInteger(entry.ordinal) || Number(entry.ordinal) > RUN_FOLLOWUP_MAX_COUNT || Number(entry.ordinal) <= (entries.at(-1)?.ordinal ?? 0) ||
      typeof entry.text !== "string" || !entry.text.trim() || entry.text.length > RUN_FOLLOWUP_MAX_CHARS ||
      typeof entry.author !== "string" || entry.author.length > 256 ||
      typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) ||
      !["accepted", "delivered", "undelivered"].includes(String(entry.delivery)) ||
      (entry.precedingText !== undefined && typeof entry.precedingText !== "string")) return null;
    entries.push({ id: entry.id, ordinal: Number(entry.ordinal), text: entry.text, author: entry.author,
      createdAt: entry.createdAt, delivery: entry.delivery as RunFollowup["delivery"],
      ...(typeof entry.precedingText === "string" && entry.precedingText ? { precedingText: entry.precedingText } : {}) });
  }
  if (entries.reduce((sum, entry) => sum + entry.text.length, 0) > RUN_FOLLOWUP_MAX_TOTAL_CHARS) return null;
  return { available: state.available, entries };
}
