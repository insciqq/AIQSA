import type { ChatSearchEligibilityFields } from "../eligibility";
import type { ChatSearchChatSnapshot, ChatSearchSourceMessage, ChatSearchTitleOrigin } from "./passages";

/** Synthetic chats for the indexer's unit tests; not imported by production code. */

export const ORDINARY: ChatSearchEligibilityFields = Object.freeze({
  discord: false, importSource: null, memoryMode: "NORMAL", permanentDeletionAt: null, scheduledTaskId: null, userId: "owner-1"
});

/** A title the owner set: search keeps it as it is. */
export const OWNER_TITLE: ChatSearchTitleOrigin = Object.freeze({ firstMessage: null, serverSet: false });

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute));

export type FixtureTurn = Readonly<{
  question: string;
  answer: string;
  status?: string;
  systemTurnKind?: string | null;
  scheduledTaskPrompt?: boolean;
  questionFiles?: readonly string[];
  answerFiles?: readonly string[];
}>;

export function text(value: string) {
  return { blocks: [{ text: value, type: "text" }] };
}

/** A chat whose active branch is `turns`, ids `<prefix>-q<n>` and `<prefix>-a<n>`. */
export function chatSnapshot(input: Readonly<{
  chatId?: string;
  title?: string;
  /** By default a title the owner set. */
  titleOrigin?: ChatSearchTitleOrigin;
  turns: readonly FixtureTurn[];
  eligibility?: Partial<ChatSearchEligibilityFields>;
  prefix?: string;
}>): ChatSearchChatSnapshot {
  const prefix = input.prefix ?? "m";
  const path: ChatSearchSourceMessage[] = [];
  const fileNames = new Map<string, readonly string[]>();
  let parent: string | null = null;
  input.turns.forEach((turn, index) => {
    const questionId = `${prefix}-q${index}`;
    const answerId = `${prefix}-a${index}`;
    path.push({
      content: text(turn.question), createdAt: at(index * 2),
      id: questionId, parentMessageId: parent, role: "user", scheduledTaskPrompt: turn.scheduledTaskPrompt ?? false,
      status: "complete", systemTurnKind: turn.systemTurnKind ?? null
    });
    path.push({
      content: text(turn.answer), createdAt: at(index * 2 + 1),
      id: answerId, parentMessageId: questionId, role: "assistant", scheduledTaskPrompt: false,
      status: turn.status ?? "complete", systemTurnKind: null
    });
    if (turn.questionFiles) fileNames.set(questionId, turn.questionFiles);
    if (turn.answerFiles) fileNames.set(answerId, turn.answerFiles);
    parent = answerId;
  });
  return {
    activeLeafMessageId: path.at(-1)?.id ?? null,
    chatId: input.chatId ?? "chat-1",
    eligibility: { ...ORDINARY, ...input.eligibility },
    fileNames,
    path,
    title: input.title ?? "Trip planning",
    titleOrigin: input.titleOrigin ?? OWNER_TITLE
  };
}

/** A long answer of numbered sentences, so every window can be told apart. */
export function longAnswer(sentences: number): string {
  return Array.from({ length: sentences }, (_, index) =>
    `Sentence ${index + 1} explains step ${index + 1} of the itinerary in plain words.`).join(" ");
}
