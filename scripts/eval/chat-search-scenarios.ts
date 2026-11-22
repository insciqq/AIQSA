/**
 * Opt-in stand run of the past-chat search scenarios (`tests/fixtures/chat-search/`) against a DISPOSABLE AIQSA
 * database with the installation's real past-chat embedding model and reranker. Never a default lane and never a
 * persistent installation: it refuses to start unless `scripts/stateful-test-target.ts` accepts the target (the
 * disposable `docker-compose.dev.yml` database, `AIQSA_TEST_MODE=1`, `AIQSA_STATEFUL_TEST_TARGET=DISPOSABLE`) and
 * `AIQSA_CHAT_SEARCH_SCENARIOS=DISPOSABLE` is set.
 *
 * What it does, through the product's own modules (no HTTP, no answer model):
 * 1. creates one synthetic user per corpus user and their chats and messages (an edited turn as a sibling branch,
 *    files as ready attachments), marks each chat dirty (`markChatSearchDirty`) and drains the index pass
 *    (`runChatSearchIndexPass` with `createChatSearchEmbedder`) for these users only;
 * 2. then seeds the chats that "arrive late" (a turn settled minutes ago), drains again and times how long they took
 *    to become searchable;
 * 3. fences the chats the corpus deletes and excludes the ones it excludes after indexing, without clearing their
 *    passages, so the search's own rule is what keeps them out;
 * 4. runs every scenario through the real search (`createPastChatSearch` over the Prisma store, the embedder and the
 *    selected reranker) and, where a scenario reads, the real reader;
 * 5. prints ONE content-free JSON document: the roles' state, index counts, hit@1/3/5 per scenario class, latency
 *    percentiles, outcomes, failures by scenario id with reason codes, provider-reported usage totals and the
 *    threshold verdict; then deletes everything it created (usage rows of its users included).
 *
 * Exit 0 when every never rule held and no recorded threshold was missed (`CHAT_SEARCH_SCENARIO_THRESHOLDS` in
 * `./chat-search-scenarios-support.ts`, null until the first real run sets them); 1 otherwise; 2 when it refused.
 * Paid calls: the corpus's passages are embedded once (about 50 texts in two or three requests), and each of the
 * 42 scenarios with a query makes one query embedding and at most one rerank call.
 *
 * Environment (process only):
 * - AIQSA_CHAT_SEARCH_SCENARIOS=DISPOSABLE (required acknowledgement), plus the stateful target variables above
 * - AIQSA_CHAT_SEARCH_WORDS_ONLY=1 runs without the embedding model (word search only, a baseline); without it an
 *   embedding role that is not set or not usable refuses the run
 * - AIQSA_CHAT_SEARCH_DRAIN_TIMEOUT_MS (default 600000) bounds each index drain
 *
 * Run it inside the disposable app container, for example:
 *   docker compose -f docker-compose.dev.yml exec -T -e AIQSA_STATEFUL_TEST_TARGET=DISPOSABLE \
 *     -e AIQSA_CHAT_SEARCH_SCENARIOS=DISPOSABLE app npx tsx scripts/eval/chat-search-scenarios.ts
 */
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { ChatSearchEmbedder } from "../../lib/server/chatSearch/embedder";
import { createChatSearchEmbedder } from "../../lib/server/chatSearch/embedderPrisma";
import { markChatSearchDirty } from "../../lib/server/chatSearch/index/dirty";
import { runChatSearchIndexPass, type ChatSearchIndexPassSummary } from "../../lib/server/chatSearch/index/pass";
import { createPastChatReader, createPrismaPastChatReadStore } from "../../lib/server/chatSearch/search/read";
import { createSavedSecretValuesReader } from "../../lib/server/chatSearch/search/redaction";
import { createPrismaPastChatReranker } from "../../lib/server/chatSearch/search/rerank";
import { createPastChatSearch } from "../../lib/server/chatSearch/search/retrieval";
import { createPrismaPastChatSearchStore } from "../../lib/server/chatSearch/search/store";
import type { ChatSearchUsageRecord } from "../../lib/server/chatSearch/usage";
import { prisma } from "../../lib/server/prisma";
import { assertDisposableStatefulTestTarget } from "../stateful-test-target";
import {
  CHAT_SEARCH_SCENARIO_THRESHOLDS,
  chatSearchScenarioReport,
  chatSearchThresholdBreaches,
  loadChatSearchFixtures,
  materializeChatSearchCorpus,
  percentile,
  scenarioCurrentChatKey,
  scenarioSearchInput,
  scenarioTimeZone,
  scoreChatSearchScenario,
  type ScenarioObservation,
  type ScenarioScore,
  type SeedChat,
  type SeedUser
} from "./chat-search-scenarios-support";

const ACKNOWLEDGEMENT = "AIQSA_CHAT_SEARCH_SCENARIOS";
const TEMPORARY_POLICY = "temporary-24h-v1";
const DAY_MS = 24 * 60 * 60_000;
const MIME_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pdf: "application/pdf",
  png: "image/png", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function print(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type UsageTotals = Record<string, { calls: number; inputTokens: number; totalTokens: number; costUsd: number; costUnknown: number }>;

/** Provider-reported usage, totalled in memory and printed; the stand's usage ledger is not the point here. */
function usageRecorder(totals: UsageTotals, source: "embedder" | "reranker") {
  return (record: ChatSearchUsageRecord) => {
    const kind = source === "reranker" ? "rerank" : record.purpose === "memory_indexing" ? "document_embedding" : "query_embedding";
    const entry = totals[kind] ??= { calls: 0, costUnknown: 0, costUsd: 0, inputTokens: 0, totalTokens: 0 };
    entry.calls += 1;
    entry.inputTokens += record.usage.inputTokens ?? 0;
    entry.totalTokens += record.usage.totalTokens ?? 0;
    if (typeof record.costUsd === "number") entry.costUsd += record.costUsd;
    else entry.costUnknown += 1;
    return Promise.resolve();
  };
}

/** Real ids of what the run created, and the fixture keys they stand for. */
type Created = {
  owners: Map<string, string>;
  chatIds: Map<string, string>;
  keyByChatId: Map<string, string>;
  keyByMessageId: Map<string, string>;
};

async function seedChat(created: Created, user: SeedUser, chat: SeedChat): Promise<string> {
  const userId = created.owners.get(user.key)!;
  const temporary = chat.mode === "temporary";
  const row = await prisma.chat.create({ data: {
    createdAt: chat.createdAt, memoryMode: chat.mode === "excluded" ? "EXCLUDED" : temporary ? "TEMPORARY" : "NORMAL",
    title: chat.title, userId,
    ...(temporary ? { temporaryRetentionDeadline: new Date(chat.createdAt.getTime() + DAY_MS), temporaryRetentionPolicyVersion: TEMPORARY_POLICY } : {})
  }, select: { id: true } });
  created.chatIds.set(chat.key, row.id);
  created.keyByChatId.set(row.id, chat.key);
  const ids = new Map<string, string>();
  for (const message of chat.messages) {
    const saved = await prisma.message.create({ data: {
      chatId: row.id, content: { blocks: [{ text: message.text, type: "text" }] }, createdAt: message.createdAt,
      parentMessageId: message.parentKey ? ids.get(message.parentKey)! : null, role: message.role, status: "complete"
    }, select: { id: true } });
    ids.set(message.key, saved.id);
    created.keyByMessageId.set(saved.id, message.key);
    for (const fileName of message.files) {
      const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
      await prisma.attachment.create({ data: {
        byteSize: 1, chatId: row.id, createdAt: message.createdAt, fileName, kind: "file", messageId: saved.id, metadata: {},
        mimeType: MIME_TYPES[extension] ?? "application/octet-stream", status: "ready", storageKey: `chat-search-scenarios/${randomUUID()}`, userId
      } });
    }
  }
  // The leaf moves and the chat is marked in one transaction, chat row first, as run settlement does.
  await prisma.$transaction(async (tx) => {
    await tx.chat.update({ data: { activeLeafMessageId: ids.get(chat.activeLeafKey)! }, where: { id: row.id } });
    await markChatSearchDirty(tx, { chatId: row.id, userId });
  });
  return row.id;
}

type IndexTotals = { passes: number; claimed: number; indexed: number; cleared: number; stale: number; gone: number; failed: number;
  embedded: number; models: Record<string, number> };

async function drain(embedder: ChatSearchEmbedder, ownerIds: readonly string[], totals: IndexTotals, timeoutMs: number): Promise<number> {
  const started = performance.now();
  for (;;) {
    const summary: ChatSearchIndexPassSummary = await runChatSearchIndexPass({ db: prisma, embedder, limits: { ownerIds } });
    totals.passes += 1;
    for (const key of ["claimed", "indexed", "cleared", "stale", "gone", "failed", "embedded"] as const) totals[key] += summary[key];
    totals.models[summary.model] = (totals.models[summary.model] ?? 0) + 1;
    if (summary.more) continue;
    const due = await prisma.chatSearchState.count({ where: { dirtyAt: { not: null }, nextAttemptAt: null, userId: { in: [...ownerIds] } } });
    const backingOff = await prisma.chatSearchState.count({ where: { dirtyAt: { not: null }, nextAttemptAt: { not: null }, userId: { in: [...ownerIds] } } });
    if (backingOff > 0) {
      // The recorded codes are content-free (`ChatSearchState_error_code_check`), so the refusal names them.
      const codes = await prisma.chatSearchState.findMany({ distinct: ["lastErrorCode"], select: { lastErrorCode: true },
        where: { dirtyAt: { not: null }, nextAttemptAt: { not: null }, userId: { in: [...ownerIds] } } });
      throw new Refusal(`index_embedding_failed:${codes.map((row) => row.lastErrorCode ?? "none").sort().join(",")}`);
    }
    if (due === 0) return Math.round(performance.now() - started);
    if (performance.now() - started > timeoutMs) throw new Refusal("index_drain_timed_out");
    // Another worker (the stand's own) may hold a claim: wait for its lease.
    await sleep(1_000);
  }
}

async function cleanup(created: Created): Promise<Readonly<{ ok: boolean; step?: string }>> {
  const owners = [...created.owners.values()];
  if (owners.length === 0) return { ok: true };
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["usage", () => prisma.usageEvent.deleteMany({ where: { userId: { in: owners } } })],
    // A Temporary chat is deleted only after its deadline (`aiqsa_temporary_chat_delete_guard`): move it into the past.
    ["temporary", () => prisma.$executeRaw`
      UPDATE "Chat" SET "createdAt" = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '2 days',
        "temporaryRetentionDeadline" = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 minute'
      WHERE "userId" IN (${Prisma.join(owners)}) AND "memoryMode" = 'TEMPORARY'::"MemoryChatMode"`],
    ["chats", () => prisma.chat.deleteMany({ where: { userId: { in: owners } } })],
    ["attachments", () => prisma.attachment.deleteMany({ where: { userId: { in: owners } } })],
    ["users", () => prisma.user.deleteMany({ where: { id: { in: owners } } })]
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch {
      return { ok: false, step };
    }
  }
  const left = await prisma.user.count({ where: { id: { in: owners } } }).catch(() => -1);
  return left === 0 ? { ok: true } : { ok: false, step: "verify" };
}

export async function runChatSearchScenariosOnStand(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  assertDisposableStatefulTestTarget(environment);
  if (environment[ACKNOWLEDGEMENT] !== "DISPOSABLE") throw new Refusal("chat_search_scenarios_not_acknowledged");
  const wordsOnly = environment.AIQSA_CHAT_SEARCH_WORDS_ONLY === "1";
  const drainTimeoutMs = Number(environment.AIQSA_CHAT_SEARCH_DRAIN_TIMEOUT_MS ?? 600_000);
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 10_000 || drainTimeoutMs > 3_600_000) throw new Refusal("drain_timeout_invalid");

  const fixtures = loadChatSearchFixtures();
  const now = new Date();
  const users = materializeChatSearchCorpus(fixtures.corpus, now);
  const usage: UsageTotals = {};
  const realEmbedder = createChatSearchEmbedder(prisma, { recordUsage: usageRecorder(usage, "embedder") });
  const embedder: ChatSearchEmbedder = wordsOnly
    ? { currentModel: async () => ({ kind: "unset" }), embed: async () => Promise.reject(new Error("words_only")) }
    : realEmbedder;
  const embeddingRole = await realEmbedder.currentModel();
  if (!wordsOnly && embeddingRole.kind !== "model") throw new Refusal(`embedding_role_${embeddingRole.kind}`);
  const reranker = createPrismaPastChatReranker(prisma);
  const rerankRole = (await reranker.resolve()).kind;

  const run = randomUUID().slice(0, 8);
  const created: Created = { chatIds: new Map(), keyByChatId: new Map(), keyByMessageId: new Map(), owners: new Map() };
  let cleaned: Readonly<{ ok: boolean; step?: string }> = { ok: true };
  try {
    for (const user of users) {
      const id = `chat-search-scenarios-${run}-${user.key}`;
      await prisma.user.create({ data: { displayName: "Chat search scenario user", id, status: "active" } });
      created.owners.set(user.key, id);
    }
    const ownerIds = [...created.owners.values()];
    const index: IndexTotals = { claimed: 0, cleared: 0, embedded: 0, failed: 0, gone: 0, indexed: 0, models: {}, passes: 0, stale: 0 };

    for (const user of users) for (const chat of user.chats) if (!chat.arrivesLate) await seedChat(created, user, chat);
    const drainMs = await drain(embedder, ownerIds, index, drainTimeoutMs);
    const lateStarted = performance.now();
    for (const user of users) for (const chat of user.chats) if (chat.arrivesLate) await seedChat(created, user, chat);
    await drain(embedder, ownerIds, index, drainTimeoutMs);
    const freshIndexMs = Math.round(performance.now() - lateStarted);

    // After indexing: a deletion's fence and an exclusion nobody cleared. The search's own rule must keep both out.
    for (const chat of users.flatMap((user) => user.chats)) {
      const id = created.chatIds.get(chat.key)!;
      if (chat.mode === "deleted") {
        await prisma.chat.update({ data: { archived: true, permanentDeletionAt: new Date(), permanentDeletionOperationId: randomUUID() },
          where: { id } });
      } else if (chat.mode === "excluded_after_index") {
        await prisma.chat.update({ data: { memoryMode: "EXCLUDED" }, where: { id } });
      }
    }
    const passages = await prisma.chatSearchPassage.count({ where: { userId: { in: ownerIds } } });
    const embeddedPassages = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "ChatSearchPassage" WHERE "userId" = ANY(${ownerIds}::text[]) AND "embedding" IS NOT NULL`;

    const savedSecretValues = createSavedSecretValuesReader(prisma);
    const search = createPastChatSearch({ embedder, recordUsage: usageRecorder(usage, "reranker"), reranker, savedSecretValues,
      store: createPrismaPastChatSearchStore(prisma) });
    const reader = createPastChatReader({ savedSecretValues, store: createPrismaPastChatReadStore(prisma) });
    const scores: ScenarioScore[] = [];
    const readLatencies: number[] = [];
    for (const scenario of fixtures.scenarios) {
      const timeZone = scenarioTimeZone(users, scenario);
      const input = scenarioSearchInput(scenario, now, timeZone);
      const ownerId = created.owners.get(scenario.user)!;
      const currentKey = scenarioCurrentChatKey(scenario);
      const started = performance.now();
      const outcome = await search.search({ currentChatId: currentKey ? created.chatIds.get(currentKey)! : randomUUID(), input, ownerId, timeZone });
      const latencyMs = Math.round(performance.now() - started);
      const results = outcome.kind === "searched" ? outcome.result.results : [];
      let read: ScenarioObservation["read"];
      const expected = scenario.expect;
      if (expected.read && expected.chat) {
        const chatKey = `${scenario.user}/${expected.chat}`;
        const turnKey = expected.turn ? `${chatKey}/${expected.turn}/q` : null;
        const hit = results.find((result) => created.keyByChatId.get(result.chatId) === chatKey &&
          (turnKey === null || created.keyByMessageId.get(result.messageId) === turnKey));
        if (hit) {
          const readStarted = performance.now();
          const opened = await reader.read({ input: { around_message_id: hit.messageId, chat_id: hit.chatId }, ownerId, timeZone });
          readLatencies.push(Math.round(performance.now() - readStarted));
          read = { messages: opened.kind === "read"
            ? opened.result.messages.map((message) => ({ messageKey: created.keyByMessageId.get(message.messageId) ?? null, text: message.text }))
            : [], outcome: opened.kind };
        }
      }
      scores.push(scoreChatSearchScenario({ observation: {
        degraded: outcome.kind === "searched" ? outcome.degraded : null, latencyMs, outcome: outcome.kind,
        rerank: outcome.kind === "searched" ? outcome.rerank : null,
        results: results.map((result) => ({ chatKey: created.keyByChatId.get(result.chatId) ?? null, excerpt: result.excerpt,
          messageKey: created.keyByMessageId.get(result.messageId) ?? null })),
        ...(read ? { read } : {})
      }, scenario, searchInput: input, users }));
    }

    const report = chatSearchScenarioReport(scores);
    const breaches = chatSearchThresholdBreaches(report);
    // Usage is recorded after each call and never awaited: give the last ones a moment.
    await sleep(500);
    cleaned = await cleanup(created);
    print({
      ok: breaches.length === 0 && cleaned.ok,
      mode: wordsOnly ? "words_only" : "stand",
      roles: { embedding: embeddingRole.kind, rerank: rerankRole },
      seed: { users: users.length, chats: created.chatIds.size, messages: created.keyByMessageId.size, passages,
        embeddedPassages: embeddedPassages[0]?.count ?? 0 },
      index: { ...index, drainMs, freshIndexMs },
      report,
      readLatencyMs: { p50: percentile(readLatencies, 0.5), p95: percentile(readLatencies, 0.95) },
      thresholds: { recorded: CHAT_SEARCH_SCENARIO_THRESHOLDS.latencyP95Ms !== null ||
        Object.keys(CHAT_SEARCH_SCENARIO_THRESHOLDS.hitAt3).length + Object.keys(CHAT_SEARCH_SCENARIO_THRESHOLDS.hitAt5).length > 0, breaches },
      usage,
      cleanup: cleaned
    });
    return breaches.length === 0 && cleaned.ok ? 0 : 1;
  } finally {
    if (cleaned.ok && created.owners.size > 0) {
      // A failure before the report: remove what was created (a no-op after a full run's cleanup).
      const again = await cleanup(created);
      if (!again.ok) print({ cleanup: again, ok: false });
    }
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  runChatSearchScenariosOnStand().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    // Only stable codes leave the process: a refusal's own, or a generic one.
    print({ ok: false, refused: error instanceof Refusal ? error.code : error instanceof Error && /^stateful_test_[a-z_]+/u.test(error.message)
      ? error.message.split(":")[0] : "chat_search_scenarios_failed" });
    process.exitCode = 2;
  }).finally(() => prisma.$disconnect());
}
