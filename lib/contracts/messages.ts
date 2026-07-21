export type EditedMessageWire = {
  chatId: string;
  content: unknown;
  id: string;
  modelId: string | null;
  parentMessageId: string | null;
  provider: string | null;
  role: "assistant" | "user";
  status: string;
};

export type EditMessageResponseWire = {
  message: EditedMessageWire;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function decodeEditMessageResponse(value: unknown): EditMessageResponseWire | null {
  if (!isRecord(value) || !isRecord(value.message)) {
    return null;
  }

  const message = value.message;
  if (
    typeof message.chatId !== "string" ||
    message.chatId.length === 0 ||
    typeof message.id !== "string" ||
    message.id.length === 0 ||
    !("content" in message) ||
    (message.role !== "assistant" && message.role !== "user") ||
    typeof message.status !== "string" ||
    message.status.length === 0 ||
    !nullableString(message.modelId) ||
    !nullableString(message.parentMessageId) ||
    !nullableString(message.provider)
  ) {
    return null;
  }

  return {
    message: {
      chatId: message.chatId,
      content: message.content,
      id: message.id,
      modelId: message.modelId,
      parentMessageId: message.parentMessageId,
      provider: message.provider,
      role: message.role,
      status: message.status
    }
  };
}
