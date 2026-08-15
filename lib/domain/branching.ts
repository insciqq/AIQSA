export type MessageRole = "assistant" | "system" | "tool" | "user";

export type BranchMessage = {
  id: string;
  parentMessageId: string | null;
  role: MessageRole;
};

export function getVisibleMessagePath<TMessage extends BranchMessage>(
  messages: TMessage[],
  activeLeafMessageId: string | null
): TMessage[] {
  if (!activeLeafMessageId) {
    return [];
  }

  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: TMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | null = activeLeafMessageId;

  while (cursor) {
    if (seen.has(cursor)) {
      throw new Error(`Cycle detected while reading branch path at message ${cursor}`);
    }

    const message = byId.get(cursor);
    if (!message) {
      throw new Error(`Active leaf message ${cursor} was not found`);
    }

    seen.add(cursor);
    path.push(message);
    cursor = message.parentMessageId;
  }

  return path.reverse();
}
