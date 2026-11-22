// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import type { ChatSearchEmbedder } from "../embedder";
import { pastChatPhraseChunks, pastChatQueryChunks, pastChatWordUnits } from "./query";
import { createPastChatSearch, type PastChatSearchOutcome } from "./retrieval";
import { createPrismaPastChatSearchStore, type PastChatScope } from "./store";

/**
 * Past-chat search's SQL on PostgreSQL with pgvector, at the measured
 * production size: about 6 000 passages of one owner with 1 536-dimension
 * vectors, beside other users' and ineligible chats' rows. It checks word,
 * vector and fused search, the owner and eligibility fences, and logs the
 * database part's latency (content-free).
 */

const DIMENSION = 1_536;
const MODEL = `fixture-embedding-${randomUUID()}`;
const CHATS = 300;
const TURNS_PER_CHAT = 10;
const WINDOWS_PER_TURN = 2;
const BASE = Date.UTC(2026, 10, 20, 12);

const store = createPrismaPastChatSearchStore(prisma);
const latencies: Record<string, number> = {};

type Fixture = Readonly<{
  owner: string;
  other: string;
  current: string;
  eligible: ReadonlySet<string>;
  chat: Readonly<Record<"ticket" | "similar" | "costs" | "campaign" | "report" | "cyrillic" | "temporary" | "excluded" | "deleted" | "foreign", string>>;
  passages: number;
}>;

let fixture: Fixture;
const cleanup: { users: string[]; chats: string[]; outboxes: string[] } = { chats: [], outboxes: [], users: [] };

const SYLLABLES = ["ka", "lo", "mi", "ra", "su", "te", "vo", "ne", "ba", "ko", "ми", "ру", "се", "то", "ва", "не"];

/** A deterministic filler word: three syllables, Latin or Cyrillic, from a vocabulary of a few thousand. */
function fillerWord(seed: number): string {
  const pick = (shift: number) => SYLLABLES[(seed >> shift) % SYLLABLES.length]!;
  return pick(0) + pick(4) + pick(8);
}

function fillerText(seed: number): string {
  let state = seed * 2654435761 % 4294967296;
  const words: string[] = [];
  for (let index = 0; index < 110; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    words.push(fillerWord(state));
  }
  return words.join(" ");
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A vector along one axis with a little noise, in SQL so 1 536 numbers never cross the wire. */
function axisVectorSql(axis: number): Prisma.Sql {
  return Prisma.sql`(SELECT array_agg((CASE WHEN i = ${axis} THEN 1 ELSE 0 END + (random() * 2 - 1) * 0.01)::real ORDER BY i)
    FROM generate_series(1, ${DIMENSION}) AS i)::vector`;
}

function axis(index: number): number[] {
  return Array.from({ length: DIMENSION }, (_, position) => position === index - 1 ? 1 : 0);
}

type PassageSeed = { id: string; userId: string; chatId: string; userMessageId: string; assistantMessageId: string; turnAt: Date;
  ordinal: number; text: string };

async function insertPassages(rows: readonly PassageSeed[]): Promise<void> {
  for (let start = 0; start < rows.length; start += 500) {
    const values = rows.slice(start, start + 500).map((row) => Prisma.sql`(${row.id}, ${row.userId}, ${row.chatId}, ${row.userMessageId},
      ${row.assistantMessageId}, ${row.turnAt}, ${row.ordinal}, ${row.text}, ${sha(row.text)})`);
    await prisma.$executeRaw(Prisma.sql`INSERT INTO "ChatSearchPassage"
      ("id", "userId", "chatId", "userMessageId", "assistantMessageId", "turnAt", "ordinal", "text", "contentHash")
      VALUES ${Prisma.join(values)}`);
  }
}

/** A chat with `turns` turns and `windows` passages each; the passages' texts come from `text`. */
async function seedChat(input: Readonly<{ userId: string; title: string; turns: number; windows: number; firstMinute: number;
  text: (turn: number, window: number) => string; mode?: "NORMAL" | "EXCLUDED" | "TEMPORARY" }>): Promise<{ chatId: string; passages: PassageSeed[] }> {
  const now = new Date();
  const chat = await prisma.chat.create({ data: { memoryMode: input.mode ?? "NORMAL", title: input.title, userId: input.userId,
    ...(input.mode === "TEMPORARY" ? { temporaryRetentionDeadline: new Date(now.getTime() + 86_400_000),
      temporaryRetentionPolicyVersion: "temporary-24h-v1" } : {}) } });
  cleanup.chats.push(chat.id);
  const messages: Prisma.MessageCreateManyInput[] = [];
  const passages: PassageSeed[] = [];
  for (let turn = 0; turn < input.turns; turn += 1) {
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const turnAt = new Date(BASE - (input.firstMinute + turn) * 60_000);
    messages.push({ chatId: chat.id, content: { blocks: [{ text: "question", type: "text" }] }, createdAt: turnAt, id: userMessageId, role: "user" },
      { chatId: chat.id, content: { blocks: [{ text: "answer", type: "text" }] }, createdAt: turnAt, id: assistantMessageId, role: "assistant" });
    for (let window = 0; window < input.windows; window += 1) {
      passages.push({ assistantMessageId, chatId: chat.id, id: randomUUID(), ordinal: window, text: input.text(turn, window), turnAt,
        userId: input.userId, userMessageId });
    }
  }
  for (let start = 0; start < messages.length; start += 1_000) await prisma.message.createMany({ data: messages.slice(start, start + 1_000) });
  return { chatId: chat.id, passages };
}

async function seed(): Promise<Fixture> {
  const owner = (await prisma.user.create({ data: { displayName: "Past chat search owner", id: randomUUID(), status: "active" } })).id;
  const other = (await prisma.user.create({ data: { displayName: "Past chat search other", id: randomUUID(), status: "active" } })).id;
  cleanup.users.push(owner, other);
  const passages: PassageSeed[] = [];
  const eligible = new Set<string>();
  let minute = 1_000;
  for (let index = 0; index < CHATS; index += 1) {
    const seeded = await seedChat({ firstMinute: minute, text: (turn, window) => fillerText(index * 1_000 + turn * 10 + window),
      title: `Fixture chat ${index}`, turns: TURNS_PER_CHAT, userId: owner, windows: WINDOWS_PER_TURN });
    minute += TURNS_PER_CHAT * 7;
    passages.push(...seeded.passages);
    eligible.add(seeded.chatId);
  }
  const special = async (name: string, text: string, firstMinute: number, options: Readonly<{ userId?: string; mode?: "EXCLUDED" | "TEMPORARY" }> = {}) => {
    const seeded = await seedChat({ firstMinute, text: () => text, title: `Special ${name}`, turns: 1, userId: options.userId ?? owner, windows: 1,
      ...(options.mode ? { mode: options.mode } : {}) });
    passages.push(...seeded.passages);
    return seeded.chatId;
  };
  const ticket = await special("ticket", "Ticket ABC-1234 is blocked by the database migration; see the runbook.", 100);
  const similar = await special("similar", "The rollout of a similar ticket went smoothly after the canary stage.", 110);
  const costs = await special("costs", "We cut the cloud bill with reserved instances and spot capacity.", 120);
  const campaign = await special("campaign", "Weekly numbers for campaign_42 came in above plan.", 130);
  const report = await special("report", "Attached report_2026-11-12.xlsx with the regional split.", 140);
  const cyrillic = await special("cyrillic", "Отчёт по кампании «Весна» отправлен заказчику.", 150);
  for (const id of [ticket, similar, costs, campaign, report, cyrillic]) eligible.add(id);
  const blocked = "Ticket ABC-1234 rollout notes: campaign_42 and report_2026-11-12.xlsx, отчёт по кампании.";
  const current = await special("current", blocked, 5);
  const temporary = await special("temporary", blocked, 6, { mode: "TEMPORARY" });
  const excluded = await special("excluded", blocked, 7, { mode: "EXCLUDED" });
  const deleted = await special("deleted", blocked, 8);
  const foreign = await special("foreign", blocked, 9, { userId: other });
  for (let index = 0; index < 10; index += 1) {
    const seeded = await seedChat({ firstMinute: 200 + index * 30, text: (turn, window) => fillerText(900_000 + index * 100 + turn * 10 + window),
      title: `Other user's chat ${index}`, turns: 10, userId: other, windows: 2 });
    passages.push(...seeded.passages);
  }
  await insertPassages(passages);
  // Random vectors in [-1, 1) for every passage, then known directions for the ones the searches look for.
  await prisma.$executeRaw(Prisma.sql`UPDATE "ChatSearchPassage" p
    SET "embedding" = r.v, "embeddingProviderModelId" = ${MODEL}, "embeddingDimension" = ${DIMENSION}
    FROM (SELECT s."id", (SELECT array_agg((random() * 2 - 1)::real) FROM generate_series(1, ${DIMENSION}) WHERE s."id" IS NOT NULL)::vector AS v
      FROM "ChatSearchPassage" s WHERE s."userId" IN (${owner}, ${other})) r
    WHERE p."id" = r."id"`);
  const direct = async (chatId: string, axisIndex: number) => prisma.$executeRaw(Prisma.sql`UPDATE "ChatSearchPassage"
    SET "embedding" = ${axisVectorSql(axisIndex)} WHERE "chatId" = ${chatId}`);
  await direct(similar, 1);
  await direct(costs, 2);
  // The chats search must never return sit between both directions, so either lane would rank them high if unfenced.
  await prisma.$executeRaw(Prisma.sql`UPDATE "ChatSearchPassage"
    SET "embedding" = (SELECT array_agg((CASE WHEN i IN (1, 2) THEN 1 ELSE 0 END)::real ORDER BY i) FROM generate_series(1, ${DIMENSION}) AS i)::vector
    WHERE "chatId" IN (${Prisma.join([current, temporary, excluded, deleted, foreign])})`);
  // A passage of another embedding model and one of another dimension along the query's direction: neither is a meaning match.
  const otherModel = await special("other model", fillerText(777), 300);
  await insertPassages(passages.splice(-1));
  await prisma.$executeRaw(Prisma.sql`UPDATE "ChatSearchPassage" SET "embedding" = ${axisVectorSql(1)}, "embeddingProviderModelId" = ${"another-model"},
    "embeddingDimension" = ${DIMENSION} WHERE "chatId" = ${otherModel}`);
  const otherDimension = await special("other dimension", fillerText(778), 301);
  await insertPassages(passages.splice(-1));
  await prisma.$executeRaw(Prisma.sql`UPDATE "ChatSearchPassage" SET "embedding" = '[1,0,0,0,0,0,0,0]'::vector, "embeddingProviderModelId" = ${MODEL},
    "embeddingDimension" = 8 WHERE "chatId" = ${otherDimension}`);
  eligible.add(otherModel);
  eligible.add(otherDimension);
  // Fence the deleted chat as permanent deletion does, after its passage exists (the guard refuses new ones).
  await prisma.$transaction(async (tx) => {
    const outbox = await tx.memoryDeletionOutbox.create({ data: { admissionAuthorizationId: randomUUID(), admittedChatSourceRevision: 0,
      alsoForgetOriginMemories: false, memoryGeneration: 0, operation: "SOURCE_PURGE", targetId: deleted, targetType: "CHAT@memory-chat-delete-v1",
      userId: owner } });
    cleanup.outboxes.push(outbox.id);
    await tx.chat.update({ data: { permanentDeletionAt: new Date(), permanentDeletionOperationId: outbox.id }, where: { id: deleted } });
  });
  const counted = await prisma.chatSearchPassage.count({ where: { userId: owner } });
  return { chat: { campaign, costs, cyrillic, deleted, excluded, foreign, report, similar, temporary, ticket }, current, eligible, other, owner,
    passages: counted };
}

beforeAll(async () => {
  fixture = await seed();
}, 600_000);

afterAll(async () => {
  try {
    console.info(JSON.stringify({ pastChatSearchDatabaseLatencyMs: latencies, passages: fixture?.passages }));
    await prisma.chatSearchPassage.deleteMany({ where: { chatId: { in: cleanup.chats } } });
    await prisma.message.deleteMany({ where: { chatId: { in: cleanup.chats } } });
    await prisma.chat.deleteMany({ where: { id: { in: cleanup.chats } } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { id: { in: cleanup.outboxes } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
  } finally {
    await prisma.$disconnect();
  }
}, 300_000);

/** The median of a few runs, recorded under the label. */
async function timed<T>(label: string, run: () => Promise<T>, runs = 5): Promise<T> {
  const samples: number[] = [];
  let value: T | undefined;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    value = await run();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  latencies[label] = Math.round(samples[Math.floor(samples.length / 2)]! * 10) / 10;
  return value!;
}

const scope = (overrides: Partial<PastChatScope> = {}): PastChatScope => ({ currentChatId: fixture.current, ownerId: fixture.owner,
  range: { from: null, until: null }, ...overrides });

async function wordSearch(query: string, overrides: Partial<PastChatScope> = {}) {
  const ownerId = overrides.ownerId ?? fixture.owner;
  const units = pastChatWordUnits(await store.wordStatistics(ownerId, query, pastChatPhraseChunks(pastChatQueryChunks(query))));
  return store.wordHits(scope(overrides), units, 50);
}

function embedder(vectors: Readonly<Record<string, readonly number[]>>): ChatSearchEmbedder {
  return {
    currentModel: async () => ({ kind: "model", providerModelId: MODEL }),
    embed: async (request) => ({ dimension: DIMENSION, vectors: request.texts.map((text) => vectors[text] ?? axis(3)) })
  };
}

function searchAs(ownerId: string, currentChatId: string, query: string | null, vectors: Readonly<Record<string, readonly number[]>> = {},
  extra: Readonly<{ after?: string; before?: string }> = {}): Promise<PastChatSearchOutcome> {
  return createPastChatSearch({ embedder: embedder(vectors), recordUsage: () => undefined, savedSecretValues: async () => [], store })
    .search({ currentChatId, input: { query, ...extra }, ownerId, timeZone: "UTC" });
}

function chatIds(outcome: PastChatSearchOutcome): string[] {
  if (outcome.kind !== "searched") throw new Error(`expected a search, got ${outcome.kind}`);
  return outcome.result.results.map((result) => result.chatId);
}

describe("past-chat search SQL", () => {
  it("seeds about 6 000 passages for the owner", () => {
    expect(fixture.passages).toBeGreaterThanOrEqual(6_000);
  });

  it("matches identifiers, file names and Cyrillic words exactly, rare terms first, inside the owner's eligible chats", async () => {
    const ticket = await timed("words_identifier", () => wordSearch("ABC-1234 rollout"));
    expect(ticket[0]).toMatchObject({ chatId: fixture.chat.ticket, pinned: true });
    expect(ticket.map((hit) => hit.chatId)).toContain(fixture.chat.similar);
    expect((await wordSearch("campaign_42"))[0]).toMatchObject({ chatId: fixture.chat.campaign, pinned: true });
    expect((await wordSearch("report_2026-11-12.xlsx"))[0]).toMatchObject({ chatId: fixture.chat.report, pinned: true });
    expect((await wordSearch("ОТЧЁТ"))[0]).toMatchObject({ chatId: fixture.chat.cyrillic });
    // A stem finds its inflected form.
    expect((await wordSearch("кампани")).map((hit) => hit.chatId)).toContain(fixture.chat.cyrillic);
    const common = await timed("words_common", () => wordSearch(`${fillerWord(1)} ${fillerWord(2)} ${fillerWord(3)}`));
    expect(common.length).toBeGreaterThan(0);
    for (const hits of [ticket, common, await wordSearch("campaign_42 отчёт report_2026-11-12.xlsx")]) {
      expect(hits.every((hit) => fixture.eligible.has(hit.chatId))).toBe(true);
    }
  });

  it("binds every query as data, whatever punctuation it holds", async () => {
    for (const query of ["'; DROP TABLE \"Chat\"; --", "a:* & !b | (c", "back\\slash 'quote' \"double\"", "::tsquery ' || '"]) {
      await expect(wordSearch(query)).resolves.toEqual(expect.any(Array));
    }
    expect(await prisma.chat.count({ where: { id: fixture.chat.ticket } })).toBe(1);
  });

  it("finds a paraphrase by meaning among the current model's vectors only, of the query's dimension", async () => {
    const costs = await timed("vectors", () => store.vectorHits(scope(), { providerModelId: MODEL, values: axis(2) }, 50));
    expect(costs[0]).toMatchObject({ chatId: fixture.chat.costs });
    const similar = await store.vectorHits(scope(), { providerModelId: MODEL, values: axis(1) }, 50);
    expect(similar[0]).toMatchObject({ chatId: fixture.chat.similar });
    expect(similar.every((hit) => fixture.eligible.has(hit.chatId))).toBe(true);
    const small = await store.vectorHits(scope(), { providerModelId: MODEL, values: [1, 0, 0, 0, 0, 0, 0, 0] }, 50);
    expect(small).toHaveLength(1);
    expect(await store.vectorHits(scope(), { providerModelId: "unknown-model", values: axis(1) }, 50)).toEqual([]);
  });

  it("fuses both lanes: an exact identifier first, then meaning; a paraphrase with no shared word by meaning", async () => {
    const vectors = { "ABC-1234 rollout": axis(1), "reduce infrastructure spending": axis(2) };
    const fused = await timed("fused_search", () => searchAs(fixture.owner, fixture.current, "ABC-1234 rollout", vectors));
    expect(chatIds(fused).slice(0, 2)).toEqual([fixture.chat.ticket, fixture.chat.similar]);
    expect(chatIds(await searchAs(fixture.owner, fixture.current, "reduce infrastructure spending", vectors))[0]).toBe(fixture.chat.costs);
  });

  it("never returns another user's, the current, a Temporary, an Excluded or a deleted chat", async () => {
    const vectors = { "ABC-1234 rollout campaign_42": axis(1) };
    const blocked = new Set([fixture.current, fixture.chat.temporary, fixture.chat.excluded, fixture.chat.deleted, fixture.chat.foreign]);
    for (const outcome of [await searchAs(fixture.owner, fixture.current, "ABC-1234 rollout campaign_42", vectors),
      await searchAs(fixture.owner, fixture.current, null)]) {
      expect(chatIds(outcome).filter((id) => blocked.has(id))).toEqual([]);
    }
    // The other user finds their own chat and none of the owner's.
    const theirs = chatIds(await searchAs(fixture.other, randomUUID(), "ABC-1234 rollout campaign_42", vectors));
    expect(theirs[0]).toBe(fixture.chat.foreign);
    expect(theirs.some((id) => fixture.eligible.has(id))).toBe(false);
    // The current chat is the owner's own: excluded only while it is the one answering.
    expect(chatIds(await searchAs(fixture.owner, fixture.chat.similar, "ABC-1234 rollout", vectors))).toContain(fixture.current);
  });

  it("lists recent chats once each, newest first, within the days asked for", async () => {
    const recent = await timed("recent", () => store.recent(scope(), 8));
    expect(recent.map((row) => row.chatId)).toEqual([fixture.chat.ticket, fixture.chat.similar, fixture.chat.costs, fixture.chat.campaign,
      fixture.chat.report, fixture.chat.cyrillic, expect.any(String), expect.any(String)]);
    expect(new Set(recent.map((row) => row.chatId)).size).toBe(8);
    const ticketAt = new Date(BASE - 100 * 60_000);
    const day = (date: Date) => date.toISOString().slice(0, 10);
    const sameDay = chatIds(await searchAs(fixture.owner, fixture.current, "ABC-1234", {}, { after: day(ticketAt) }));
    expect(sameDay[0]).toBe(fixture.chat.ticket);
    expect(chatIds(await searchAs(fixture.owner, fixture.current, "ABC-1234", {}, { before: day(ticketAt) }))).not.toContain(fixture.chat.ticket);
  });

  it("reads candidates' texts only from chats still eligible", async () => {
    const hits = await wordSearch("ABC-1234");
    const rows = await timed("passages", () => store.passages(scope(), hits.map((hit) => hit.id)));
    expect(rows.map((row) => row.chatId)).toContain(fixture.chat.ticket);
    const foreignIds = (await prisma.chatSearchPassage.findMany({ select: { id: true }, where: { chatId: { in: [fixture.chat.foreign,
      fixture.chat.deleted, fixture.chat.excluded] } } })).map((row) => row.id);
    expect(await store.passages(scope(), foreignIds)).toEqual([]);
  });
});
