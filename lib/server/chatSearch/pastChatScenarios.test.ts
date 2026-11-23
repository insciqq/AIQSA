import { beforeAll, describe, expect, it } from "vitest";
import {
  chatSearchScenarioReport,
  loadChatSearchFixtures,
  materializeChatSearchCorpus,
  scenarioCurrentChatKey,
  scenarioSearchInput,
  scenarioTimeZone,
  scoreChatSearchScenario,
  seedActivePath,
  type ScenarioObservation,
  type ScenarioScore,
  type SeedChat
} from "../../../scripts/eval/chat-search-scenarios-support";
import { chatSearchEligible, type ChatSearchEligibilityFields } from "./eligibility";
import type { ChatSearchEmbedder } from "./embedder";
import { runChatSearchIndexPassOn } from "./index/pass";
import { OWNER_TITLE } from "./index/indexer.testFixtures";
import type { ChatSearchSourceMessage } from "./index/passages";
import type { ChatSearchIndexStore, ChatSearchPassageToEmbed } from "./index/store";
import { createPastChatReader, type PastChatReadStore } from "./search/read";
import type { PastChatReranker } from "./search/rerank";
import { createPastChatSearch } from "./search/retrieval";
import type { PastChatPassageRow, PastChatScope, PastChatSearchStore } from "./search/store";

/**
 * The past-chat search scenarios (`tests/fixtures/chat-search/`) in the ordinary test run: the corpus goes through the
 * real index pass and passage builder into an in-memory index, every scenario through the real search (`query.ts`,
 * `rank.ts`, `retrieval.ts`) and, where it reads, the real reader. The stores stand in for PostgreSQL where the search
 * depends on it: lexemes as the `simple` parser splits them, prefix and phrase units, the eligibility rule, the owner,
 * the current chat and the turn range; the real SQL runs in `store.prisma.test.ts` and in the stand run
 * (`scripts/eval/chat-search-scenarios.ts`). The embedder is a fake over a small table of concepts shared by the two
 * languages, so the meaning lane takes part and is fused; how well real models find a paraphrase is the stand run's
 * question, not this one's.
 */

const NOW = new Date("2026-11-20T12:00:00Z");
const MODEL = "fake-concepts";

const fixtures = loadChatSearchFixtures();
const users = materializeChatSearchCorpus(fixtures.corpus, NOW);
const chats = users.flatMap((user) => user.chats);
const idOf = (key: string) => key.replaceAll("/", "_");
const keyById = new Map<string, string>([
  ...chats.map((chat) => [idOf(chat.key), chat.key] as const),
  ...chats.flatMap((chat) => chat.messages.map((message) => [idOf(message.key), message.key] as const))
]);

// --- The fake embedder: a bag of concepts, each a few stems in Russian and English. -------------------------------

const CONCEPTS: ReadonlyArray<readonly string[]> = [
  ["ставк", "стоимост", "price", "rate", "cost", "pricing"],
  ["час", "почасов", "hour"],
  ["дизайн", "иллюстр", "design", "illustr", "макет"],
  ["предложен", "коммерческ", "proposal", "commercial"],
  ["письм", "email", "letter", "subject"],
  ["miss", "inactive", "stopped", "return", "relist", "вернут"],
  ["seller", "merchant", "продав", "store"],
  ["поездк", "командиров", "trip", "travel", "поезд"],
  ["казан", "татарстан"],
  ["жил", "отел", "гостиниц", "hotel"],
  ["name", "naming", "назыв", "назван", "именован"],
  ["campaign", "кампан", "реклам"],
  ["creative", "креатив"],
  ["file", "файл"],
  ["платеж", "платёж", "payment", "оплат"],
  ["пада", "crash", "упал", "restart", "перезапуск"],
  ["конфиг", "config"],
  ["cohort", "когорт"],
  ["retention", "удержан"],
  ["month", "месяч", "месяц"],
  ["signup", "регистрац", "registered"],
  ["значим", "significan"],
  ["тест", "test"],
  ["кноп", "button"],
  ["checkout", "оформлен"],
  ["шаблон", "template"],
  ["заметк", "notes"],
  ["daily", "ежедневн", "планёрк", "планерк", "standup"],
  ["алерт", "alert", "порог", "monitor", "мониторинг"],
  ["мёртв", "dlq", "dead"],
  ["склад", "warehouse"]
];

/** Hashed buckets of word stems: what a sentence embedding shares with exact words. */
const STEM_BUCKETS = 97;

function stemBucket(token: string): number {
  let hash = 0;
  for (const unit of [...token].slice(0, 5)) hash = (hash * 31 + unit.codePointAt(0)!) % 1_000_003;
  return hash % STEM_BUCKETS;
}

/** Concepts weigh more than shared stems, so a paraphrase in other words still lands near its text. */
function conceptVector(text: string): number[] {
  const vector = [0.05, ...CONCEPTS.map(() => 0), ...Array.from({ length: STEM_BUCKETS }, () => 0)];
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    CONCEPTS.forEach((stems, index) => {
      if (stems.some((stem) => token.startsWith(stem))) vector[index + 1]! += 3;
    });
    if ([...token].length >= 4) vector[1 + CONCEPTS.length + stemBucket(token)]! += 1;
  }
  return vector;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const norm = (vector: readonly number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return dot / (norm(left) * norm(right));
}

const embedder: ChatSearchEmbedder = {
  currentModel: async () => ({ kind: "model", providerModelId: MODEL }),
  embed: async (request) => {
    const vectors = request.texts.map(conceptVector);
    return { dimension: vectors[0]!.length, vectors };
  }
};

/** A cross-encoder notices the query's own words in the document, which a bag of concepts blurs. */
function rerankScore(query: string, document: string): number {
  const tokens = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => [...token].length >= 3));
  const asked = tokens(query);
  const present = tokens(document);
  const shared = [...asked].filter((token) => present.has(token)).length;
  return cosine(conceptVector(query), conceptVector(document)) + (asked.size ? (2 * shared) / asked.size : 0);
}

/**
 * The dedicated reranker, as a fake: concepts and the query's own words, query against each document. Every scenario
 * runs with it and without one (`VARIANTS`): an installation may have none, so the fused order must find a
 * meaning-only match (a cross-language query) above passages that share only a weak word with the query
 * (`lib/server/chatSearch/search/rank.ts`); the stand run measures both with real models.
 */
const reranker: PastChatReranker = {
  resolve: async () => ({ kind: "ready", route: {
    binding: { connectionId: "connection", credentialId: "credential", credentialSource: "default", credentialVersionId: "version",
      modelId: "fake-reranker", provider: "fake", providerModelId: "fake-reranker" },
    rerank: async (request) => ({ model: "fake-reranker", provider: "fake", requestId: null,
      scores: request.documents.map((document, index) => ({ handle: document.handle, index,
        relevanceScore: rerankScore(request.query, document.text) })),
      usage: { costUsd: null, inputTokens: null, searchUnits: null, totalTokens: null } })
  } })
};

// --- The world: chats, their eligibility as it changes, and the index. -------------------------------------------

type WorldChat = { seed: SeedChat; id: string; userId: string; eligibility: ChatSearchEligibilityFields };
type Passage = { id: string; chatId: string; userId: string; userMessageId: string; turnAt: Date; ordinal: number; text: string;
  contentHash: string; vector: number[] | null; model: string | null };

const world = new Map<string, WorldChat>(chats.map((seed) => [idOf(seed.key), {
  eligibility: { discord: false, importSource: null, memoryMode: seed.mode === "excluded" ? "EXCLUDED" : seed.mode === "temporary" ? "TEMPORARY" : "NORMAL",
    permanentDeletionAt: null, scheduledTaskId: null, userId: idOf(seed.userKey) },
  id: idOf(seed.key), seed, userId: idOf(seed.userKey)
}]));
const passages: Passage[] = [];
const dirty = new Map<string, Date>();

function sourcePath(chat: WorldChat): ChatSearchSourceMessage[] {
  return seedActivePath(chat.seed).map((message) => ({
    content: { blocks: [{ text: message.text, type: "text" }] }, createdAt: message.createdAt,
    id: idOf(message.key), parentMessageId: message.parentKey ? idOf(message.parentKey) : null, role: message.role,
    scheduledTaskPrompt: false, status: "complete", systemTurnKind: null
  }));
}

/** `markChatSearchDirty`: a state for an eligible chat, or a mark on one that has a state already. */
function markDirty(chat: WorldChat): void {
  if (chatSearchEligible(chat.eligibility, chat.userId) || dirty.has(chat.id)) dirty.set(chat.id, new Date(NOW));
}

const indexStore: ChatSearchIndexStore = {
  async claimDue({ limit }) {
    return [...dirty.entries()].slice(0, limit).map(([chatId, dirtyAt]) => ({ attemptCount: 0, chatId, dirtyAt,
      userId: world.get(chatId)!.userId }));
  },
  async loadSnapshot(chatId) {
    const chat = world.get(chatId);
    if (!chat) return null;
    const path = sourcePath(chat);
    const fileNames = new Map(seedActivePath(chat.seed).filter((message) => message.files.length)
      .map((message) => [idOf(message.key), message.files] as const));
    return { activeLeafMessageId: path.at(-1)?.id ?? null, chatId, eligibility: chat.eligibility, fileNames, path, title: chat.seed.title,
      titleOrigin: OWNER_TITLE };
  },
  loadSavedSecretValues: async () => [],
  ownerAllowsEmbedding: async () => true,
  async reconcile(claim, target) {
    for (let index = passages.length - 1; index >= 0; index -= 1) if (passages[index]!.chatId === claim.chatId) passages.splice(index, 1);
    if (target.kind === "clear") {
      dirty.delete(claim.chatId);
      return { kind: "cleared" };
    }
    for (const draft of target.passages) {
      passages.push({ chatId: claim.chatId, contentHash: draft.contentHash, id: `${claim.chatId}_${draft.userMessageId}_${draft.ordinal}`,
        model: null, ordinal: draft.ordinal, text: draft.text, turnAt: draft.turnAt, userId: claim.userId, userMessageId: draft.userMessageId,
        vector: null });
    }
    return { deleted: 0, inserted: target.passages.length, kind: "applied", unchanged: 0, updated: 0 };
  },
  async passagesToEmbed({ chatId, limit, providerModelId }): Promise<ChatSearchPassageToEmbed[]> {
    return passages.filter((passage) => passage.chatId === chatId && passage.model !== providerModelId).slice(0, limit)
      .map((passage) => ({ contentHash: passage.contentHash, id: passage.id, text: passage.text }));
  },
  async writeEmbeddings({ providerModelId, vectors }) {
    for (const write of vectors) {
      const passage = passages.find((entry) => entry.id === write.id && entry.contentHash === write.contentHash)!;
      passage.vector = [...write.vector];
      passage.model = providerModelId;
    }
    return vectors.length;
  },
  async settle(claim, settlement) {
    if (settlement.kind !== "more") dirty.delete(claim.chatId);
    return true;
  }
};

async function drain(): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    const summary = await runChatSearchIndexPassOn(indexStore, { embedder, now: () => NOW });
    expect(summary.failed).toBe(0);
    if (!summary.more && dirty.size === 0) return;
  }
  throw new Error("index_did_not_settle");
}

// --- The search and read stores over the world. --------------------------------------------------------------------

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Lexemes roughly as the `simple` parser makes them: words, and a hyphenated word with each of its parts. */
function lexemes(text: string): Set<string> {
  const found = new Set<string>();
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []) {
    found.add(token);
    if (token.includes("-")) for (const part of token.split("-")) found.add(part);
  }
  return found;
}

function containsRun(haystack: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= haystack.length; start += 1) {
    if (run.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

function unitMatches(query: string, text: string): boolean {
  if (query.startsWith("phrase:")) return containsRun(words(text), query.slice("phrase:".length).split(" "));
  if (query.endsWith(":*")) return [...lexemes(text)].some((lexeme) => lexeme.startsWith(query.slice(1, -3)));
  return lexemes(text).has(query.slice(1, -1));
}

function cosineDistance(left: readonly number[], right: readonly number[]): number {
  return 1 - cosine(left, right);
}

function eligibleFor(ownerId: string, chatId: string): boolean {
  const chat = world.get(chatId);
  return Boolean(chat) && chatSearchEligible(chat!.eligibility, ownerId);
}

function inScope(scope: Omit<PastChatScope, "range"> & Partial<Pick<PastChatScope, "range">>): Passage[] {
  return passages.filter((passage) => passage.userId === scope.ownerId && eligibleFor(scope.ownerId, passage.chatId) &&
    passage.chatId !== scope.currentChatId && (!scope.range?.from || passage.turnAt >= scope.range.from) &&
    (!scope.range?.until || passage.turnAt < scope.range.until));
}

const row = (passage: Passage): PastChatPassageRow => ({ chatId: passage.chatId, id: passage.id, text: passage.text,
  title: world.get(passage.chatId)!.seed.title, turnAt: passage.turnAt, userMessageId: passage.userMessageId });

const searchStore: PastChatSearchStore = {
  switches: async () => ({ memoryEnabled: true, pastChatSearchEnabled: true }),
  async wordStatistics(ownerId, query, phrases) {
    const corpus = passages.filter((passage) => passage.userId === ownerId);
    const units: Array<{ key: string; kind: "exact" | "prefix" | "phrase"; query: string }> = [...lexemes(query)].flatMap((lexeme) => [
      { key: lexeme, kind: "exact" as const, query: `'${lexeme}'` },
      ...([...lexeme].length >= 4 ? [{ key: lexeme, kind: "prefix" as const, query: `'${lexeme}':*` }] : [])
    ]);
    for (const phrase of phrases) {
      const run = words(phrase);
      if (run.length) units.push({ key: phrase, kind: "phrase", query: run.length === 1 ? `'${run[0]}'` : `phrase:${run.join(" ")}` });
    }
    return units.map((unit) => ({ ...unit, documentFrequency: corpus.filter((passage) => unitMatches(unit.query, passage.text)).length,
      passages: corpus.length }));
  },
  async wordHits(scope, units, limit) {
    return inScope(scope).flatMap((passage) => {
      const terms = new Map<string, { admits: boolean; weight: number; pin: boolean }>();
      for (const unit of units) {
        if (!unitMatches(unit.query, passage.text)) continue;
        const known = terms.get(unit.term);
        terms.set(unit.term, { admits: (known?.admits ?? false) || unit.admits, pin: (known?.pin ?? false) || unit.pin,
          weight: Math.max(known?.weight ?? 0, unit.weight) });
      }
      // As the SQL's HAVING: a common unit alone does not bring a passage in.
      if (![...terms.values()].some((value) => value.admits)) return [];
      const entries = [...terms.entries()].sort((left, right) => right[1].weight - left[1].weight);
      return [{ chatId: passage.chatId, id: passage.id, pinned: entries.some(([, value]) => value.pin),
        score: entries.reduce((sum, [, value]) => sum + value.weight, 0), terms: entries.map(([term]) => term), turnAt: passage.turnAt,
        userMessageId: passage.userMessageId }];
    }).sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.score - left.score ||
      right.turnAt.getTime() - left.turnAt.getTime() || (left.id < right.id ? -1 : 1))
      .slice(0, limit);
  },
  async vectorHits(scope, vector, limit) {
    return inScope(scope).filter((passage) => passage.model === vector.providerModelId && passage.vector?.length === vector.values.length)
      .map((passage) => ({ distance: cosineDistance(passage.vector!, vector.values), passage }))
      .sort((left, right) => left.distance - right.distance || (left.passage.id < right.passage.id ? -1 : 1))
      .slice(0, limit).map(({ passage }) => ({ chatId: passage.chatId, id: passage.id, turnAt: passage.turnAt, userMessageId: passage.userMessageId }));
  },
  async passages(scope, ids) {
    return inScope(scope).filter((passage) => ids.includes(passage.id)).map(row);
  },
  async recent(scope, limit) {
    const latest = new Map<string, Passage>();
    for (const passage of inScope(scope)) {
      const known = latest.get(passage.chatId);
      if (!known || passage.turnAt > known.turnAt || (passage.turnAt.getTime() === known.turnAt.getTime() && passage.ordinal < known.ordinal)) {
        latest.set(passage.chatId, passage);
      }
    }
    return [...latest.values()].sort((left, right) => right.turnAt.getTime() - left.turnAt.getTime()).slice(0, limit).map(row);
  }
};

const readStore: PastChatReadStore = {
  switches: async () => ({ memoryEnabled: true, pastChatSearchEnabled: true }),
  async branch(ownerId, chatId) {
    if (!eligibleFor(ownerId, chatId)) return null;
    const chat = world.get(chatId)!;
    return { chatId, messages: sourcePath(chat).map((message) => ({ id: message.id, role: message.role as "user" | "assistant" })),
      title: chat.seed.title, titleOrigin: OWNER_TITLE };
  },
  async messages(ownerId, chatId, ids) {
    const chat = world.get(chatId);
    if (!chat || chat.userId !== ownerId) return [];
    return seedActivePath(chat.seed).filter((message) => ids.includes(idOf(message.key))).map((message) => ({
      attachments: message.role === "user" ? message.files : [], createdAt: message.createdAt,
      generatedFiles: message.role === "assistant" ? message.files : [], id: idOf(message.key), role: message.role, text: message.text, tools: []
    }));
  }
};

/** Two variants of one search: with the dedicated reranker, and without one, where the fused order must stand on its own. */
const VARIANTS = [
  { name: "with the reranker", search: createPastChatSearch({ embedder, recordUsage: () => undefined, reranker, savedSecretValues: async () => [],
    store: searchStore }) },
  { name: "without a reranker", search: createPastChatSearch({ embedder, recordUsage: () => undefined, savedSecretValues: async () => [],
    store: searchStore }) }
] as const;
type VariantName = (typeof VARIANTS)[number]["name"];
const reader = createPastChatReader({ savedSecretValues: async () => [], store: readStore });

const scores = new Map<VariantName, Map<string, ScenarioScore>>(VARIANTS.map((variant) => [variant.name, new Map()]));

async function runScenarios(variant: (typeof VARIANTS)[number]): Promise<void> {
  for (const scenario of fixtures.scenarios) {
    const timeZone = scenarioTimeZone(users, scenario);
    const input = scenarioSearchInput(scenario, NOW, timeZone);
    const current = scenarioCurrentChatKey(scenario);
    const outcome = await variant.search.search({ currentChatId: current ? idOf(current) : "no-current-chat", input, ownerId: idOf(scenario.user),
      timeZone });
    const results = outcome.kind === "searched" ? outcome.result.results : [];
    let read: ScenarioObservation["read"];
    const { expect: expected } = scenario;
    if (expected.read && expected.chat) {
      const chatId = idOf(`${scenario.user}/${expected.chat}`);
      const hit = results.find((result) => result.chatId === chatId &&
        (!expected.turn || result.messageId === idOf(`${scenario.user}/${expected.chat}/${expected.turn}/q`)));
      if (hit) {
        const outcomeRead = await reader.read({ input: { around_message_id: hit.messageId, chat_id: hit.chatId }, ownerId: idOf(scenario.user),
          timeZone });
        read = { messages: outcomeRead.kind === "read"
          ? outcomeRead.result.messages.map((message) => ({ messageKey: keyById.get(message.messageId) ?? null, text: message.text })) : [],
        outcome: outcomeRead.kind };
      }
    }
    const observation: ScenarioObservation = {
      degraded: outcome.kind === "searched" ? outcome.degraded : null, latencyMs: 0, outcome: outcome.kind,
      results: results.map((result) => ({ chatKey: keyById.get(result.chatId) ?? null, excerpt: result.excerpt,
        messageKey: keyById.get(result.messageId) ?? null })),
      rerank: outcome.kind === "searched" ? outcome.rerank : null,
      ...(read ? { read } : {})
    };
    scores.get(variant.name)!.set(scenario.id, scoreChatSearchScenario({ observation, scenario, searchInput: input, users }));
  }
}

beforeAll(async () => {
  // The corpus is indexed as the worker would find it, then the turns that settled minutes ago arrive.
  for (const chat of world.values()) if (!chat.seed.arrivesLate) markDirty(chat);
  await drain();
  for (const chat of world.values()) if (chat.seed.arrivesLate) markDirty(chat);
  await drain();
  // Changes after indexing that the search itself must honour, whether or not the index was cleared.
  for (const chat of world.values()) {
    if (chat.seed.mode === "deleted") chat.eligibility = { ...chat.eligibility, permanentDeletionAt: new Date(NOW) };
    if (chat.seed.mode === "excluded_after_index") chat.eligibility = { ...chat.eligibility, memoryMode: "EXCLUDED" };
  }
  for (const variant of VARIANTS) await runScenarios(variant);
});

describe.each(VARIANTS.map((variant) => [variant.name] as const))("past-chat search scenarios with a fake embedder, %s", (name) => {
  it.each(fixtures.scenarios.map((scenario): [string, string] => [scenario.id, scenario.class]))("%s (%s)", (id) => {
    const score = scores.get(name)!.get(id)!;
    expect({ reasons: score.reasons, violations: score.violations }).toEqual({ reasons: [], violations: 0 });
  });

  it("keeps the meaning lane in every search, and the reranker only where one is set", () => {
    const variantScores = [...scores.get(name)!.values()];
    expect(variantScores.every((score) => score.degraded === null)).toBe(true);
    const reranks = new Set(variantScores.flatMap((score) => score.rerank === null || score.rerank === "not_needed" ? [] : [score.rerank]));
    expect([...reranks]).toEqual([name === "with the reranker" ? "used" : "not_set"]);
  });

  it("reports every class content-free: no query, title, excerpt or id", () => {
    const report = chatSearchScenarioReport([...scores.get(name)!.values()]);
    expect(report).toMatchObject({ scenarios: fixtures.scenarios.length, passed: fixtures.scenarios.length, violations: 0 });
    expect(Object.keys(report.classes).sort()).toEqual([...new Set(fixtures.scenarios.map((scenario) => scenario.class))].sort());
    const text = JSON.stringify(report);
    for (const scenario of fixtures.scenarios) if (scenario.query) expect(text).not.toContain(scenario.query);
    for (const chat of chats) {
      expect(text).not.toContain(chat.title);
      expect(text).not.toContain(chat.key);
    }
  });
});

describe("the scenario corpus's index", () => {
  it("indexes only the active branch of eligible chats, each passage embedded by the current model", () => {
    const indexed = new Set(passages.map((passage) => passage.chatId));
    for (const chat of world.values()) {
      expect(indexed.has(chat.id)).toBe(chat.seed.mode === "normal" || chat.seed.mode === "deleted" || chat.seed.mode === "excluded_after_index");
    }
    expect(passages.some((passage) => passage.text.includes("Стратус"))).toBe(false);
    expect(passages.every((passage) => passage.model === MODEL)).toBe(true);
  });
});
