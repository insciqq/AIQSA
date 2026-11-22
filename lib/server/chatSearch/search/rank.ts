import { clipPastChatText } from "../../../contracts/pastChats";

/**
 * How past-chat search orders what its two lanes found. Word and meaning
 * search are merged by reciprocal rank fusion (k = 60, as the old Memory
 * ranker and the literature use): a passage's score is the sum over the lanes
 * of 1 / (60 + its rank there), so agreement between the lanes counts most and
 * neither lane's raw scores need calibrating against the other's.
 *
 * Ranks alone overrate a weak word match: the `simple` configuration keeps
 * function words, so a query in one language matches many passages in the
 * other by "for" or "после", and a mediocre rank in both lanes then beat the
 * first place in one (without a reranker, four of the scenario suite's
 * cross-language and edited-branch searches sank to ranks 2 to 8 or out of
 * the results). So a word
 * match counts by the share of the query's weight it covers
 * (`pastChatQueryWeight`), and one covering less than a quarter of it counts
 * not at all while meaning search found anything: it shares words with the
 * query, not its subject. Without meaning search every word match stays, in
 * its own order.
 *
 * Passages an exactly named identifier pinned (`query.ts`) come first; within
 * each group the fused order, then the newer turn. A turn appears once, by its
 * best window, and one chat gives at most `perChat` results so a long chat
 * cannot fill the list; `read_past_chat` reads the rest of it.
 */

export const PAST_CHAT_RANKING = Object.freeze({
  rrfK: 60,
  /** Candidates each lane returns. */
  laneCandidates: 50,
  /**
   * Turns the reranker scores, best fused first; the rest keep their fused order after them. Every turn read, so a
   * match the fusion ranked low still reaches the reranker; its documents are half as long as before (`retrieval.ts`),
   * so a call sends about as much text as 24 did.
   */
  rerankCandidates: 48,
  /** Turns whose texts are read: enough for the reranker and for the per-chat cap to leave a full list. */
  detailCandidates: 48,
  perChat: 3
});

export type PastChatLaneHit = Readonly<{
  id: string;
  chatId: string;
  userMessageId: string;
  turnAt: Date;
}>;

export type PastChatWordHit = PastChatLaneHit & Readonly<{
  pinned: boolean;
  terms: readonly string[];
  /** The sum of its terms' best weights (`query.ts`). */
  score: number;
}>;

/** A word match covering less of the query's weight than this is left out of the fusion while meaning search found anything. */
export const PAST_CHAT_MIN_WORD_COVERAGE = 0.25;

export type PastChatFusedHit = PastChatLaneHit & Readonly<{ fused: number; pinned: boolean; terms: readonly string[] }>;

function byFusedOrder(left: PastChatFusedHit, right: PastChatFusedHit): number {
  return Number(right.pinned) - Number(left.pinned) || right.fused - left.fused ||
    right.turnAt.getTime() - left.turnAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * Both lanes fused, each turn once by its best passage, best first. A word
 * match weighs by the share of `queryWeight` it covers (all of it when the
 * weight is unknown).
 */
export function fusePastChatLanes(words: readonly PastChatWordHit[], meanings: readonly PastChatLaneHit[], queryWeight: number): PastChatFusedHit[] {
  const fused = new Map<string, PastChatFusedHit>();
  const add = (hit: PastChatLaneHit, rank: number, pinned: boolean, terms: readonly string[], share: number) => {
    const score = share / (PAST_CHAT_RANKING.rrfK + rank);
    const known = fused.get(hit.id);
    fused.set(hit.id, known
      ? { ...known, fused: known.fused + score, pinned: known.pinned || pinned, terms: known.terms.length ? known.terms : terms }
      : { chatId: hit.chatId, fused: score, id: hit.id, pinned, terms, turnAt: hit.turnAt, userMessageId: hit.userMessageId });
  };
  words.forEach((hit, index) => {
    const coverage = queryWeight > 0 ? Math.min(1, Math.max(0, hit.score) / queryWeight) : 1;
    // A pinned identifier match always counts: the model named exactly that thing.
    if (!hit.pinned && meanings.length > 0 && coverage < PAST_CHAT_MIN_WORD_COVERAGE) return;
    add(hit, index + 1, hit.pinned, hit.terms, coverage);
  });
  meanings.forEach((hit, index) => add(hit, index + 1, false, [], 1));
  const turns = new Set<string>();
  return [...fused.values()].sort(byFusedOrder).filter((hit) => {
    const turn = `${hit.chatId}\u0000${hit.userMessageId}`;
    if (turns.has(turn)) return false;
    turns.add(turn);
    return true;
  });
}

/**
 * The order after the reranker scored the first turns: those by its score
 * (ties in fused order), then the turns it did not see; pinned turns stay
 * first either way, because the reranker may not outvote an exact identifier.
 */
export function rerankedPastChatOrder<T extends Readonly<{ id: string; pinned: boolean }>>(
  fused: readonly T[], scores: ReadonlyMap<string, number>
): T[] {
  const position = new Map(fused.map((hit, index) => [hit.id, index]));
  const scored = fused.filter((hit) => scores.has(hit.id));
  const rest = fused.filter((hit) => !scores.has(hit.id));
  scored.sort((left, right) => scores.get(right.id)! - scores.get(left.id)! || position.get(left.id)! - position.get(right.id)!);
  const ordered = [...scored, ...rest];
  return [...ordered.filter((hit) => hit.pinned), ...ordered.filter((hit) => !hit.pinned)];
}

/** The first `limit` hits with at most `perChat` from one chat, in order. */
export function capPastChatHits<T extends Readonly<{ chatId: string }>>(hits: readonly T[], limit: number,
  perChat: number = PAST_CHAT_RANKING.perChat): T[] {
  const counts = new Map<string, number>();
  const kept: T[] = [];
  for (const hit of hits) {
    if (kept.length >= limit) break;
    const count = counts.get(hit.chatId) ?? 0;
    if (count >= perChat) continue;
    counts.set(hit.chatId, count + 1);
    kept.push(hit);
  }
  return kept;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Where the first needle that occurs starts in the text, case-insensitively; needles are tried in order. */
function firstOccurrence(text: string, needles: readonly string[]): number | null {
  for (const needle of needles) {
    // A phrase's parts may be joined differently in the passage ("campaign 42" for "campaign_42"): try its first part too.
    const parts = needle.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
    for (const candidate of [needle, ...(parts.length > 1 ? [parts[0]!] : [])]) {
      if (!candidate) continue;
      const match = new RegExp(escapeRegExp(candidate), "iu").exec(text);
      if (match) return match.index;
    }
  }
  return null;
}

/**
 * At most `maximum` characters of a passage: the window around the first
 * matched term (a little before it, then what follows), or its start. Cut
 * ends are marked with an ellipsis.
 */
export function pastChatExcerpt(text: string, needles: readonly string[], maximum: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maximum) return trimmed;
  const found = firstOccurrence(trimmed, needles);
  let start = found === null ? 0 : Math.max(0, found - Math.floor(maximum / 5));
  if (start > 0) {
    // Start at a word: the next space within a short distance, never past the match.
    const space = trimmed.slice(start, found ?? start).search(/\s/u);
    if (space >= 0 && space < 40) start += space + 1;
    // Never start inside a surrogate pair.
    const unit = trimmed.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  }
  const lead = start > 0 ? "…" : "";
  return lead + clipPastChatText(trimmed.slice(start), maximum - lead.length).trimStart();
}
