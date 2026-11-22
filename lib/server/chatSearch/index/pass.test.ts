import { describe, expect, it, vi } from "vitest";
import { ChatSearchEmbeddingError, type ChatSearchEmbedder, type ChatSearchEmbeddingModel, type ChatSearchEmbedRequest } from "../embedder";
import { chatSnapshot, longAnswer, type FixtureTurn } from "./indexer.testFixtures";
import type { ChatSearchChatSnapshot } from "./passages";
import { chatSearchRetryDelayMs, runChatSearchIndexPassOn } from "./pass";
import { planChatSearchPassages } from "./plan";
import type { ChatSearchClaim, ChatSearchIndexStore } from "./store";

vi.mock("../../observability", () => ({ logEvent: vi.fn() }));

const OWNER = "owner-1";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
const SAVED_VALUE = "tok_demo_7f3a9c21b8e4";

type StateRow = { userId: string; dirtyAt: Date | null; nextAttemptAt: Date | null; attemptCount: number; lastErrorCode: string | null };
type PassageRow = {
  id: string; chatId: string; userMessageId: string; assistantMessageId: string; ordinal: number; turnAt: Date;
  text: string; contentHash: string; embedding: readonly number[] | null; model: string | null;
};

/** The store's contract in memory: versions, leases and conditional writes as the PostgreSQL store keeps them. */
function memoryStore(clock: { now: Date }) {
  const chats = new Map<string, ChatSearchChatSnapshot>();
  const secrets = new Map<string, readonly string[]>();
  const states = new Map<string, StateRow>();
  const passages = new Map<string, PassageRow>();
  let sequence = 0;
  let tick = 0;
  const same = (row: StateRow | undefined, claim: ChatSearchClaim) => row?.dirtyAt?.getTime() === claim.dirtyAt.getTime();
  const mark = (chatId: string, priority: "now" | "background" = "now") => {
    const row = states.get(chatId) ?? { attemptCount: 0, dirtyAt: null, lastErrorCode: null, nextAttemptAt: null, userId: OWNER };
    tick += 1;
    const at = priority === "now" ? new Date(clock.now.getTime() + tick) : new Date(Date.UTC(2020, 0, 1) + tick);
    row.dirtyAt = row.dirtyAt && row.dirtyAt.getTime() >= at.getTime() ? new Date(row.dirtyAt.getTime() + 1) : at;
    row.nextAttemptAt = null;
    states.set(chatId, row);
  };
  const chatPassages = (chatId: string) => [...passages.values()].filter((row) => row.chatId === chatId)
    .sort((left, right) => left.userMessageId.localeCompare(right.userMessageId) || left.ordinal - right.ordinal);
  const store: ChatSearchIndexStore = {
    async claimDue({ leaseUntil, limit, now }) {
      const due = [...states.entries()]
        .filter(([, row]) => row.dirtyAt && (!row.nextAttemptAt || row.nextAttemptAt <= now))
        .sort(([, left], [, right]) => right.dirtyAt!.getTime() - left.dirtyAt!.getTime())
        .slice(0, limit);
      return due.map(([chatId, row]) => {
        row.nextAttemptAt = leaseUntil;
        return { attemptCount: row.attemptCount, chatId, dirtyAt: row.dirtyAt!, userId: row.userId };
      });
    },
    async loadSnapshot(chatId) { return chats.get(chatId) ?? null; },
    async loadSavedSecretValues(userId) { return secrets.get(userId) ?? []; },
    async reconcile(claim, target) {
      if (!chats.has(claim.chatId) || !states.has(claim.chatId)) return { kind: "gone" };
      if (!same(states.get(claim.chatId), claim)) return { kind: "stale" };
      if (target.kind === "clear") {
        states.delete(claim.chatId);
        for (const row of chatPassages(claim.chatId)) passages.delete(row.id);
        return { kind: "cleared" };
      }
      const plan = planChatSearchPassages(chatPassages(claim.chatId), target.passages);
      for (const id of plan.deletes) passages.delete(id);
      for (const update of plan.updates) {
        const row = passages.get(update.id)!;
        Object.assign(row, { assistantMessageId: update.assistantMessageId, contentHash: update.contentHash, text: update.text,
          turnAt: update.turnAt }, update.textChanged ? { embedding: null, model: null } : {});
      }
      for (const insert of plan.inserts) {
        sequence += 1;
        passages.set(`p${sequence}`, { ...insert, chatId: claim.chatId, embedding: null, id: `p${sequence}`, model: null });
      }
      return { deleted: plan.deletes.length, inserted: plan.inserts.length, kind: "applied", unchanged: plan.unchanged,
        updated: plan.updates.length };
    },
    async passagesToEmbed({ chatId, limit, providerModelId }) {
      return chatPassages(chatId).filter((row) => row.embedding === null || row.model !== providerModelId)
        .sort((left, right) => right.turnAt.getTime() - left.turnAt.getTime() || left.ordinal - right.ordinal)
        .slice(0, limit).map((row) => ({ contentHash: row.contentHash, id: row.id, text: row.text }));
    },
    async writeEmbeddings({ chatId, providerModelId, vectors }) {
      let written = 0;
      for (const entry of vectors) {
        const row = passages.get(entry.id);
        if (!row || row.chatId !== chatId || row.contentHash !== entry.contentHash) continue;
        row.embedding = entry.vector;
        row.model = providerModelId;
        written += 1;
      }
      return written;
    },
    async settle(claim, settlement) {
      const row = states.get(claim.chatId);
      if (!row || !same(row, claim)) return false;
      if (settlement.kind === "clean") Object.assign(row, { attemptCount: 0, dirtyAt: null, lastErrorCode: settlement.note, nextAttemptAt: null });
      else if (settlement.kind === "more") Object.assign(row, { attemptCount: 0, lastErrorCode: null, nextAttemptAt: null });
      else Object.assign(row, { attemptCount: row.attemptCount + 1, lastErrorCode: settlement.code, nextAttemptAt: settlement.retryAt });
      return true;
    }
  };
  return { chatPassages, chats, mark, passages, secrets, states, store };
}

function fakeEmbedder(initial: ChatSearchEmbeddingModel = { kind: "model", providerModelId: "embed-a" }) {
  const calls: ChatSearchEmbedRequest[] = [];
  const state = {
    failure: null as ChatSearchEmbeddingError | null,
    model: initial,
    /** Runs during the call, before its vectors return. */
    during: null as (() => void) | null
  };
  const embedder: ChatSearchEmbedder = {
    async currentModel() { return state.model; },
    async embed(request) {
      calls.push(request);
      state.during?.();
      if (state.failure) throw state.failure;
      return { dimension: 3, vectors: request.texts.map((value) => [value.length, 1, 0]) };
    }
  };
  const embeddedTexts = () => calls.flatMap((call) => call.texts);
  return { calls, embeddedTexts, embedder, state };
}

function setup(turns: readonly FixtureTurn[], snapshot: Partial<ChatSearchChatSnapshot> = {}) {
  const clock = { now: new Date(Date.UTC(2026, 10, 22, 12)) };
  const memory = memoryStore(clock);
  memory.chats.set("chat-1", { ...chatSnapshot({ turns }), ...snapshot });
  memory.mark("chat-1");
  const fake = fakeEmbedder();
  const run = (extra: Partial<Parameters<typeof runChatSearchIndexPassOn>[1]> = {}) =>
    runChatSearchIndexPassOn(memory.store, { embedder: fake.embedder, now: () => clock.now, ...extra });
  return { clock, fake, memory, run };
}

describe("the past-chat index pass", () => {
  it("indexes a multi-turn chat turn by turn, embeds every passage once in batches and leaves the chat clean", async () => {
    const { fake, memory, run } = setup([
      { answer: "The hotel near Termini.", question: "Which hotel?" },
      { answer: longAnswer(150), question: "Plan every day." }
    ]);
    const summary = await run();
    expect(summary).toMatchObject({ claimed: 1, failed: 0, indexed: 1, model: "model", more: false });
    const stored = memory.chatPassages("chat-1");
    expect(stored.filter((row) => row.userMessageId === "m-q0")).toHaveLength(1);
    expect(stored.filter((row) => row.userMessageId === "m-q1").length).toBeGreaterThan(2);
    expect(summary.embedded).toBe(stored.length);
    expect(stored.every((row) => row.model === "embed-a" && row.embedding !== null)).toBe(true);
    expect(fake.calls.every((call) => call.mode === "document" && call.latencyClass === "background" && call.userId === "owner-1")).toBe(true);
    expect(fake.embeddedTexts()).toHaveLength(stored.length);
    expect(memory.states.get("chat-1")).toMatchObject({ attemptCount: 0, dirtyAt: null, lastErrorCode: null, nextAttemptAt: null });
    // Nothing is due any more.
    expect(await run()).toMatchObject({ claimed: 0, more: false });
  });

  it("embeds only the new turn's passages after a new turn, and keeps the earlier ones searchable meanwhile", async () => {
    const turns: FixtureTurn[] = [{ answer: "First answer.", question: "First question" }];
    const { fake, memory, run } = setup(turns);
    await run();
    const before = memory.chatPassages("chat-1").map((row) => ({ ...row }));
    fake.calls.length = 0;
    memory.chats.set("chat-1", chatSnapshot({ turns: [...turns, { answer: "Second answer.", question: "Second question" }] }));
    memory.mark("chat-1");
    await run();
    expect(fake.embeddedTexts()).toEqual([expect.stringContaining("Second answer.")]);
    const after = memory.chatPassages("chat-1");
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.userMessageId === "m-q0")).toEqual(before[0]);
  });

  it("replaces exactly the passages of the changed path when a message is edited", async () => {
    const { fake, memory, run } = setup([
      { answer: "Answer one.", question: "Question one" },
      { answer: "Answer two.", question: "Question two" },
      { answer: "Answer three.", question: "Question three" }
    ]);
    await run();
    const kept = memory.chatPassages("chat-1").find((row) => row.userMessageId === "m-q0")!;
    fake.calls.length = 0;
    // The second question was edited: a new branch from the first answer replaces turns two and three.
    const edited = chatSnapshot({ prefix: "e", turns: [{ answer: "Answer two, edited.", question: "Question two, edited" }] });
    const original = memory.chats.get("chat-1")!;
    const path = [original.path[0]!, original.path[1]!, { ...edited.path[0]!, parentMessageId: "m-a0" }, edited.path[1]!];
    memory.chats.set("chat-1", { ...original, activeLeafMessageId: "e-a0", path });
    memory.mark("chat-1");
    await run();
    const after = memory.chatPassages("chat-1");
    expect(after.map((row) => row.userMessageId).sort()).toEqual(["e-q0", "m-q0"]);
    expect(after.find((row) => row.userMessageId === "m-q0")).toEqual(kept);
    expect(fake.embeddedTexts()).toEqual([expect.stringContaining("Answer two, edited.")]);
  });

  it.each([
    ["Excluded", { memoryMode: "EXCLUDED" as const }],
    ["Temporary", { memoryMode: "TEMPORARY" as const }],
    ["imported", { importSource: "CHATGPT" }],
    ["scheduled", { scheduledTaskId: "task-1" }],
    ["Discord", { discord: true }],
    ["fenced for permanent deletion", { permanentDeletionAt: new Date() }]
  ])("indexes nothing of a %s chat and drops what it had", async (_label, eligibility) => {
    const { fake, memory, run } = setup([{ answer: "Answer.", question: "Question" }]);
    await run();
    expect(memory.chatPassages("chat-1")).toHaveLength(1);
    const chat = memory.chats.get("chat-1")!;
    memory.chats.set("chat-1", { ...chat, eligibility: { ...chat.eligibility, ...eligibility } });
    memory.mark("chat-1");
    fake.calls.length = 0;
    expect(await run()).toMatchObject({ cleared: 1, indexed: 0 });
    expect(memory.chatPassages("chat-1")).toEqual([]);
    expect(memory.states.has("chat-1")).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("indexes a chat again once it resumes", async () => {
    const { memory, run } = setup([{ answer: "Answer.", question: "Question" }], {
      eligibility: { ...chatSnapshot({ turns: [] }).eligibility, memoryMode: "EXCLUDED" }
    });
    await run();
    expect(memory.chatPassages("chat-1")).toEqual([]);
    memory.chats.set("chat-1", chatSnapshot({ turns: [{ answer: "Answer.", question: "Question" }] }));
    memory.mark("chat-1");
    await run();
    expect(memory.chatPassages("chat-1")).toHaveLength(1);
  });

  it("never lets a saved secret value or a recognized secret reach stored text or the embedder", async () => {
    const { fake, memory, run } = setup([{
      answer: `Stored ${SAVED_VALUE} for you; ${GITHUB_TOKEN} stays private.`,
      question: `Remember my token ${GITHUB_TOKEN} and the demo value ${SAVED_VALUE}`
    }], { title: `About ${SAVED_VALUE}` });
    memory.secrets.set(OWNER, [SAVED_VALUE]);
    await run();
    const texts = [...memory.chatPassages("chat-1").map((row) => row.text), ...fake.embeddedTexts()];
    expect(texts.length).toBeGreaterThan(1);
    for (const value of texts) {
      expect(value).not.toContain(SAVED_VALUE);
      expect(value).not.toContain(GITHUB_TOKEN);
    }
  });

  it("rebuilds the owner's passages when a secret is saved later, embedding only the passages that changed", async () => {
    const { fake, memory, run } = setup([
      { answer: `Use ${SAVED_VALUE}.`, question: "Which demo token?" },
      { answer: "Unrelated answer.", question: "Unrelated question" }
    ]);
    await run();
    expect(memory.chatPassages("chat-1").some((row) => row.text.includes(SAVED_VALUE))).toBe(true);
    fake.calls.length = 0;
    memory.secrets.set(OWNER, [SAVED_VALUE]);
    memory.mark("chat-1"); // as markOwnerChatsSearchDirty marks every chat of the owner
    await run();
    expect(memory.chatPassages("chat-1").some((row) => row.text.includes(SAVED_VALUE))).toBe(false);
    expect(fake.embeddedTexts()).toEqual([expect.stringContaining("Which demo token?")]);
  });

  it("indexes words only while the embedding role is not set, and says so in the state", async () => {
    const { fake, memory, run } = setup([{ answer: "Answer.", question: "Question" }]);
    fake.state.model = { kind: "unset" };
    expect(await run()).toMatchObject({ embedded: 0, indexed: 1, model: "unset" });
    expect(fake.calls).toEqual([]);
    expect(memory.chatPassages("chat-1")).toEqual([expect.objectContaining({ embedding: null, text: expect.stringContaining("Answer.") })]);
    expect(memory.states.get("chat-1")).toMatchObject({ dirtyAt: null, lastErrorCode: "embedding_unset" });
  });

  it("never embeds with another model while the role is unusable, and says why", async () => {
    const { fake, memory, run } = setup([{ answer: "Answer.", question: "Question" }]);
    fake.state.model = { code: "credential_revoked", kind: "unavailable", providerModelId: "embed-a" };
    await run();
    expect(fake.calls).toEqual([]);
    expect(memory.states.get("chat-1")).toMatchObject({ dirtyAt: null, lastErrorCode: "credential_revoked" });
  });

  it("re-embeds every passage once after the role changes, and a second schedule embeds nothing", async () => {
    const { fake, memory, run } = setup([{ answer: "Answer one.", question: "One" }, { answer: "Answer two.", question: "Two" }]);
    await run();
    fake.calls.length = 0;
    fake.state.model = { kind: "model", providerModelId: "embed-b" };
    // As scheduleChatSearchReembedding marks chats with passages, at background priority.
    memory.mark("chat-1", "background");
    await run();
    expect(fake.embeddedTexts()).toHaveLength(2);
    expect(fake.calls.every((call) => call.providerModelId === "embed-b")).toBe(true);
    expect(memory.chatPassages("chat-1").every((row) => row.model === "embed-b")).toBe(true);
    fake.calls.length = 0;
    memory.mark("chat-1", "background");
    await run();
    expect(fake.calls).toEqual([]);
  });

  it("claims a new turn before background work", async () => {
    const { memory, run } = setup([{ answer: "Answer.", question: "Question" }]);
    for (let index = 0; index < 20; index += 1) {
      memory.chats.set(`old-${index}`, chatSnapshot({ chatId: `old-${index}`, prefix: `o${index}`, turns: [{ answer: "Old.", question: "Old" }] }));
      memory.mark(`old-${index}`, "background");
    }
    const summary = await run({ limits: { chatsPerPass: 2 } });
    expect(summary).toMatchObject({ claimed: 2, more: true });
    expect(memory.chatPassages("chat-1")).toHaveLength(1);
    expect(memory.states.get("chat-1")?.dirtyAt).toBeNull();
  });

  it("backs off after a provider failure with the recorded code, keeps word search and retries later", async () => {
    const { clock, fake, memory, run } = setup([{ answer: "Answer.", question: "Question" }]);
    fake.state.failure = new ChatSearchEmbeddingError("embedding_provider_http_error", 90_000);
    expect(await run()).toMatchObject({ embedded: 0, failed: 1, indexed: 1 });
    const state = memory.states.get("chat-1")!;
    expect(state).toMatchObject({ attemptCount: 1, lastErrorCode: "embedding_provider_http_error" });
    expect(state.dirtyAt).not.toBeNull();
    expect(state.nextAttemptAt!.getTime() - clock.now.getTime()).toBe(90_000);
    expect(memory.chatPassages("chat-1")).toEqual([expect.objectContaining({ embedding: null, text: expect.stringContaining("Answer.") })]);
    // Not due yet.
    fake.calls.length = 0;
    expect(await run()).toMatchObject({ claimed: 0 });
    expect(fake.calls).toEqual([]);
    // The next failure waits longer; the recovery clears the state.
    clock.now = new Date(state.nextAttemptAt!.getTime() + 1);
    fake.state.failure = new ChatSearchEmbeddingError("embedding_request_timed_out");
    await run();
    expect(memory.states.get("chat-1")).toMatchObject({ attemptCount: 2, lastErrorCode: "embedding_request_timed_out" });
    expect(memory.states.get("chat-1")!.nextAttemptAt!.getTime() - clock.now.getTime()).toBe(60_000);
    clock.now = new Date(memory.states.get("chat-1")!.nextAttemptAt!.getTime() + 1);
    fake.state.failure = null;
    await run();
    expect(memory.states.get("chat-1")).toMatchObject({ attemptCount: 0, dirtyAt: null, lastErrorCode: null });
    expect(memory.chatPassages("chat-1")[0]!.embedding).not.toBeNull();
  });

  it("stops calling a failing provider for the rest of the pass", async () => {
    const { fake, memory, run } = setup([{ answer: "Answer.", question: "Question" }]);
    memory.chats.set("chat-2", chatSnapshot({ chatId: "chat-2", prefix: "c2", turns: [{ answer: "Other.", question: "Other" }] }));
    memory.mark("chat-2");
    fake.state.failure = new ChatSearchEmbeddingError("embedding_provider_request_failed");
    expect(await run()).toMatchObject({ failed: 2, indexed: 2 });
    expect(fake.calls).toHaveLength(1);
    expect(memory.states.get("chat-2")).toMatchObject({ attemptCount: 1, lastErrorCode: "embedding_provider_request_failed" });
    expect(memory.chatPassages("chat-2")).toHaveLength(1);
  });

  it("keeps a mark that lands while the pass works: the chat stays dirty and is indexed again", async () => {
    const { fake, memory, run } = setup([{ answer: "Answer.", question: "Question" }]);
    fake.state.during = () => {
      memory.chats.set("chat-1", chatSnapshot({ turns: [{ answer: "Answer.", question: "Question" }, { answer: "Later.", question: "Later" }] }));
      memory.mark("chat-1");
    };
    const first = await run();
    expect(first.more).toBe(true);
    expect(memory.states.get("chat-1")!.dirtyAt).not.toBeNull();
    fake.state.during = null;
    fake.calls.length = 0;
    await run();
    expect(memory.chatPassages("chat-1")).toHaveLength(2);
    expect(memory.states.get("chat-1")!.dirtyAt).toBeNull();
    expect(fake.embeddedTexts()).toEqual([expect.stringContaining("Later.")]);
  });

  it("writes nothing when a newer mark arrived between the claim and the write", async () => {
    const memory = memoryStore({ now: new Date() });
    memory.chats.set("chat-1", chatSnapshot({ turns: [{ answer: "A.", question: "Q" }] }));
    memory.mark("chat-1");
    const [claim] = await memory.store.claimDue({ leaseUntil: new Date(Date.now() + 1_000), limit: 1, now: new Date(Date.now() + 10_000) });
    memory.mark("chat-1");
    expect(await memory.store.reconcile(claim!, { kind: "clear" })).toEqual({ kind: "stale" });
    expect(await memory.store.settle(claim!, { kind: "clean", note: null })).toBe(false);
    expect(memory.states.has("chat-1")).toBe(true);
  });

  it("continues a large chat over several passes", async () => {
    const { fake, memory, run } = setup([{ answer: longAnswer(400), question: "Everything" }]);
    const first = await run({ limits: { passagesPerChat: 3 } });
    expect(first).toMatchObject({ embedded: 3, more: true });
    expect(memory.states.get("chat-1")!.dirtyAt).not.toBeNull();
    let passes = 1;
    while ((await run({ limits: { passagesPerChat: 3 } })).more) passes += 1;
    expect(passes).toBeGreaterThan(1);
    expect(memory.chatPassages("chat-1").every((row) => row.embedding !== null)).toBe(true);
    expect(fake.embeddedTexts()).toHaveLength(memory.chatPassages("chat-1").length);
  });

  it("re-embeds a renamed chat's passages, whose text carries the title", async () => {
    const { fake, memory, run } = setup([{ answer: "Answer.", question: "Question" }]);
    await run();
    fake.calls.length = 0;
    memory.chats.set("chat-1", { ...memory.chats.get("chat-1")!, title: "Rome, October" });
    memory.mark("chat-1");
    await run();
    expect(fake.embeddedTexts()).toEqual([expect.stringContaining("Chat: Rome, October")]);
  });
});

describe("retry delays", () => {
  it("double from half a minute up to an hour and never come sooner than the provider asked", () => {
    expect([1, 2, 3, 8, 30].map((attempt) => chatSearchRetryDelayMs(attempt, null))).toEqual([30_000, 60_000, 120_000, 3_600_000, 3_600_000]);
    expect(chatSearchRetryDelayMs(1, 600_000)).toBe(600_000);
    expect(chatSearchRetryDelayMs(1, 10 * 3_600_000)).toBe(3_600_000);
  });
});
