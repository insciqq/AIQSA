import type { Prisma } from "@prisma/client";
import {
  clipPastChatLine,
  clipPastChatText,
  PAST_CHATS_LIMITS,
  pastChatMessageSchema,
  type PastChatMessage,
  type ReadPastChatInput,
  type ReadPastChatResult
} from "../../../contracts/pastChats";
import { chatExportAttachmentIds } from "../../../domain/chatExportDocument";
import { chatExportText } from "../../../domain/chatExport";
import { omitSubagentCallbackTurns } from "../../../domain/subagentCallbackTurns";
import { quietCheckOmission } from "../../chats/quietScheduledChecks";
import { chatSearchEligibleWhere } from "../eligibility";
import { chatSearchWithheldMessages } from "../index/exclusions";
import { pastChatTimestamp } from "./dates";
import { pastChatTitle, redactPastChatText, type SavedSecretValuesReader } from "./redaction";
import { readPastChatSwitches, type PastChatSwitches } from "./store";

/**
 * `read_past_chat`: a bounded window of one past chat's current active branch,
 * read from the messages themselves, never from the index, so the agent sees
 * what was actually said and done. The branch reads as the chat's history
 * and exports read it: quiet scheduled checks and server-written turns
 * (sub-agent wake-ups, Sign in again requests) left out. A message shows its redacted
 * text, the names of the files the user attached and the answer generated,
 * and the tools the answer called, by name only: never arguments, results or
 * file contents. Only the owner's own eligible chats are read
 * (`lib/server/chatSearch/eligibility.ts`); a chat the caller cannot see and
 * a missing one answer the same. A message search never holds
 * (`ChatSearchExcludedMessage`, the old Memory's exclusions) is left out like
 * a message of another branch, and so is the other message of its turn
 * (`chatSearchWithheldMessages`), as the indexer leaves the whole turn out.
 */

/** The JSON of a window stays within the engine's inline tool result with its note beside it. */
export const PAST_CHAT_READ_JSON_CHARS = 20_000;
/** Messages a window shows before the one it opens around, when they fit. */
const CONTEXT_BEFORE = 2;

export type PastChatBranchNode = Readonly<{ id: string; role: "user" | "assistant" }>;

export type PastChatBranch = Readonly<{ chatId: string; title: string; messages: readonly PastChatBranchNode[] }>;

/** One message as stored, before redaction and bounds. */
export type PastChatMessageSource = Readonly<{
  id: string;
  role: "user" | "assistant";
  createdAt: Date;
  text: string;
  attachments: readonly string[];
  generatedFiles: readonly string[];
  tools: readonly string[];
}>;

export type PastChatReadStore = Readonly<{
  switches(ownerId: string): Promise<PastChatSwitches>;
  /** The chat's title and active branch, root first, when it is one of the owner's eligible chats; null otherwise. */
  branch(ownerId: string, chatId: string): Promise<PastChatBranch | null>;
  /** These messages of the chat, in no order; a message that is gone is left out. */
  messages(ownerId: string, chatId: string, ids: readonly string[]): Promise<PastChatMessageSource[]>;
}>;

export type PastChatReadOutcome =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "chat_not_found" }>
  /** The chat is the owner's, but the message is not on its current branch. */
  | Readonly<{ kind: "message_not_found" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "read"; result: ReadPastChatResult }>;

export type PastChatReadRequest = Readonly<{
  ownerId: string;
  timeZone: string;
  input: ReadPastChatInput;
  signal?: AbortSignal;
}>;

export type PastChatReader = Readonly<{ read(request: PastChatReadRequest): Promise<PastChatReadOutcome> }>;

function unique(values: readonly string[], maximum: number, savedValues: readonly string[]): string[] {
  const kept: string[] = [];
  for (const value of values) {
    const line = clipPastChatLine(redactPastChatText(value, savedValues), maximum);
    if (line && !kept.includes(line)) kept.push(line);
    if (kept.length >= PAST_CHATS_LIMITS.readNamesPerMessage) break;
  }
  return kept;
}

/** A stored message as a read shows it: redacted, clipped and named; null when it does not decode. */
export function pastChatMessage(source: PastChatMessageSource, savedValues: readonly string[], timeZone: string): PastChatMessage | null {
  const text = redactPastChatText(source.text, savedValues).replaceAll("\0", "");
  const clipped = text.length > PAST_CHATS_LIMITS.readMessageChars;
  const decoded = pastChatMessageSchema.safeParse({
    attachments: unique(source.attachments, PAST_CHATS_LIMITS.fileNameChars, savedValues),
    clipped,
    date: pastChatTimestamp(source.createdAt, timeZone),
    generatedFiles: unique(source.generatedFiles, PAST_CHATS_LIMITS.fileNameChars, savedValues),
    messageId: source.id,
    role: source.role,
    text: clipped ? clipPastChatText(text, PAST_CHATS_LIMITS.readMessageChars) : text,
    tools: unique(source.tools, PAST_CHATS_LIMITS.toolNameChars, savedValues)
  });
  return decoded.success ? decoded.data : null;
}

type Anchor = Readonly<{ kind: "start" }> | Readonly<{ kind: "around" | "after" | "before"; index: number }>;

/** The branch positions whose messages a window may hold, around its anchor. */
function candidateSpan(anchor: Anchor, length: number): Readonly<{ from: number; to: number }> {
  const most = PAST_CHATS_LIMITS.readWindowMessages;
  switch (anchor.kind) {
    case "start": return { from: 0, to: Math.min(length, most) };
    case "after": return { from: anchor.index + 1, to: Math.min(length, anchor.index + 1 + most) };
    case "before": return { from: Math.max(0, anchor.index - most), to: anchor.index };
    case "around": return { from: Math.max(0, anchor.index - most), to: Math.min(length, anchor.index + most) };
  }
}

/**
 * The window as branch positions, within the read's bounds: forward from the
 * start or after a message, backward before one, and around one with up to
 * two messages before it, then what follows, then earlier ones if room is left.
 */
function fitWindow(anchor: Anchor, span: Readonly<{ from: number; to: number }>, size: (index: number) => number | null,
  base: number): readonly number[] {
  const kept = new Set<number>();
  let total = base;
  /** False once the window is full; a message that is gone takes no room and ends nothing. */
  const add = (index: number): boolean => {
    const bytes = size(index);
    if (bytes === null) return true;
    if (kept.size >= PAST_CHATS_LIMITS.readWindowMessages || total + bytes > PAST_CHAT_READ_JSON_CHARS) return false;
    kept.add(index);
    total += bytes;
    return true;
  };
  const forward = (from: number) => {
    for (let index = from; index < span.to; index += 1) if (!add(index)) break;
  };
  const backward = (from: number) => {
    for (let index = from; index >= span.from; index -= 1) if (!add(index)) break;
  };
  if (anchor.kind === "start") forward(0);
  else if (anchor.kind === "after") forward(anchor.index + 1);
  else if (anchor.kind === "before") backward(anchor.index - 1);
  else {
    add(anchor.index);
    for (let index = anchor.index - 1; index >= Math.max(span.from, anchor.index - CONTEXT_BEFORE); index -= 1) if (!add(index)) break;
    forward(anchor.index + 1);
    backward(Math.min(...kept, anchor.index) - 1);
  }
  return [...kept].sort((left, right) => left - right);
}

export function createPastChatReader(dependencies: Readonly<{ store: PastChatReadStore; savedSecretValues: SavedSecretValuesReader }>): PastChatReader {
  const { store } = dependencies;
  return Object.freeze({
    async read(request: PastChatReadRequest): Promise<PastChatReadOutcome> {
      request.signal?.throwIfAborted();
      try {
        const switches = await store.switches(request.ownerId);
        if (!switches.memoryEnabled || !switches.pastChatSearchEnabled) return { kind: "disabled" };
        const branch = await store.branch(request.ownerId, request.input.chat_id);
        request.signal?.throwIfAborted();
        if (!branch) return { kind: "chat_not_found" };
        const ids = branch.messages.map((message) => message.id);
        const input = request.input;
        const named = input.around_message_id ? { id: input.around_message_id, kind: "around" as const }
          : input.after_message_id ? { id: input.after_message_id, kind: "after" as const }
          : input.before_message_id ? { id: input.before_message_id, kind: "before" as const } : null;
        let anchor: Anchor = { kind: "start" };
        if (named) {
          const index = ids.indexOf(named.id);
          if (index < 0) return { kind: "message_not_found" };
          anchor = { index, kind: named.kind };
        }
        const span = candidateSpan(anchor, ids.length);
        const savedValues = await dependencies.savedSecretValues(request.ownerId);
        const sources = span.to > span.from ? await store.messages(request.ownerId, branch.chatId, ids.slice(span.from, span.to)) : [];
        request.signal?.throwIfAborted();
        const shown = new Map<number, PastChatMessage>();
        for (const source of sources) {
          const index = ids.indexOf(source.id);
          const message = index >= span.from && index < span.to ? pastChatMessage(source, savedValues, request.timeZone) : null;
          if (message) shown.set(index, message);
        }
        const chatTitle = pastChatTitle(branch.title, savedValues);
        const base = JSON.stringify({ chatId: branch.chatId, chatTitle, hasEarlier: false, hasLater: false, messages: [] }).length;
        const window = fitWindow(anchor, span, (index) => {
          const message = shown.get(index);
          return message ? JSON.stringify(message).length + 1 : null;
        }, base);
        const messages = window.flatMap((index) => shown.get(index) ?? []);
        // Earlier and later are about the branch, whether or not a message there could be shown.
        const first = window.length ? window[0]! : anchor.kind === "before" ? anchor.index : anchor.kind === "after" ? anchor.index + 1 : 0;
        const last = window.length ? window.at(-1)! + 1 : first;
        return { kind: "read", result: { chatId: branch.chatId, chatTitle, hasEarlier: first > 0, hasLater: last < ids.length, messages } };
      } catch (error) {
        if (request.signal?.aborted) throw error;
        return { kind: "failed" };
      }
    }
  });
}

type ReadDb = Pick<Prisma.TransactionClient,
  "attachment" | "chat" | "chatSearchExcludedMessage" | "message" | "modelRun" | "modelRunToolCall" | "userSettings">;

const branchSelect = {
  branchSourceModelRunId: true, id: true, parentMessageId: true, role: true, scheduledTaskPrompt: true, systemTurnKind: true
} satisfies Prisma.MessageSelect;

/** Bounds of what one window's names are read from. */
const MAX_TOOL_CALL_ROWS = 4_000;
const MAX_GENERATED_ROWS = 2_000;

export function createPrismaPastChatReadStore(db: ReadDb): PastChatReadStore {
  return Object.freeze({
    switches: (ownerId: string) => readPastChatSwitches(db, ownerId),

    async branch(ownerId: string, chatId: string): Promise<PastChatBranch | null> {
      const chat = await db.chat.findFirst({ select: { activeLeafMessageId: true, id: true, title: true },
        where: { ...chatSearchEligibleWhere(ownerId), id: chatId } });
      if (!chat) return null;
      const [rows, excluded] = await Promise.all([
        db.message.findMany({ select: branchSelect, where: { chatId: chat.id } }),
        db.chatSearchExcludedMessage.findMany({ select: { messageId: true }, where: { chatId: chat.id, userId: ownerId } })
      ]);
      // A turn search never holds is walked through, so the branch stays whole, but neither of its messages is shown.
      const hidden = new Set(excluded.map((row) => row.messageId));
      const stored = new Map(rows.map((row) => [row.id, row]));
      const quiet = await quietCheckOmission(db, chat.id, rows);
      const shown = rows.filter((row) => !quiet.removed.has(row.id))
        .map((row) => quiet.parents.has(row.id) ? { ...row, parentMessageId: quiet.parents.get(row.id) ?? null } : row);
      const wakeUps = omitSubagentCallbackTurns(shown.map((row) => ({ id: row.id, parentId: row.parentMessageId, role: row.role,
        systemTurnKind: row.systemTurnKind })));
      const kept = new Map(shown.filter((row) => !wakeUps.removed.has(row.id))
        .map((row) => [row.id, wakeUps.parents.has(row.id) ? { ...row, parentMessageId: wakeUps.parents.get(row.id) ?? null } : row]));
      const path: PastChatBranchNode[] = [];
      const seen = new Set<string>();
      for (let cursor = wakeUps.resolve(quiet.resolve(chat.activeLeafMessageId)); cursor !== null;) {
        const row = kept.get(cursor);
        if (!row || seen.has(cursor)) break;
        seen.add(cursor);
        if (row.role === "user" || row.role === "assistant") path.push({ id: row.id, role: row.role });
        cursor = row.parentMessageId;
      }
      const withheld = chatSearchWithheldMessages(path.map((node) => node.id), stored, hidden);
      return { chatId: chat.id, messages: path.reverse().filter((node) => !withheld.has(node.id)), title: chat.title };
    },

    async messages(ownerId: string, chatId: string, ids: readonly string[]): Promise<PastChatMessageSource[]> {
      if (ids.length === 0) return [];
      const rows = await db.message.findMany({ select: { branchSourceModelRunId: true, content: true, createdAt: true, id: true, role: true },
        where: { chat: { userId: ownerId }, chatId, id: { in: [...ids] } } });
      const messages = rows.filter((row): row is typeof row & { role: "user" | "assistant" } => row.role === "user" || row.role === "assistant");
      const blockIds = [...new Set(messages.flatMap((row) => chatExportAttachmentIds(row.content)))];
      const attachments = blockIds.length ? await db.attachment.findMany({ select: { fileName: true, id: true },
        where: { chatId, id: { in: blockIds } } }) : [];
      const attachmentNames = new Map(attachments.map((row) => [row.id, row.fileName]));
      const answers = messages.filter((row) => row.role === "assistant");
      const sourceRunIds = answers.flatMap((row) => row.branchSourceModelRunId ? [row.branchSourceModelRunId] : []);
      const runs = answers.length ? await db.modelRun.findMany({ select: { assistantMessageId: true, id: true },
        where: { subagentThreadId: null, userId: ownerId,
          OR: [{ assistantMessageId: { in: answers.map((row) => row.id) }, chatId }, ...(sourceRunIds.length ? [{ id: { in: sourceRunIds } }] : [])] } }) : [];
      const runIds = runs.map((run) => run.id);
      const [calls, outputs] = runIds.length ? await Promise.all([
        db.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }], select: { modelRunId: true, toolName: true },
          take: MAX_TOOL_CALL_ROWS, where: { modelRunId: { in: runIds }, subagentThreadId: null } }),
        db.attachment.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { fileName: true, producerModelRunId: true },
          take: MAX_GENERATED_ROWS, where: { origin: { not: "USER_UPLOAD" }, producerModelRunId: { in: runIds }, userId: ownerId } })
      ]) : [[], []];
      const runsOf = (row: (typeof messages)[number]) => new Set(runs.filter((run) => run.assistantMessageId === row.id ||
        run.id === row.branchSourceModelRunId).map((run) => run.id));
      return messages.map((row) => {
        const own = row.role === "assistant" ? runsOf(row) : new Set<string>();
        const blocks = blockNames(row.content, attachmentNames);
        return {
          attachments: row.role === "user" ? blocks : [],
          createdAt: row.createdAt,
          // A branch copy's answer carries its files as blocks of its own content.
          generatedFiles: row.role === "assistant"
            ? [...outputs.filter((output) => output.producerModelRunId !== null && own.has(output.producerModelRunId)).map((output) => output.fileName), ...blocks]
            : [],
          id: row.id,
          role: row.role,
          text: chatExportText(row.content),
          tools: calls.filter((call) => own.has(call.modelRunId)).map((call) => call.toolName)
        };
      });
    }
  });
}

/** The names of a message's file and image blocks: the attachment's current name, or the one its block recorded. */
function blockNames(content: unknown, names: ReadonlyMap<string, string>): string[] {
  if (typeof content !== "object" || content === null || !Array.isArray((content as { blocks?: unknown }).blocks)) return [];
  return ((content as { blocks: unknown[] }).blocks).flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const value = block as Record<string, unknown>;
    if ((value.type !== "file" && value.type !== "image") || typeof value.attachmentId !== "string") return [];
    const name = names.get(value.attachmentId) ?? (typeof value.fileName === "string" ? value.fileName : null);
    return name ? [name] : [];
  });
}
