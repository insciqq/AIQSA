import { z } from "zod";
import { PAST_CHATS_LIMITS, type SearchPastChatsInput } from "../../lib/contracts/pastChats";
import { percentile } from "./chat-search-scenarios-support";

/**
 * The pure half of the production replay (`./chat-search-replay.ts`): it parses the snapshot that
 * `./chat-search-replay-snapshot.sql` wrote before the upgrade, turns each recorded search into the new search's
 * input, and folds what the new search returned into aggregates. The aggregates are counts, shares and latencies
 * only: no query, id or text ever reaches them.
 */

const id = z.string().min(1).max(128);

export const replaySnapshotLineSchema = z.strictObject({
  v: z.literal(1),
  ownerId: id,
  searchedAt: z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), "invalid time"),
  searchChatId: id.nullable(),
  query: z.string().min(1).max(2000),
  oldOutcome: z.string().max(32).nullable(),
  oldDurationMs: z.number().int().min(0).nullable(),
  chats: z.array(z.strictObject({ chatId: id, rank: z.number().int().min(1), messageIds: z.array(id).max(512) })).max(64)
});

export type ReplaySnapshotLine = z.infer<typeof replaySnapshotLineSchema>;

export function parseReplaySnapshot(text: string): Readonly<{ lines: ReplaySnapshotLine[]; notJson: number; invalid: number }> {
  const lines: ReplaySnapshotLine[] = [];
  let notJson = 0;
  let invalid = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("{")) {
      notJson += 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      notJson += 1;
      continue;
    }
    const decoded = replaySnapshotLineSchema.safeParse(value);
    if (decoded.success) lines.push(decoded.data);
    else invalid += 1;
  }
  return { invalid, lines, notJson };
}

export type ReplayWindow = "as_of" | "none";

/**
 * The new search's input for a recorded one: the query within the tool's bound (cut at a space), the default number
 * of results, and with `as_of` only turns before the day after the search, so chats written later do not compete
 * with what the old search could have found. Days are UTC days: the snapshot does not know the user's zone.
 */
export function replaySearchInput(line: ReplaySnapshotLine, window: ReplayWindow): Readonly<{ input: SearchPastChatsInput; clipped: boolean }> {
  let query = line.query.replace(/\s+/gu, " ").trim();
  const clipped = query.length > PAST_CHATS_LIMITS.queryChars;
  if (clipped) {
    const cut = query.slice(0, PAST_CHATS_LIMITS.queryChars);
    const space = cut.lastIndexOf(" ");
    query = (space > PAST_CHATS_LIMITS.queryChars / 2 ? cut.slice(0, space) : cut).trim();
  }
  const before = window === "as_of" ? new Date(Date.parse(line.searchedAt) + 24 * 60 * 60_000).toISOString().slice(0, 10) : null;
  return { clipped, input: { after: null, before, limit: PAST_CHATS_LIMITS.searchResultsDefault, query } };
}

/** Whether an old hit's chat can be found at all now. */
export type OldChatStatus = "searchable" | "not_indexed" | "not_searchable";

export type ReplayObservation = Readonly<{
  outcome: "searched" | "disabled" | "query_unusable" | "failed" | "owner_missing";
  degraded: string | null;
  rerank: string | null;
  latencyMs: number | null;
  oldDurationMs: number | null;
  clipped: boolean;
  /** The new results in order: their chats and turns (the turn's user message). */
  newResults: ReadonlyArray<Readonly<{ chatId: string; turnId: string }>>;
  /** The old hits best first, with what became of each chat and the turns its messages belong to. */
  oldChats: ReadonlyArray<Readonly<{ chatId: string; status: OldChatStatus; turnIds: readonly string[] }>>;
  /** Old hits in the chat the search ran from, which the new search never returns: left out of the comparison. */
  oldHitsInSearchChat: number;
  /** Old messages that no longer exist. */
  oldMessagesMissing: number;
}>;

const share = (count: number, total: number) => (total === 0 ? null : Math.round((count / total) * 1000) / 1000);

function counts(values: readonly (string | null)[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value ?? "none"] = (result[value ?? "none"] ?? 0) + 1;
  return result;
}

export function replayAggregates(observations: readonly ReplayObservation[]) {
  const searched = observations.filter((entry) => entry.outcome === "searched");
  const withOld = searched.filter((entry) => entry.oldChats.length > 0);
  const inTop = (entry: ReplayObservation, chatId: string, k: number) => entry.newResults.slice(0, k).some((result) => result.chatId === chatId);
  const topOld = (k: number) => withOld.filter((entry) => inTop(entry, entry.oldChats[0]!.chatId, k)).length;
  let oldHits = 0;
  let missing = 0;
  const missingBy: Record<OldChatStatus, number> = { not_indexed: 0, not_searchable: 0, searchable: 0 };
  let recallSum = 0;
  let allFound = 0;
  let oldTurns = 0;
  let turnsFound = 0;
  for (const entry of withOld) {
    let found = 0;
    for (const chat of entry.oldChats) {
      oldHits += 1;
      if (inTop(entry, chat.chatId, PAST_CHATS_LIMITS.searchResultsDefault)) found += 1;
      else {
        missing += 1;
        missingBy[chat.status] += 1;
      }
      const newTurns = new Set(entry.newResults.map((result) => result.turnId));
      for (const turn of chat.turnIds) {
        oldTurns += 1;
        if (newTurns.has(turn)) turnsFound += 1;
      }
    }
    recallSum += found / entry.oldChats.length;
    if (found === entry.oldChats.length) allFound += 1;
  }
  const latencies = searched.flatMap((entry) => entry.latencyMs === null ? [] : [entry.latencyMs]);
  const oldLatencies = observations.flatMap((entry) => entry.oldDurationMs === null ? [] : [entry.oldDurationMs]);
  return {
    searches: observations.length,
    outcomes: counts(observations.map((entry) => entry.outcome)),
    degraded: counts(searched.map((entry) => entry.degraded)),
    rerank: counts(searched.map((entry) => entry.rerank)),
    clippedQueries: observations.filter((entry) => entry.clipped).length,
    withOldHits: withOld.length,
    oldTopChatInNewTop: { at1: share(topOld(1), withOld.length), at3: share(topOld(3), withOld.length), at5: share(topOld(5), withOld.length),
      at8: share(topOld(8), withOld.length) },
    allOldChatsInNewTop8: share(allFound, withOld.length),
    meanOldChatRecallAt8: withOld.length ? Math.round((recallSum / withOld.length) * 1000) / 1000 : null,
    // Why a missing old hit is missing: indexed and searchable but ranked out, not indexed (yet), or no longer searchable
    // (deleted, Excluded, Temporary, or the old search returned a chat the new rule never searches).
    oldChatHits: { total: oldHits, missingFromNewTop8: missing,
      missingBecause: { rankedOut: missingBy.searchable, notIndexed: missingBy.not_indexed, notSearchable: missingBy.not_searchable } },
    oldTurns: { total: oldTurns, inNewResults: turnsFound, share: share(turnsFound, oldTurns) },
    oldHitsInSearchChat: observations.reduce((sum, entry) => sum + entry.oldHitsInSearchChat, 0),
    oldMessagesMissing: observations.reduce((sum, entry) => sum + entry.oldMessagesMissing, 0),
    oldEmptyNewFound: searched.filter((entry) => entry.oldChats.length === 0 && entry.newResults.length > 0).length,
    oldFoundNewEmpty: withOld.filter((entry) => entry.newResults.length === 0).length,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: percentile(latencies, 1) },
    oldLatencyMs: { p50: percentile(oldLatencies, 0.5), p95: percentile(oldLatencies, 0.95) }
  };
}
