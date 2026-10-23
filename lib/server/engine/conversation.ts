import { textFromContentBlocks } from "../../domain/modelRunEvents";
import type { ProviderConversationMessage } from "../providers/types";
import type { TranscriptItem } from "./transcript";

/**
 * The conversation a native run starts from, as transcript items: the
 * branch admission froze (earlier turns, the run's internal context such as
 * the Skills index, then the run's own message), with every earlier answer of
 * a native run replaced by that run's own items. Earlier answers of the old
 * core enter as their text; their tool steps are not fed again. A turn the
 * server wrote after an approval that a native run continued is no user
 * speech: the approved call's result continues that turn instead.
 */
export type ConversationSource = Readonly<{
  /** Approval continuation turns among the branch's user messages. */
  continuationTurns: ReadonlySet<string>;
  /**
   * The run's own message, last in `messages`: `input` enters it as the
   * current user input (with the run's attachments), `continuation` (an
   * approval continuation) enters nothing.
   */
  current: Readonly<{ messageId: string; mode: "continuation" | "input" }>;
  /** The prepared branch (`NormalizedRunRequest.context.messages`). */
  messages: readonly ProviderConversationMessage[];
  /** Earlier native answers' items, by the assistant message they answered. */
  nativeAnswers: ReadonlyMap<string, readonly TranscriptItem[]>;
}>;

export type RunConversation = Readonly<{
  /** The current user input's item id, rendered with the run's attachments; null for a continuation. */
  currentInputId: string | null;
  items: TranscriptItem[];
}>;

export function buildRunConversation(source: ConversationSource): RunConversation {
  const items: TranscriptItem[] = [];
  const messages = source.messages;
  const last = messages.at(-1);
  if (!last || last.role !== "user" || last.purpose !== undefined) throw new Error("conversation_current_message_missing");
  for (let index = 0; index < messages.length - 1; index += 1) {
    const message = messages[index]!;
    const text = textFromContentBlocks(message.content);
    if (message.purpose !== undefined || message.historyClass !== undefined) {
      // Internal context (Skills index or instructions) is run-scoped input.
      if (message.historyClass === undefined && text.trim()) items.push({ id: `ctx-${index}`, kind: "user", text });
      continue;
    }
    if (message.role === "user") {
      const next = messages[index + 1];
      const continued = next?.role === "assistant" && source.nativeAnswers.has(next.id);
      if (source.continuationTurns.has(message.id) && continued) continue;
      if (text.trim()) items.push({ id: `msg-${message.id}`, kind: "user", text });
      continue;
    }
    const native = source.nativeAnswers.get(message.id);
    if (native) {
      items.push(...native);
      continue;
    }
    if (text.trim()) items.push({ id: `msg-${message.id}`, kind: "assistant_text", text });
  }
  if (source.current.mode === "continuation") return { currentInputId: null, items };
  items.push({ id: source.current.messageId, kind: "user", text: textFromContentBlocks(last.content) });
  return { currentInputId: source.current.messageId, items };
}
