import { describe, expect, it } from "vitest";
import { readPastChatResultSchema, type ReadPastChatInput } from "../../../contracts/pastChats";
import { chatSearchEligible, type ChatSearchEligibilityFields } from "../eligibility";
import { OWNER_TITLE } from "../index/indexer.testFixtures";
import {
  createPastChatReader,
  createPrismaPastChatReadStore,
  type PastChatMessageSource,
  type PastChatReadOutcome,
  type PastChatReadStore
} from "./read";

const OWNER = "owner-1";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 9, minute));

function readOk(outcome: PastChatReadOutcome) {
  if (outcome.kind !== "read") throw new Error(`expected a read, got ${outcome.kind}`);
  expect(readPastChatResultSchema.safeParse(outcome.result).success).toBe(true);
  return outcome.result;
}

/** A linear chat of `count` messages, user and assistant in turn, with `size` characters of text each. */
function linearStore(count: number, size: number, overrides: Partial<PastChatReadStore> = {}): PastChatReadStore {
  const messages: PastChatMessageSource[] = Array.from({ length: count }, (_, index) => ({ attachments: [], createdAt: at(index),
    generatedFiles: [], id: `m${index}`, role: index % 2 === 0 ? "user" : "assistant", text: `message ${index} ${"x".repeat(size)}`, tools: [] }));
  return {
    branch: async (ownerId, chatId) => ownerId === OWNER && chatId === "chat-1"
      ? { chatId, messages: messages.map(({ id, role }) => ({ id, role })), title: "Long chat", titleOrigin: OWNER_TITLE } : null,
    messages: async (_ownerId, _chatId, ids) => messages.filter((message) => ids.includes(message.id)),
    switches: async () => ({ memoryEnabled: true, pastChatSearchEnabled: true }),
    ...overrides
  };
}

function read(store: PastChatReadStore, input: Partial<ReadPastChatInput>, savedValues: readonly string[] = []) {
  return createPastChatReader({ savedSecretValues: async () => savedValues, store })
    .read({ input: { chat_id: "chat-1", ...input }, ownerId: OWNER, timeZone: "UTC" });
}

const ids = (messages: readonly { messageId: string }[]) => messages.map((message) => message.messageId);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `m${from + index}`);

describe("read_past_chat windows", () => {
  it("pages through a long chat forward and back with cursors", async () => {
    const store = linearStore(50, 600);
    const first = readOk(await read(store, {}));
    expect(ids(first.messages)).toEqual(range(0, 20));
    expect(first).toMatchObject({ chatId: "chat-1", chatTitle: "Long chat", hasEarlier: false, hasLater: true });
    const second = readOk(await read(store, { after_message_id: "m19" }));
    expect(ids(second.messages)).toEqual(range(20, 40));
    expect(second).toMatchObject({ hasEarlier: true, hasLater: true });
    const last = readOk(await read(store, { after_message_id: "m39" }));
    expect(ids(last.messages)).toEqual(range(40, 50));
    expect(last).toMatchObject({ hasEarlier: true, hasLater: false });
    const back = readOk(await read(store, { before_message_id: "m20" }));
    expect(ids(back.messages)).toEqual(range(0, 20));
    const end = readOk(await read(store, { after_message_id: "m49" }));
    expect(end).toMatchObject({ hasEarlier: true, hasLater: false, messages: [] });
  });

  it("opens around a message with a little context before it", async () => {
    const result = readOk(await read(linearStore(50, 600), { around_message_id: "m30" }));
    expect(ids(result.messages)).toEqual(range(28, 48));
    // Near the end, the rest of the room goes to earlier messages.
    const nearEnd = readOk(await read(linearStore(50, 600), { around_message_id: "m48" }));
    expect(ids(nearEnd.messages)).toEqual(range(30, 50));
    expect(nearEnd).toMatchObject({ hasEarlier: true, hasLater: false });
  });

  it("clips long messages and holds as many as fit one tool result", async () => {
    const result = readOk(await read(linearStore(10, 9_000), {}));
    expect(result.messages.length).toBeGreaterThan(1);
    expect(result.messages.length).toBeLessThan(10);
    expect(result.messages.every((message) => message.clipped && message.text.length <= 6_000)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_000);
    expect(result.hasLater).toBe(true);
  });

  it("answers a message off the branch apart from a chat it cannot see, and refuses when off or failing", async () => {
    expect(await read(linearStore(4, 10), { around_message_id: "elsewhere" })).toEqual({ kind: "message_not_found" });
    expect(await read(linearStore(4, 10), { chat_id: "chat-2" })).toEqual({ kind: "chat_not_found" });
    const off = linearStore(4, 10, { switches: async () => ({ memoryEnabled: true, pastChatSearchEnabled: false }) });
    expect(await read(off, {})).toEqual({ kind: "disabled" });
    const failing = linearStore(4, 10, { branch: async () => {
      throw new Error("database down");
    } });
    expect(await read(failing, {})).toEqual({ kind: "failed" });
  });

  it("redacts recognized and saved secrets in texts and names", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const saved = "saved-value-1234567890-xyz";
    const store = linearStore(1, 1, { messages: async () => [{ attachments: [`key-${saved}.txt`, "brief.pdf", "brief.pdf"], createdAt: at(0),
      generatedFiles: [], id: "m0", role: "user", text: `Use ${secret} and ${saved}`, tools: [] }] });
    const result = readOk(await read(store, {}, [saved]));
    const text = JSON.stringify(result);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(saved);
    expect(result.messages[0]!.attachments).toEqual(["key-[REDACTED:SAVED_SECRET].txt", "brief.pdf"]);
  });
});

type SeedMessage = Readonly<{ id: string; parentMessageId: string | null; role: string; text?: string; systemTurnKind?: string;
  blocks?: readonly unknown[]; minute: number }>;

type ExcludedRow = Readonly<{ chatId: string; messageId: string; userId: string }>;

/** Enough of Prisma for the read store: rows filtered by the fields its queries name. */
type TitleGeneration = Readonly<{ status: string; titleRevision: number }> | null;

function fakeDb(input: Readonly<{
  chats: readonly (ChatSearchEligibilityFields & { id: string; title: string; activeLeafMessageId: string | null;
    titleRevision?: number; titleGeneration?: TitleGeneration })[];
  messages: readonly (SeedMessage & { chatId: string })[];
  attachments?: readonly { id: string; chatId: string; fileName: string; origin: string; producerModelRunId: string | null }[];
  runs?: readonly { id: string; chatId: string; assistantMessageId: string | null }[];
  calls?: readonly { modelRunId: string; toolName: string }[];
  excluded?: readonly ExcludedRow[];
}>) {
  const inList = (filter: unknown, value: unknown) => !filter || (filter as { in: unknown[] }).in.includes(value);
  return {
    attachment: { findMany: async ({ where }: { where: Record<string, unknown> }) => (input.attachments ?? []).filter((row) =>
      (where.chatId === undefined || row.chatId === where.chatId) && inList(where.id, row.id) &&
      inList(where.producerModelRunId, row.producerModelRunId) && (!where.origin || row.origin !== "USER_UPLOAD")) },
    chatSearchExcludedMessage: {
      findFirst: async ({ where }: { where: { chatId: string } }) => {
        const row = (input.excluded ?? []).find((excluded) => excluded.chatId === where.chatId);
        return row ? { messageId: row.messageId } : null;
      },
      findMany: async ({ where }: { where: { chatId: string; userId: string } }) => (input.excluded ?? [])
        .filter((row) => row.chatId === where.chatId && row.userId === where.userId).map(({ messageId }) => ({ messageId }))
    },
    chat: { findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
      const found = input.chats.find((row) => row.id === where.id);
      return found && chatSearchEligible(found, where.userId)
        ? { activeLeafMessageId: found.activeLeafMessageId, id: found.id, title: found.title,
          titleGeneration: found.titleGeneration ?? null, titleRevision: found.titleRevision ?? 0 } : null;
    } },
    message: {
      // The chat's first user message: the seeds are in time order.
      findFirst: async ({ where }: { where: { chatId: string; role: string } }) => {
        const first = input.messages.find((row) => row.chatId === where.chatId && row.role === where.role);
        return first ? { content: { blocks: first.text ? [{ text: first.text, type: "text" }] : [] } } : null;
      },
      findMany: async ({ where }: { where: { chatId: string; id?: { in: string[] } } }) => input.messages
      .filter((row) => row.chatId === where.chatId && inList(where.id, row.id))
      .map((row) => ({ branchSourceModelRunId: null, chatId: row.chatId,
        content: { blocks: [...(row.text ? [{ text: row.text, type: "text" }] : []), ...(row.blocks ?? [])] }, createdAt: at(row.minute),
        id: row.id, parentMessageId: row.parentMessageId, role: row.role, scheduledTaskPrompt: false, status: "complete",
        systemTurnKind: row.systemTurnKind ?? null })) },
    modelRun: { findMany: async ({ where }: { where: { OR: Array<{ assistantMessageId?: { in: string[] } }> } }) => (input.runs ?? [])
      .filter((run) => where.OR.some((clause) => clause.assistantMessageId?.in.includes(run.assistantMessageId ?? ""))) },
    modelRunToolCall: { findMany: async ({ where }: { where: { modelRunId: { in: string[] } } }) => (input.calls ?? [])
      .filter((call) => where.modelRunId.in.includes(call.modelRunId)) },
    userSettings: { findUnique: async () => null }
  };
}

describe("read_past_chat over the stored chat", () => {
  const chat = { activeLeafMessageId: "a3", discord: false, id: "chat-1", importSource: null, memoryMode: "NORMAL" as const,
    permanentDeletionAt: null, scheduledTaskId: null, title: "Quarter close", userId: OWNER };
  const messages = [
    { id: "u1", minute: 0, parentMessageId: null, role: "user", text: "Prepare the close checklist",
      blocks: [{ attachmentId: "att-1", type: "file" }, { attachmentId: "gone", fileName: "old-notes.txt", type: "file" }] },
    { id: "a1", minute: 1, parentMessageId: "u1", role: "assistant", text: "Here is the checklist." },
    { id: "u2", minute: 2, parentMessageId: "a1", role: "user", text: "Version before the edit" },
    { id: "a2", minute: 3, parentMessageId: "u2", role: "assistant", text: "Old answer" },
    { id: "u2e", minute: 4, parentMessageId: "a1", role: "user", text: "Edited question" },
    { id: "a2e", minute: 5, parentMessageId: "u2e", role: "assistant", text: "Answer to the edit" },
    { id: "wake", minute: 6, parentMessageId: "a2e", role: "user", systemTurnKind: "subagent_callback", text: "Callback from a sub-agent" },
    { id: "a3", minute: 7, parentMessageId: "wake", role: "assistant", text: "Follow-up after the sub-agent" }
  ].map((message) => ({ ...message, chatId: "chat-1" }));
  type TitleFields = Readonly<{ title?: string; titleRevision?: number; titleGeneration?: TitleGeneration }>;
  const db = (excluded: readonly ExcludedRow[] = [], titled: TitleFields = {}) => fakeDb({
    excluded,
    attachments: [{ chatId: "chat-1", fileName: "brief.pdf", id: "att-1", origin: "USER_UPLOAD", producerModelRunId: null },
      { chatId: "chat-1", fileName: "checklist.xlsx", id: "out-1", origin: "WORKSPACE_EXPORT", producerModelRunId: "run-1" }],
    calls: [{ modelRunId: "run-1", toolName: "web_search" }, { modelRunId: "run-1", toolName: "fetch_url" }, { modelRunId: "run-1", toolName: "web_search" }],
    chats: [{ ...chat, ...titled }, { ...chat, id: "chat-x", memoryMode: "EXCLUDED" }, { ...chat, id: "chat-foreign", userId: "owner-2" }],
    messages: [...messages, ...messages.map((message) => ({ ...message, chatId: "chat-x" })),
      ...messages.map((message) => ({ ...message, chatId: "chat-foreign" }))],
    runs: [{ assistantMessageId: "a1", chatId: "chat-1", id: "run-1" }]
  });
  const reader = (excluded: readonly ExcludedRow[] = [], titled: TitleFields = {}, savedValues: readonly string[] = []) =>
    createPastChatReader({ savedSecretValues: async () => savedValues,
      store: createPrismaPastChatReadStore(db(excluded, titled) as unknown as Parameters<typeof createPrismaPastChatReadStore>[0]) });

  it("follows the active branch, leaves server-written turns out and names files and tools", async () => {
    const result = readOk(await reader().read({ input: { chat_id: "chat-1" }, ownerId: OWNER, timeZone: "UTC" }));
    expect(ids(result.messages)).toEqual(["u1", "a1", "u2e", "a2e", "a3"]);
    expect(result.messages[0]).toMatchObject({ attachments: ["brief.pdf", "old-notes.txt"], date: "2026-11-01T09:00:00Z", role: "user",
      text: "Prepare the close checklist" });
    expect(result.messages[1]).toMatchObject({ generatedFiles: ["checklist.xlsx"], role: "assistant", tools: ["web_search", "fetch_url"] });
    expect(result).toMatchObject({ chatTitle: "Quarter close", hasEarlier: false, hasLater: false });
  });

  it("refuses a message of an older branch and answers a foreign or excluded chat like a missing one", async () => {
    expect(await reader().read({ input: { around_message_id: "u2", chat_id: "chat-1" }, ownerId: OWNER, timeZone: "UTC" }))
      .toEqual({ kind: "message_not_found" });
    const missing = await reader().read({ input: { chat_id: "chat-missing" }, ownerId: OWNER, timeZone: "UTC" });
    expect(missing).toEqual({ kind: "chat_not_found" });
    expect(await reader().read({ input: { chat_id: "chat-x" }, ownerId: OWNER, timeZone: "UTC" })).toEqual(missing);
    expect(await reader().read({ input: { chat_id: "chat-foreign" }, ownerId: OWNER, timeZone: "UTC" })).toEqual(missing);
    expect(await reader().read({ input: { chat_id: "chat-1" }, ownerId: "owner-2", timeZone: "UTC" })).toEqual(missing);
  });

  it("never shows a message the old Memory kept out, and still follows the branch through it", async () => {
    // The first turn was written before the chat's old Resume, so both its messages stay out; another owner's row for
    // this chat (which the keys refuse anyway) hides nothing.
    const kept = reader([{ chatId: "chat-1", messageId: "u1", userId: OWNER }, { chatId: "chat-1", messageId: "a1", userId: OWNER },
      { chatId: "chat-1", messageId: "u2e", userId: "owner-2" }]);
    const result = readOk(await kept.read({ input: { chat_id: "chat-1" }, ownerId: OWNER, timeZone: "UTC" }));
    expect(ids(result.messages)).toEqual(["u2e", "a2e", "a3"]);
    expect(result).toMatchObject({ hasEarlier: false, hasLater: false });
    expect(JSON.stringify(result)).not.toMatch(/close checklist|brief\.pdf|checklist\.xlsx/u);
    // Named by id, it answers as a message of another branch does.
    expect(await kept.read({ input: { around_message_id: "u1", chat_id: "chat-1" }, ownerId: OWNER, timeZone: "UTC" }))
      .toEqual({ kind: "message_not_found" });
    const before = readOk(await kept.read({ input: { before_message_id: "a2e", chat_id: "chat-1" }, ownerId: OWNER, timeZone: "UTC" }));
    expect(ids(before.messages)).toEqual(["u2e"]);
    expect(before.hasEarlier).toBe(false);
  });

  it("withholds the whole turn when only one of its messages was kept out, as the indexer does", async () => {
    const shown = async (excluded: readonly string[], input: Partial<ReadPastChatInput> = {}) => {
      const outcome = await reader(excluded.map((messageId) => ({ chatId: "chat-1", messageId, userId: OWNER })))
        .read({ input: { chat_id: "chat-1", ...input }, ownerId: OWNER, timeZone: "UTC" });
      return outcome.kind === "read" ? ids(outcome.result.messages) : outcome.kind;
    };
    // The answer repeats a forgotten question's words, so it stays out with it; the walk goes on to later turns.
    expect(await shown(["u1"])).toEqual(["u2e", "a2e", "a3"]);
    expect(await shown(["a2e"])).toEqual(["u1", "a1", "a3"]);
    // An answer to a server-written turn the read omits still belongs to that turn.
    expect(await shown(["wake"])).toEqual(["u1", "a1", "u2e", "a2e"]);
    expect(await shown(["u1"], { around_message_id: "a1" })).toBe("message_not_found");
    expect(await shown(["u1"], { after_message_id: "u2e" })).toEqual(["a2e", "a3"]);
  });

  it("names the chat by its search title, as its passages do", async () => {
    const titleOf = async (excluded: readonly string[], titled: TitleFields, savedValues: readonly string[] = []) => readOk(await reader(
      excluded.map((messageId) => ({ chatId: "chat-1", messageId, userId: OWNER })), titled, savedValues)
      .read({ input: { chat_id: "chat-1" }, ownerId: OWNER, timeZone: "UTC" })).chatTitle;
    const fallback = { title: "Prepare the close checklist" };
    // While the chat holds any message kept out of search, no title is shown: made from the first line, by the title
    // model, or by the owner, and whichever message is kept out.
    expect(await titleOf(["u1"], fallback)).toBe("Untitled chat");
    expect(await titleOf(["a1"], fallback)).toBe("Untitled chat");
    expect(await titleOf(["u1"], { title: "Close checklist", titleGeneration: { status: "settled", titleRevision: 0 }, titleRevision: 1 }))
      .toBe("Untitled chat");
    expect(await titleOf(["u1"], { titleRevision: 1 })).toBe("Untitled chat");
    expect(await titleOf(["a2e"], { titleGeneration: { status: "settled", titleRevision: 0 }, titleRevision: 2 })).toBe("Untitled chat");
    // Without such a message the owner's own title stays, whether renamed before or after the title model named the chat.
    expect(await titleOf([], { titleRevision: 1 })).toBe("Quarter close");
    expect(await titleOf([], { titleGeneration: { status: "settled", titleRevision: 0 }, titleRevision: 2 })).toBe("Quarter close");
    expect(await titleOf([], fallback)).toBe("Prepare the close checklist");
    // A saved value in the first line is screened in the title made from it.
    expect(await titleOf([], fallback, ["close checklist"])).toBe("Prepare the [REDACTED:SAVED_SECRET]");
  });
});
