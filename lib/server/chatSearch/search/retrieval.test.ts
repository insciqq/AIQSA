import { describe, expect, it, vi } from "vitest";
import type { SearchPastChatsInput } from "../../../contracts/pastChats";
import { RerankAdapterError, type RerankRequest, type RerankResult } from "../../providers/rerank";
import { chatSearchEligible, type ChatSearchEligibilityFields } from "../eligibility";
import { ChatSearchEmbeddingError, type ChatSearchEmbedder, type ChatSearchEmbeddingModel } from "../embedder";
import type { ChatSearchUsageRecord } from "../usage";
import type { PastChatRerankResolution } from "./rerank";
import { createPastChatSearch, type PastChatSearchDependencies, type PastChatSearchOutcome } from "./retrieval";
import type { PastChatPassageRow, PastChatScope, PastChatSearchStore } from "./store";

/**
 * A store over seeded passages that behaves like the SQL (`store.ts`) where
 * the search depends on it: lexemes as the `simple` parser splits them (a
 * hyphenated word and its parts), prefix and phrase units, the eligibility
 * rule, the owner, the current chat and the turn range. The real SQL runs in
 * `store.prisma.test.ts`.
 */
type SeedChat = ChatSearchEligibilityFields & Readonly<{ id: string; title: string }>;
type SeedPassage = Readonly<{ id: string; chatId: string; userMessageId?: string; turnAt?: Date; text: string; vector?: readonly number[];
  model?: string }>;

const OWNER = "owner-1";
const CURRENT = "chat-current";
const MODEL = "embedding-model";

function chat(id: string, overrides: Partial<SeedChat> = {}): SeedChat {
  return { discord: false, id, importSource: null, memoryMode: "NORMAL", permanentDeletionAt: null, scheduledTaskId: null, title: `Title ${id}`,
    userId: OWNER, ...overrides };
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

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

function cosineDistance(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const norm = (vector: readonly number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return 1 - dot / (norm(left) * norm(right));
}

function createWorld(seedChats: readonly SeedChat[], seedPassages: readonly SeedPassage[]) {
  const chats = new Map(seedChats.map((entry) => [entry.id, entry]));
  const passages = seedPassages.map((passage, index) => ({ turnAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
    userMessageId: `turn-${passage.id}`, ...passage }));
  const switches = { memoryEnabled: true, pastChatSearchEnabled: true };
  const calls: string[] = [];
  const owned = (ownerId: string) => passages.filter((passage) => chats.get(passage.chatId)?.userId === ownerId);
  const inScope = (scope: Omit<PastChatScope, "range"> & Partial<Pick<PastChatScope, "range">>) => owned(scope.ownerId).filter((passage) => {
    const entry = chats.get(passage.chatId)!;
    return chatSearchEligible(entry, scope.ownerId) && passage.chatId !== scope.currentChatId &&
      (!scope.range?.from || passage.turnAt >= scope.range.from) && (!scope.range?.until || passage.turnAt < scope.range.until);
  });
  const matches = (query: string, text: string) => {
    if (query.startsWith("phrase:")) return containsRun(words(text), query.slice("phrase:".length).split(" "));
    if (query.endsWith(":*")) return [...lexemes(text)].some((lexeme) => lexeme.startsWith(query.slice(1, -3)));
    return lexemes(text).has(query.slice(1, -1));
  };
  const row = (passage: (typeof passages)[number]): PastChatPassageRow => ({ chatId: passage.chatId, id: passage.id, text: passage.text,
    title: chats.get(passage.chatId)!.title, turnAt: passage.turnAt, userMessageId: passage.userMessageId });
  const store: PastChatSearchStore = {
    async switches() {
      calls.push("switches");
      return switches;
    },
    async wordStatistics(ownerId, query, phrases) {
      calls.push("wordStatistics");
      const corpus = owned(ownerId);
      const stats: Array<{ key: string; kind: "exact" | "prefix" | "phrase"; query: string }> = [...lexemes(query)].flatMap((lexeme) => [
        { key: lexeme, kind: "exact" as const, query: `'${lexeme}'` },
        ...(lexeme.length >= 4 ? [{ key: lexeme, kind: "prefix" as const, query: `'${lexeme}':*` }] : [])
      ]);
      for (const phrase of phrases) {
        const run = words(phrase);
        stats.push({ key: phrase, kind: "phrase", query: run.length === 1 ? `'${run[0]}'` : `phrase:${run.join(" ")}` });
      }
      return stats.map((entry) => ({ ...entry, documentFrequency: corpus.filter((passage) => matches(entry.query, passage.text)).length,
        passages: corpus.length }));
    },
    async wordHits(scope, units, limit) {
      calls.push("wordHits");
      return inScope(scope).flatMap((passage) => {
        const terms = new Map<string, { admits: boolean; weight: number; pin: boolean }>();
        for (const unit of units) {
          if (!matches(unit.query, passage.text)) continue;
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
      calls.push("vectorHits");
      return inScope(scope).filter((passage) => passage.model === vector.providerModelId && passage.vector?.length === vector.values.length)
        .map((passage) => ({ distance: cosineDistance(passage.vector!, vector.values), passage }))
        .sort((left, right) => left.distance - right.distance || (left.passage.id < right.passage.id ? -1 : 1))
        .slice(0, limit).map(({ passage }) => ({ chatId: passage.chatId, id: passage.id, turnAt: passage.turnAt, userMessageId: passage.userMessageId }));
    },
    async passages(scope, ids) {
      calls.push("passages");
      return inScope(scope).filter((passage) => ids.includes(passage.id)).map(row);
    },
    async recent(scope, limit) {
      calls.push("recent");
      const latest = new Map<string, (typeof passages)[number]>();
      for (const passage of inScope(scope)) {
        const known = latest.get(passage.chatId);
        if (!known || passage.turnAt > known.turnAt) latest.set(passage.chatId, passage);
      }
      return [...latest.values()].sort((left, right) => right.turnAt.getTime() - left.turnAt.getTime()).slice(0, limit).map(row);
    }
  };
  return { calls, store, switches };
}

type EmbedBehaviour = (texts: readonly string[], signal?: AbortSignal) => Promise<readonly (readonly number[])[]>;

function embedder(vectors: Readonly<Record<string, readonly number[]>>, options: Readonly<{ model?: ChatSearchEmbeddingModel; embed?: EmbedBehaviour }> = {}) {
  const texts: string[] = [];
  const fake: ChatSearchEmbedder = {
    currentModel: async () => options.model ?? { kind: "model", providerModelId: MODEL },
    async embed(request) {
      texts.push(...request.texts);
      expect(request).toMatchObject({ latencyClass: "interactive", mode: "query", providerModelId: MODEL, userId: OWNER });
      const result = options.embed ? await options.embed(request.texts, request.signal)
        : request.texts.map((text) => vectors[text] ?? [0, 0, 1]);
      return { dimension: result[0]?.length ?? 0, vectors: result };
    }
  };
  return { fake, texts };
}

function reranker(resolution: PastChatRerankResolution | ((request: RerankRequest) => Promise<RerankResult>)) {
  const requests: RerankRequest[] = [];
  const binding = { connectionId: "conn", credentialId: "cred", credentialSource: "default" as const, credentialVersionId: "credv",
    modelId: "upstream/reranker", provider: "openrouter", providerModelId: "reranker" };
  const resolved: PastChatRerankResolution = typeof resolution === "function"
    ? { kind: "ready", route: { binding, rerank: async (request) => {
      requests.push(request);
      return resolution(request);
    } } }
    : resolution;
  return { fake: { resolve: async () => resolved }, requests };
}

const usage = { costUsd: 0.0001, inputTokens: 100, searchUnits: null, totalTokens: 100 };

function search(dependencies: Partial<PastChatSearchDependencies> & Pick<PastChatSearchDependencies, "store">, input: SearchPastChatsInput,
  options: Readonly<{ timeZone?: string; signal?: AbortSignal }> = {}): Promise<PastChatSearchOutcome> {
  return createPastChatSearch({ embedder: embedder({}).fake, recordUsage: () => undefined, savedSecretValues: async () => [], ...dependencies })
    .search({ currentChatId: CURRENT, input, ownerId: OWNER, timeZone: options.timeZone ?? "UTC", ...(options.signal ? { signal: options.signal } : {}) });
}

function searched(outcome: PastChatSearchOutcome) {
  if (outcome.kind !== "searched") throw new Error(`expected a search, got ${outcome.kind}`);
  return outcome;
}

const ids = (outcome: PastChatSearchOutcome) => searched(outcome).result.results.map((result) => result.chatId);

describe("past-chat search ranking", () => {
  const world = () => createWorld([chat("ticket"), chat("similar"), chat("costs"), chat("noise")], [
    { chatId: "ticket", id: "p-ticket", text: "Ticket ABC-1234 is blocked by the database migration.", vector: [0, 0.2, 1], model: MODEL },
    { chatId: "similar", id: "p-similar", text: "The rollout of a similar ticket went smoothly after the canary.", vector: [1, 0, 0.1], model: MODEL },
    { chatId: "costs", id: "p-costs", text: "We cut the AWS bill with reserved instances and spot capacity.", vector: [0.1, 1, 0], model: MODEL },
    { chatId: "noise", id: "p-noise", text: "Lunch options near the office.", vector: [0, 0, 1], model: MODEL }
  ]);

  it("ranks an exact identifier above semantically similar text", async () => {
    const { store } = world();
    const { fake } = embedder({ "ABC-1234 rollout": [1, 0, 0] });
    const outcome = searched(await search({ embedder: fake, store }, { query: "ABC-1234 rollout" }));
    expect(outcome.degraded).toBeNull();
    expect(outcome.result.mode).toBe("relevance");
    expect(outcome.result.results[0]).toMatchObject({ chatId: "ticket", chatTitle: "Title ticket", messageId: "turn-p-ticket" });
    expect(outcome.result.results[0]!.excerpt).toContain("ABC-1234");
    expect(outcome.result.results.map((result) => result.chatId).slice(0, 2)).toEqual(["ticket", "similar"]);
  });

  it("finds a paraphrase that shares no word with the query by meaning", async () => {
    const { store } = world();
    const { fake, texts } = embedder({ "reduce infrastructure spending": [0, 1, 0] });
    const outcome = searched(await search({ embedder: fake, store }, { query: "reduce infrastructure spending" }));
    expect(texts).toEqual(["reduce infrastructure spending"]);
    expect(outcome.result.results[0]).toMatchObject({ chatId: "costs" });
    expect(outcome.result.results[0]!.date).toBe("2026-11-01T00:02:00Z");
  });

  it("gives one chat at most three results and keeps each turn once", async () => {
    const long = Array.from({ length: 6 }, (_, index) => ({ chatId: "long", id: `long-${index}`, text: `Quarterly budget review part ${index}` }));
    const { store } = createWorld([chat("long"), chat("a"), chat("b")], [
      ...long,
      // A second window of the same turn as long-0.
      { chatId: "long", id: "long-0b", text: "More on the quarterly budget", userMessageId: "turn-long-0" },
      { chatId: "a", id: "a-1", text: "The budget for the offsite" },
      { chatId: "b", id: "b-1", text: "Budget approvals" }
    ]);
    const { fake } = embedder({}, { model: { kind: "unset" } });
    const outcome = searched(await search({ embedder: fake, store }, { query: "quarterly budget" }));
    const results = outcome.result.results;
    expect(results.filter((result) => result.chatId === "long")).toHaveLength(3);
    expect(new Set(results.map((result) => `${result.chatId}:${result.messageId}`)).size).toBe(results.length);
    expect(results.map((result) => result.chatId)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("keeps the turns of the days asked for, in the user's time zone", async () => {
    // 21:30 UTC on 10 November is already 11 November in Moscow.
    const { store } = createWorld([chat("early"), chat("late"), chat("after")], [
      { chatId: "early", id: "e", text: "invoice draft", turnAt: new Date("2026-11-10T20:30:00Z") },
      { chatId: "late", id: "l", text: "invoice sent", turnAt: new Date("2026-11-10T21:30:00Z") },
      { chatId: "after", id: "a", text: "invoice paid", turnAt: new Date("2026-11-12T21:00:00Z") }
    ]);
    const { fake } = embedder({}, { model: { kind: "unset" } });
    const outcome = searched(await search({ embedder: fake, store }, { after: "2026-11-11", before: "2026-11-13", query: "invoice" },
      { timeZone: "Europe/Moscow" }));
    expect(outcome.result.results.map((result) => result.chatId)).toEqual(["late"]);
    expect(outcome.result.results[0]!.date).toBe("2026-11-11T00:30:00+03:00");
  });
});

describe("past-chat search and common words", () => {
  // Sixty chats: every passage says "the"; one names the invoice; one is a late bill told in other words; six say "for".
  const text = (index: number) => index === 7 ? "the Orbita invoice is overdue" : index === 9 ? "the bill from Orbita came late"
    : index >= 20 && index < 26 ? `the note for team ${index}` : `the note number ${index}`;
  const world = () => createWorld(Array.from({ length: 60 }, (_, index) => chat(`c${index}`)), Array.from({ length: 60 }, (_, index) => ({
    chatId: `c${index}`, id: `p${index}`, model: MODEL, text: text(index),
    vector: index === 9 ? [1, 0, 0] : index >= 20 && index < 26 ? [0.7, 0.7, 0] : [0, 0.3, 1]
  })));

  it("brings no passage in by a word most passages hold, but lets it add weight to one another word brought in", async () => {
    const { store } = world();
    const unset = embedder({}, { model: { kind: "unset" } }).fake;
    expect(ids(await search({ embedder: unset, store }, { query: "the invoice" }))).toEqual(["c7"]);
    // A query of common words only still finds what holds them.
    expect(searched(await search({ embedder: unset, store }, { query: "the" })).result.results).toHaveLength(8);
  });

  it("keeps a meaning-only match above passages that share only a weak word with the query", async () => {
    const { store } = world();
    // The six "for" notes sit in both lanes, low in each; the late bill shares no word but "the" and leads the meaning lane.
    const query = "overdue payment for the services";
    const { fake } = embedder({ [query]: [1, 0, 0] });
    expect(ids(await search({ embedder: fake, store }, { query }))[0]).toBe("c9");
    // Without meaning search the word matches are all there is.
    expect(ids(await search({ embedder: embedder({}, { model: { kind: "unset" } }).fake, store }, { query })))
      .toEqual(["c7", "c25", "c24", "c23", "c22", "c21", "c20"]);
  });
});

describe("past-chat search degradation", () => {
  const world = () => createWorld([chat("a"), chat("b")], [
    { chatId: "a", id: "pa", text: "Deploy checklist for the payments service", vector: [1, 0, 0], model: MODEL },
    { chatId: "b", id: "pb", text: "Payments refund policy", vector: [0, 1, 0], model: MODEL }
  ]);

  it("answers with words and names why when meaning search is not set, fails or is late", async () => {
    for (const [options, reason] of [
      [{ model: { kind: "unset" } }, "meaning_search_not_set"],
      [{ model: { kind: "unavailable", code: "embedding_unavailable", providerModelId: MODEL } }, "meaning_search_unavailable"],
      [{ embed: async () => {
        throw new ChatSearchEmbeddingError("embedding_provider_http_error");
      } }, "meaning_search_failed"],
      [{ embed: () => new Promise<never>(() => undefined) }, "meaning_search_timed_out"]
    ] as const) {
      const { store } = world();
      const outcome = searched(await createPastChatSearch({ embedder: embedder({}, options).fake, recordUsage: () => undefined,
        savedSecretValues: async () => [], store, timeouts: { embeddingMs: 20 } })
        .search({ currentChatId: CURRENT, input: { query: "payments" }, ownerId: OWNER, timeZone: "UTC" }));
      expect(outcome.degraded).toBe(reason);
      expect(outcome.result.results.map((result) => result.chatId).sort()).toEqual(["a", "b"]);
    }
  });

  it("fails visibly when the word search itself cannot run", async () => {
    const { store } = world();
    const outcome = await search({ store: { ...store, wordHits: async () => {
      throw new Error("database down");
    } } }, { query: "payments" });
    expect(outcome).toEqual({ code: "past_chats_store_failed", kind: "failed" });
  });

  it("stops with the caller", async () => {
    const { store } = world();
    const controller = new AbortController();
    const pending = search({ embedder: embedder({}, { embed: () => new Promise<never>(() => undefined) }).fake, store }, { query: "payments" },
      { signal: controller.signal });
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });
});

describe("past-chat search reranking", () => {
  const world = () => createWorld([chat("a"), chat("b"), chat("c")], [
    { chatId: "a", id: "pa", text: "Payments deploy checklist, payments rollback" },
    { chatId: "b", id: "pb", text: "Payments refund policy" },
    { chatId: "c", id: "pc", text: "Payments team offsite" }
  ]);
  const unset = embedder({}, { model: { kind: "unset" } }).fake;

  it("reorders the fused candidates by the reranker's scores and records its usage after the call", async () => {
    const { store } = world();
    const events: ChatSearchUsageRecord[] = [];
    const fused = ids(await search({ embedder: unset, store }, { query: "payments" }));
    const rerank = reranker(async (request) => ({ model: "reranker", provider: "x", requestId: "req-1", usage,
      scores: request.documents.map((document, index) => ({ handle: document.handle, index, relevanceScore: index })) }));
    const outcome = searched(await search({ embedder: unset, recordUsage: (event) => {
      events.push(event);
    }, reranker: rerank.fake, store }, { query: "payments" }));
    expect(outcome.rerank).toBe("used");
    expect(outcome.result.results.map((result) => result.chatId)).toEqual([...fused].reverse());
    expect(rerank.requests[0]!.query).toBe("payments");
    expect(rerank.requests[0]!.documents.map((document) => document.handle)).toEqual(["d1", "d2", "d3"]);
    // The record `recordChatSearchUsage` takes as it is.
    await vi.waitFor(() => expect(events).toEqual([{ chatId: CURRENT, costUsd: usage.costUsd, modelId: "upstream/reranker", modelRunId: null,
      provider: "openrouter", providerModelId: "reranker", purpose: "memory_retrieval", usage: { inputTokens: 100, totalTokens: 100 },
      userId: OWNER }]));
  });

  it("keeps the fused order when the reranker fails, returns partial coverage or is unusable, and never asks another", async () => {
    const { store } = world();
    const fused = ids(await search({ embedder: unset, store }, { query: "payments" }));
    const events: ChatSearchUsageRecord[] = [];
    const failing = reranker(async () => {
      throw new RerankAdapterError("rerank_provider_http_error", { httpStatus: 503, usage });
    });
    const partial = reranker(async (request) => ({ model: "reranker", provider: "x", requestId: null, usage,
      scores: [{ handle: request.documents[0]!.handle, index: 0, relevanceScore: 1 }] }));
    const duplicated = reranker(async (request) => ({ model: "reranker", provider: "x", requestId: null, usage,
      scores: request.documents.map((_, index) => ({ handle: "d1", index, relevanceScore: index })) }));
    for (const fake of [failing.fake, partial.fake, duplicated.fake, reranker({ kind: "unavailable", providerModelId: "reranker" }).fake]) {
      const outcome = searched(await search({ embedder: unset, recordUsage: (event) => {
        events.push(event);
      }, reranker: fake, store }, { query: "payments" }));
      expect(outcome.rerank).toBe("failed");
      expect(outcome.result.results.map((result) => result.chatId)).toEqual(fused);
    }
    // The failed call and the two whose ranking was refused reported usage; the unusable route made no call.
    await vi.waitFor(() => expect(events).toHaveLength(3));
    const notSet = searched(await search({ embedder: unset, reranker: reranker({ kind: "unset" }).fake, store }, { query: "payments" }));
    expect(notSet.rerank).toBe("not_set");
    expect(notSet.result.results.map((result) => result.chatId)).toEqual(fused);
  });
});

describe("past-chat search authority and listing", () => {
  const deleted = new Date("2026-11-20T00:00:00Z");
  const world = () => createWorld([
    chat("mine"), chat("current-chat", { id: CURRENT }), chat("foreign", { userId: "owner-2" }), chat("temporary", { memoryMode: "TEMPORARY" }),
    chat("excluded", { memoryMode: "EXCLUDED" }), chat("deleted", { permanentDeletionAt: deleted }), chat("imported", { importSource: "chatgpt" }),
    chat("scheduled", { scheduledTaskId: "task-1" }), chat("discord", { discord: true })
  ], ["mine", CURRENT, "foreign", "temporary", "excluded", "deleted", "imported", "scheduled", "discord"].map((id, index) => ({
    chatId: id, id: `p-${id}`, text: `Vendor contract renewal notes ${index}`, vector: [1, 0, 0], model: MODEL
  })));

  it("never returns another user's, the current, a Temporary, Excluded, deleted, imported, scheduled or Discord chat", async () => {
    const { store } = world();
    const { fake } = embedder({ "vendor contract": [1, 0, 0] });
    expect(ids(await search({ embedder: fake, store }, { query: "vendor contract" }))).toEqual(["mine"]);
    expect(ids(await search({ embedder: fake, store }, {}))).toEqual(["mine"]);
  });

  it("lists the most recent chats, each once by its latest turn, newest first, within the days asked for", async () => {
    const { store } = createWorld([chat("a"), chat("b"), chat("c")], [
      { chatId: "a", id: "a1", text: "Chat: Title a\n\nUser: First question in a", turnAt: new Date("2026-11-01T10:00:00Z") },
      { chatId: "a", id: "a2", text: "Chat: Title a\nFiles: plan.pdf\n\nUser: Latest question in a\n\nAssistant: An answer",
        turnAt: new Date("2026-11-05T10:00:00Z") },
      { chatId: "b", id: "b1", text: "Chat: Title b\n\nUser: Only question in b", turnAt: new Date("2026-11-03T10:00:00Z") },
      { chatId: "c", id: "c1", text: "Chat: Title c\n\nUser: Old question in c", turnAt: new Date("2026-10-01T10:00:00Z") }
    ]);
    const outcome = searched(await search({ store }, { query: null, limit: 5 }));
    expect(outcome.result.mode).toBe("recent");
    expect(outcome.result.results.map((result) => [result.chatId, result.excerpt])).toEqual([
      ["a", "User: Latest question in a\n\nAssistant: An answer"], ["b", "User: Only question in b"], ["c", "User: Old question in c"]]);
    expect(ids(await search({ store }, { after: "2026-11-02" }))).toEqual(["a", "b"]);
    expect(ids(await search({ store }, { before: "2026-11-02", limit: 1 }))).toEqual(["a"]);
  });

  it("refuses when Memory or past-chat search is off, before reading anything", async () => {
    for (const off of [{ memoryEnabled: false }, { pastChatSearchEnabled: false }]) {
      const { calls, store, switches } = world();
      Object.assign(switches, off);
      expect(await search({ store }, { query: "vendor" })).toEqual({ kind: "disabled" });
      expect(calls).toEqual(["switches"]);
    }
  });
});

describe("past-chat search redaction", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const saved = "saved-value-1234567890-xyz";

  it("takes recognized and saved secrets out of the query before any provider sees it", async () => {
    const { store } = createWorld([chat("a")], [{ chatId: "a", id: "pa", text: `Rotate the gateway key ${saved} on Friday` }]);
    const { fake, texts } = embedder({});
    const rerank = reranker(async (request) => ({ model: "r", provider: "x", requestId: null, usage,
      scores: request.documents.map((document, index) => ({ handle: document.handle, index, relevanceScore: 1 })) }));
    const outcome = searched(await search({ embedder: fake, reranker: rerank.fake, savedSecretValues: async () => [saved], store },
      { query: `gateway key ${secret} ${saved}` }));
    expect(texts).toEqual(["gateway key"]);
    expect(outcome.result.results[0]!.excerpt).toBe("Rotate the gateway key [REDACTED:SAVED_SECRET] on Friday");
    expect(await search({ store }, { query: secret })).toEqual({ kind: "query_unusable" });
  });

  it("redacts what an excerpt and a title show, whatever the index kept", async () => {
    const { store } = createWorld([chat("a", { title: `Keys ${secret}` })], [{ chatId: "a", id: "pa", text: `api key ${secret} for staging` }]);
    const outcome = searched(await search({ embedder: embedder({}, { model: { kind: "unset" } }).fake, store }, { query: "staging" }));
    expect(JSON.stringify(outcome.result)).not.toContain(secret);
    expect(outcome.result.results[0]!.chatTitle).toContain("[REDACTED");
  });
});

describe("past-chat search bounds", () => {
  it("keeps the result within its size by shortening excerpts, never past the limit asked for", async () => {
    const long = (index: number) => `shared topic ${index} ${"lorem ipsum ".repeat(400)}`;
    const { store } = createWorld(Array.from({ length: 20 }, (_, index) => chat(`c${index}`)),
      Array.from({ length: 20 }, (_, index) => ({ chatId: `c${index}`, id: `p${index}`, text: long(index) })));
    const outcome = searched(await search({ embedder: embedder({}, { model: { kind: "unset" } }).fake, store }, { query: "shared topic", limit: 20 }));
    expect(outcome.result.results).toHaveLength(20);
    expect(JSON.stringify(outcome.result).length).toBeLessThanOrEqual(20_000);
    expect(outcome.result.results.every((result) => result.excerpt.length <= 1_200)).toBe(true);
    const few = searched(await search({ embedder: embedder({}, { model: { kind: "unset" } }).fake, store }, { query: "shared topic", limit: 2 }));
    expect(few.result.results).toHaveLength(2);
    expect(few.result.results[0]!.excerpt.length).toBe(1_200);
  });
});
