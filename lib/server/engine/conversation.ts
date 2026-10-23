import { textFromContentBlocks } from "../../domain/modelRunEvents";
import type { ProviderConversationMessage } from "../providers/types";
import type { TranscriptItem } from "./transcript";

/**
 * The conversation a native run starts from, as transcript items: the
 * branch admission froze (earlier turns, the run's internal context such as
 * the Skills index, then the run's own message), with every earlier answer of
 * a native run replaced by that run's own items. Earlier answers of the old
 * core, and a native answer stopped before its first round completed, enter
 * as their saved text; old-core tool steps are not fed again. A native answer
 * that stopped without text enters as its run's items too, once
 * `withStoppedNativeAnswers` has put it back on the branch. A turn the
 * server wrote after an approval that a native run continued is no user
 * speech: the approved call's result continues that turn instead. A user
 * message is `msg-<messageId>` in its own run and in every later one, so a
 * compaction's kept tail can start there and still be found when later runs
 * rebuild the conversation; run context items (`ctx-<index>`, the turn
 * context `ctx-turn`, all `runContext`) are rebuilt for every run.
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
    if (message.purpose !== undefined) {
      // Internal context (Skills index or instructions) is run-scoped input, never compacted.
      if (text.trim()) items.push({ id: `ctx-${index}`, kind: "user", runContext: true, text });
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
    if (native && native.length > 0) {
      items.push(...native);
      continue;
    }
    if (text.trim()) items.push({ id: `msg-${message.id}`, kind: "assistant_text", text });
  }
  if (source.current.mode === "continuation") return { currentInputId: null, items };
  const currentInputId = `msg-${source.current.messageId}`;
  items.push({ id: currentInputId, kind: "user", text: textFromContentBlocks(last.content) });
  return { currentInputId, items };
}

/**
 * The branch with each native answer that stopped without text back in its
 * place, as an empty answer just before the turn that follows it (and before
 * the run's internal context when that turn is the run's own), so its run's
 * items enter `buildRunConversation` where the answer stood. The context
 * leaves such an answer out (`conversationMessagesFromPathRows`); one whose
 * next turn is not on the branch, or that is on it already, is left as is.
 */
export function withStoppedNativeAnswers(messages: readonly ProviderConversationMessage[],
  stopped: readonly Readonly<{ assistantMessageId: string; nextUserMessageId: string }>[]): ProviderConversationMessage[] {
  const present = new Set(messages.map((message) => message.id));
  const before = new Map<number, ProviderConversationMessage[]>();
  for (const answer of stopped) {
    if (present.has(answer.assistantMessageId)) continue;
    let at = messages.findIndex((message) => message.id === answer.nextUserMessageId && message.role === "user" &&
      message.purpose === undefined && message.contextTurnId === undefined);
    if (at < 0) continue;
    while (at > 0 && messages[at - 1]!.purpose !== undefined) at -= 1;
    present.add(answer.assistantMessageId);
    before.set(at, [...(before.get(at) ?? []), { content: { blocks: [] }, id: answer.assistantMessageId, role: "assistant" }]);
  }
  if (before.size === 0) return [...messages];
  return messages.flatMap((message, index) => [...(before.get(index) ?? []), message]);
}

/**
 * The run context item with what holds only for this run, its time and turn
 * guidance (`systemPrompt.ts`), so the system prompt before it stays the same
 * across the chat's turns. Rebuilt for every run and never recorded.
 */
export function turnContextItem(text: string): TranscriptItem {
  return { id: "ctx-turn", kind: "user", runContext: true, text };
}

/** Where the turn context goes: after the run's other context, just before its input; last in an approval continuation. */
export function turnContextIndex(items: readonly TranscriptItem[], currentInputId: string | null): number {
  const at = currentInputId ? items.findIndex((item) => item.id === currentInputId) : -1;
  return at < 0 ? items.length : at;
}
