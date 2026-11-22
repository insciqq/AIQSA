/**
 * Read-only replay of recorded production `memory_search` calls through the new past-chat search, run AFTER the
 * upgrade inside the app container, on the snapshot `./chat-search-replay-snapshot.sql` wrote before it. For each
 * recorded search it runs the new search for the same owner (from the chat the search ran in, never returned; with
 * `as_of`, only turns before the day after the search) and compares the chats and turns the old search returned with
 * the new results. It prints ONE JSON document of aggregates (`replayAggregates` in `./chat-search-replay-support.ts`):
 * counts, shares and latencies, never a query, an id or any text.
 *
 * It writes nothing to the database: the searches read, the embedding model and the reranker are called with the
 * installation's own roles, and their provider-reported usage is totalled in memory and printed instead of being
 * recorded under the owners' usage (each search costs one query embedding and at most one rerank call). It reads
 * the owners' chats, messages and passages only to tell what became of an old hit (still searchable, not indexed,
 * gone) and which turn an old message belongs to.
 *
 * The snapshot holds private queries. Pass it through stdin, so no copy lands in the container, and delete the
 * host file afterwards; or name a file the current user owns and only it can read, which the script deletes after a
 * complete run unless told to keep it.
 *
 *   docker compose exec -T -e AIQSA_CHAT_SEARCH_REPLAY=READ_ONLY app \
 *     npx tsx scripts/eval/chat-search-replay.ts < chat-search-snapshot.jsonl
 *   shred -u chat-search-snapshot.jsonl
 *
 * Environment (process only):
 * - AIQSA_CHAT_SEARCH_REPLAY=READ_ONLY (required acknowledgement)
 * - AIQSA_CHAT_SEARCH_REPLAY_FILE: a snapshot file instead of stdin (mode 0600 or stricter, owned by the user)
 * - AIQSA_CHAT_SEARCH_REPLAY_KEEP_FILE=1 keeps that file after the run
 * - AIQSA_CHAT_SEARCH_REPLAY_WINDOW: `as_of` (default) or `none` (search everything indexed now)
 * - AIQSA_CHAT_SEARCH_REPLAY_LIMIT: replay at most this many searches, oldest first (default all, at most 5000)
 * - AIQSA_CHAT_SEARCH_REPLAY_PAUSE_MS: pause between searches (default 0, at most 10000)
 *
 * Exit 0 after a complete replay, 2 when it refused or failed before printing aggregates.
 */
import { randomUUID } from "node:crypto";
import { fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync, closeSync, constants } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { chatSearchEligibleWhere } from "../../lib/server/chatSearch/eligibility";
import { createChatSearchEmbedder } from "../../lib/server/chatSearch/embedderPrisma";
import { createSavedSecretValuesReader } from "../../lib/server/chatSearch/search/redaction";
import { createPrismaPastChatReranker } from "../../lib/server/chatSearch/search/rerank";
import { createPastChatSearch } from "../../lib/server/chatSearch/search/retrieval";
import { createPrismaPastChatSearchStore } from "../../lib/server/chatSearch/search/store";
import type { ChatSearchUsageRecord } from "../../lib/server/chatSearch/usage";
import { prisma } from "../../lib/server/prisma";
import {
  parseReplaySnapshot,
  replayAggregates,
  replaySearchInput,
  type OldChatStatus,
  type ReplayObservation,
  type ReplaySnapshotLine,
  type ReplayWindow
} from "./chat-search-replay-support";

const ACKNOWLEDGEMENT = "AIQSA_CHAT_SEARCH_REPLAY";
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function print(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, code: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Refusal(code);
  return parsed;
}

/** The snapshot: a private file the user owns, or stdin when it is not a terminal. */
function readSnapshot(path: string | undefined): string {
  if (path === undefined || path === "" || path === "-") {
    const stdin = fstatSync(0);
    if (stdin.isCharacterDevice()) throw new Refusal("snapshot_missing");
    const text = readFileSync(0, "utf8");
    if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new Refusal("snapshot_too_large");
    return text;
  }
  const link = lstatSync(path, { throwIfNoEntry: false });
  if (!link || !link.isFile()) throw new Refusal("snapshot_file_missing");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Refusal("snapshot_file_not_private");
    }
    if (stat.size > MAX_SNAPSHOT_BYTES) throw new Refusal("snapshot_too_large");
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

type UsageTotals = Record<string, { calls: number; inputTokens: number; totalTokens: number; costUsd: number; costUnknown: number }>;

function usageRecorder(totals: UsageTotals, kind: string) {
  return (record: ChatSearchUsageRecord) => {
    const entry = totals[kind] ??= { calls: 0, costUnknown: 0, costUsd: 0, inputTokens: 0, totalTokens: 0 };
    entry.calls += 1;
    entry.inputTokens += record.usage.inputTokens ?? 0;
    entry.totalTokens += record.usage.totalTokens ?? 0;
    if (typeof record.costUsd === "number") entry.costUsd += record.costUsd;
    else entry.costUnknown += 1;
    return Promise.resolve();
  };
}

/** What became of the old hits' chats and which turns their messages belong to, for one owner. */
async function oldHitFacts(line: ReplaySnapshotLine): Promise<Pick<ReplayObservation, "oldChats" | "oldMessagesMissing" | "oldHitsInSearchChat">> {
  // The new search never returns the chat it runs from, so an old hit there is counted apart, not as missing.
  const compared = line.chats.filter((chat) => chat.chatId !== line.searchChatId);
  const oldHitsInSearchChat = line.chats.length - compared.length;
  const chatIds = compared.map((chat) => chat.chatId);
  if (chatIds.length === 0) return { oldChats: [], oldHitsInSearchChat, oldMessagesMissing: 0 };
  const [eligible, indexed, messages] = await Promise.all([
    prisma.chat.findMany({ select: { id: true }, where: { ...chatSearchEligibleWhere(line.ownerId), id: { in: chatIds } } }),
    prisma.chatSearchPassage.groupBy({ by: ["chatId"], where: { chatId: { in: chatIds }, userId: line.ownerId } }),
    prisma.message.findMany({ select: { chatId: true, id: true, parentMessageId: true, role: true },
      where: { chat: { userId: line.ownerId }, chatId: { in: chatIds }, id: { in: compared.flatMap((chat) => chat.messageIds) } } })
  ]);
  const searchable = new Set(eligible.map((row) => row.id));
  const withPassages = new Set(indexed.map((row) => row.chatId));
  const turnOf = new Map(messages.map((row) => [row.id, row.role === "user" ? row.id : row.role === "assistant" ? row.parentMessageId : null]));
  let missing = 0;
  const oldChats = compared.map((chat) => {
    const status: OldChatStatus = !searchable.has(chat.chatId) ? "not_searchable" : withPassages.has(chat.chatId) ? "searchable" : "not_indexed";
    const turnIds = new Set<string>();
    for (const messageId of chat.messageIds) {
      if (!turnOf.has(messageId)) missing += 1;
      const turn = turnOf.get(messageId);
      if (turn) turnIds.add(turn);
    }
    return { chatId: chat.chatId, status, turnIds: [...turnIds] };
  });
  return { oldChats, oldHitsInSearchChat, oldMessagesMissing: missing };
}

export async function runChatSearchReplay(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (environment[ACKNOWLEDGEMENT] !== "READ_ONLY") throw new Refusal("chat_search_replay_not_acknowledged");
  const window = (environment.AIQSA_CHAT_SEARCH_REPLAY_WINDOW ?? "as_of") as ReplayWindow;
  if (window !== "as_of" && window !== "none") throw new Refusal("replay_window_invalid");
  const limit = boundedInteger(environment.AIQSA_CHAT_SEARCH_REPLAY_LIMIT, 5_000, 1, 5_000, "replay_limit_invalid");
  const pauseMs = boundedInteger(environment.AIQSA_CHAT_SEARCH_REPLAY_PAUSE_MS, 0, 0, 10_000, "replay_pause_invalid");
  const file = environment.AIQSA_CHAT_SEARCH_REPLAY_FILE;
  const snapshot = parseReplaySnapshot(readSnapshot(file));
  if (snapshot.lines.length === 0) throw new Refusal("snapshot_empty");

  const usage: UsageTotals = {};
  const embedder = createChatSearchEmbedder(prisma, { recordUsage: usageRecorder(usage, "query_embedding") });
  const reranker = createPrismaPastChatReranker(prisma);
  const roles = { embedding: (await embedder.currentModel()).kind, rerank: (await reranker.resolve()).kind };
  const search = createPastChatSearch({ embedder, recordUsage: usageRecorder(usage, "rerank"), reranker,
    savedSecretValues: createSavedSecretValuesReader(prisma), store: createPrismaPastChatSearchStore(prisma) });

  const lines = snapshot.lines.slice(0, limit);
  const owners = new Set((await prisma.user.findMany({ select: { id: true }, where: { id: { in: [...new Set(lines.map((line) => line.ownerId))] } } }))
    .map((row) => row.id));
  const observations: ReplayObservation[] = [];
  for (const line of lines) {
    const { clipped, input } = replaySearchInput(line, window);
    const base = { clipped, degraded: null, latencyMs: null, oldDurationMs: line.oldDurationMs, rerank: null };
    if (!owners.has(line.ownerId)) {
      observations.push({ ...base, newResults: [], oldChats: [], oldHitsInSearchChat: 0, oldMessagesMissing: 0, outcome: "owner_missing" });
      continue;
    }
    const facts = await oldHitFacts(line);
    const started = performance.now();
    const outcome = await search.search({ currentChatId: line.searchChatId ?? randomUUID(), input, ownerId: line.ownerId, timeZone: "UTC" });
    const latencyMs = Math.round(performance.now() - started);
    observations.push({ ...base, ...facts, latencyMs, outcome: outcome.kind,
      degraded: outcome.kind === "searched" ? outcome.degraded : null,
      newResults: outcome.kind === "searched" ? outcome.result.results.map((result) => ({ chatId: result.chatId, turnId: result.messageId })) : [],
      rerank: outcome.kind === "searched" ? outcome.rerank : null });
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  // Usage is recorded after each call and never awaited: give the last ones a moment.
  await new Promise((resolve) => setTimeout(resolve, 500));

  let snapshotFile: "stdin" | "deleted" | "kept" | "delete_failed" = "stdin";
  if (file && file !== "-") {
    if (environment.AIQSA_CHAT_SEARCH_REPLAY_KEEP_FILE === "1") snapshotFile = "kept";
    else {
      try {
        unlinkSync(file);
        snapshotFile = "deleted";
      } catch {
        snapshotFile = "delete_failed";
      }
    }
  }
  print({
    ok: true,
    window,
    roles,
    snapshot: { lines: snapshot.lines.length, replayed: lines.length, notJson: snapshot.notJson, invalid: snapshot.invalid, file: snapshotFile },
    ...replayAggregates(observations),
    usage
  });
  return 0;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  runChatSearchReplay().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    // Only stable codes leave the process.
    print({ ok: false, refused: error instanceof Refusal ? error.code : "chat_search_replay_failed" });
    process.exitCode = 2;
  }).finally(() => prisma.$disconnect());
}
