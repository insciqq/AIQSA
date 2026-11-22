import {
  PAST_CHATS_LIMITS,
  pastChatExcerptSchema,
  pastChatSearchMode,
  type PastChatExcerpt,
  type PastChatSearchMode,
  type SearchPastChatsInput,
  type SearchPastChatsResult
} from "../../../contracts/pastChats";
import { logEvent } from "../../observability";
import { RerankAdapterError, type RerankUsage } from "../../providers/rerank";
import { redactSavedSecretValues } from "../../redaction/savedSecrets";
import { redactSearchQuery } from "../../redaction/searchQuery";
import { ChatSearchEmbeddingError, type ChatSearchEmbedder } from "../embedder";
import { chatSearchPassageBody } from "../index/passages";
import { pastChatTimestamp, pastChatTurnRange } from "./dates";
import { pastChatPhraseChunks, pastChatQueryChunks, pastChatQueryWeight, pastChatWordUnits, type PastChatWordUnit } from "./query";
import {
  capPastChatHits,
  fusePastChatLanes,
  PAST_CHAT_RANKING,
  pastChatExcerpt,
  rerankedPastChatOrder,
  type PastChatFusedHit,
  type PastChatLaneHit
} from "./rank";
import { pastChatTitle, redactPastChatText, type SavedSecretValuesReader } from "./redaction";
import type { PastChatReranker, PastChatRerankBinding, PastChatUsageRecorder } from "./rerank";
import type { PastChatPassageRow, PastChatScope, PastChatSearchStore } from "./store";

/**
 * One past-chat search for one owner (`search_past_chats`). With a query,
 * exact-word search and the query's embedding start together; meaning search
 * runs once the vector is there; both lanes are fused (`rank.ts`), the
 * dedicated reranker reorders the first turns when one is assigned, and the
 * excerpts come back in that relevance order, never re-sorted by date.
 * Without a query, the owner's most recent chats. One overall deadline bounds
 * everything and no language model is ever called.
 *
 * Degradation is visible to the model and never silent: an embedding model
 * that is not set, unusable, failing or late leaves word results marked as
 * partial; a reranker that fails leaves the fused order (a complete result in
 * a coarser order, so it is not marked); a failed word search or database read
 * fails the search. The query is redacted (recognized secrets and the owner's
 * saved secret values) before it reaches SQL, the embedding model or the
 * reranker.
 */

export const PAST_CHAT_SEARCH_TIMEOUTS = Object.freeze({
  /** The whole search, unless the caller's deadline is earlier. */
  totalMs: 20_000,
  /** The query embedding; production calls took about 2 s. */
  embeddingMs: 8_000,
  /** The reranker; production calls took about 1 s. */
  rerankMs: 6_000
});

/** A listing names a chat by the start of its latest turn: a line or two is enough. */
const RECENT_EXCERPT_CHARS = 400;
/** The JSON of a result stays within the engine's inline tool result with its note beside it. */
export const PAST_CHAT_RESULT_JSON_CHARS = 20_000;
const MIN_EXCERPT_CHARS = 200;
/**
 * The document text one rerank call sends per turn: the window around the match. With `rerankCandidates` turns a call
 * stays near 100 000 characters, as 24 of 4 000 were, and within the adapter's request bytes in any script.
 */
const RERANK_DOCUMENT_CHARS = 2_000;
/** The markers `lib/server/redaction/` puts in place of a secret (`[REDACTED:TOKEN]`, `[REDACTED_SECRET]`, `[REDACTED:SAVED_SECRET]`). */
const REDACTION_MARKER = /\[REDACTED[:_][A-Z0-9_:]*\]/gu;

/** Why meaning search did not take part; the result then holds word matches only. */
export type PastChatMeaningDegradation = "meaning_search_not_set" | "meaning_search_unavailable" | "meaning_search_failed" | "meaning_search_timed_out";

export type PastChatSearchOutcome =
  | Readonly<{ kind: "disabled" }>
  /** The query held nothing searchable once secrets were taken out. */
  | Readonly<{ kind: "query_unusable" }>
  | Readonly<{ kind: "failed"; code: "past_chats_timed_out" | "past_chats_store_failed" }>
  | Readonly<{
      kind: "searched";
      result: SearchPastChatsResult;
      /** Null when meaning search ran or was not needed (no query). */
      degraded: PastChatMeaningDegradation | null;
      rerank: "used" | "not_set" | "failed" | "not_needed";
    }>;

export type PastChatSearchRequest = Readonly<{
  ownerId: string;
  currentChatId: string;
  timeZone: string;
  input: SearchPastChatsInput;
  /** The run the search answers for, which its usage rows name when given. */
  runId?: string;
  /** The caller's Stop: aborting it rejects the search. */
  signal?: AbortSignal;
  /** An earlier end than the search's own deadline, in epoch milliseconds. */
  deadlineAt?: number;
}>;

export type PastChatSearch = Readonly<{ search(request: PastChatSearchRequest): Promise<PastChatSearchOutcome> }>;

export type PastChatSearchDependencies = Readonly<{
  store: PastChatSearchStore;
  embedder: ChatSearchEmbedder;
  /** The dedicated reranker; absent where none can be resolved, like one not set. */
  reranker?: PastChatReranker;
  recordUsage: PastChatUsageRecorder;
  savedSecretValues: SavedSecretValuesReader;
  timeouts?: Partial<Record<keyof typeof PAST_CHAT_SEARCH_TIMEOUTS, number>>;
  now?: () => number;
}>;

class DeadlineError extends Error {
  constructor() {
    super("deadline");
    this.name = "DeadlineError";
  }
}

/** Waits for the promise or the signal; a database read cannot be cancelled, only no longer waited for. */
function raced<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function degrade(stage: "embed" | "read" | "process" | "write", code: string | null): void {
  logEvent("service_operation", { action: "degrade", outcome: "degraded", stage, subsystem: "memory_search", ...(code ? { code } : {}) });
}

function usageReported(usage: RerankUsage | null | undefined): usage is RerankUsage {
  return Boolean(usage) && (usage!.inputTokens !== null || usage!.searchUnits !== null || usage!.totalTokens !== null ||
    (usage!.costUsd !== null && usage!.costUsd !== undefined));
}

type ResultSource = Readonly<{ row: PastChatPassageRow; needles: readonly string[] }>;

/**
 * The results within their bounds: excerpts shrink together until the JSON
 * fits, and only then are the last results left out. Each item is checked
 * against the contract; one that does not decode is left out.
 */
function boundedResults(mode: PastChatSearchMode, sources: readonly ResultSource[], excerptChars: number, savedValues: readonly string[],
  timeZone: string): PastChatExcerpt[] {
  // The excerpt is the turn's own words: the passage's header (the chat's title and the turn's file names) is in the result already.
  const texts = sources.map((source) => redactPastChatText(chatSearchPassageBody(source.row.text).trim() || source.row.text, savedValues));
  const titles = sources.map((source) => pastChatTitle(source.row.title, savedValues));
  const build = (cap: number) => sources.flatMap((source, index): PastChatExcerpt[] => {
    const decoded = pastChatExcerptSchema.safeParse({ chatId: source.row.chatId, chatTitle: titles[index]!,
      date: pastChatTimestamp(source.row.turnAt, timeZone), excerpt: pastChatExcerpt(texts[index]!, source.needles, cap),
      messageId: source.row.userMessageId });
    return decoded.success ? [decoded.data] : [];
  });
  let cap = excerptChars;
  let results = build(cap);
  const size = (items: readonly PastChatExcerpt[]) => JSON.stringify({ mode, results: items }).length;
  while (size(results) > PAST_CHAT_RESULT_JSON_CHARS && cap > MIN_EXCERPT_CHARS) {
    cap = Math.max(MIN_EXCERPT_CHARS, Math.floor(cap * 0.8));
    results = build(cap);
  }
  while (results.length > 0 && size(results) > PAST_CHAT_RESULT_JSON_CHARS) results = results.slice(0, -1);
  return results;
}

export function createPastChatSearch(dependencies: PastChatSearchDependencies): PastChatSearch {
  const timeouts = { ...PAST_CHAT_SEARCH_TIMEOUTS, ...dependencies.timeouts };
  const now = dependencies.now ?? Date.now;
  const { embedder, store } = dependencies;

  function recordRerankUsage(request: PastChatSearchRequest, binding: PastChatRerankBinding, usage: RerankUsage | null | undefined): void {
    if (!usageReported(usage)) return;
    const reported: RerankUsage = usage;
    // After the call and never awaited: bookkeeping never delays or fails the search.
    void Promise.resolve().then(() => dependencies.recordUsage({ chatId: request.currentChatId, costUsd: reported.costUsd ?? null,
      modelId: binding.modelId, modelRunId: request.runId ?? null, provider: binding.provider, providerModelId: binding.providerModelId,
      purpose: "memory_retrieval", usage: { inputTokens: reported.inputTokens, totalTokens: reported.totalTokens }, userId: request.ownerId }))
      .catch(() => degrade("write", null));
  }

  return Object.freeze({
    async search(request: PastChatSearchRequest): Promise<PastChatSearchOutcome> {
      request.signal?.throwIfAborted();
      const started = now();
      const deadlineAt = Math.min(started + timeouts.totalMs, request.deadlineAt ?? Number.POSITIVE_INFINITY);
      const deadline = new AbortController();
      // Ends what is still in flight once the search has answered (a meaning lane after a failed word lane).
      const finished = new AbortController();
      const timer = setTimeout(() => deadline.abort(new DeadlineError()), Math.max(0, deadlineAt - started));
      const signal = AbortSignal.any([deadline.signal, finished.signal, ...(request.signal ? [request.signal] : [])]);
      const remaining = () => Math.max(0, deadlineAt - now());
      const stopped = () => request.signal?.aborted === true;
      try {
        const switches = await raced(store.switches(request.ownerId), signal);
        if (!switches.memoryEnabled || !switches.pastChatSearchEnabled) return { kind: "disabled" };
        const savedValues = await raced(dependencies.savedSecretValues(request.ownerId), signal);
        const input = request.input;
        const mode = pastChatSearchMode(input);
        const limit = input.limit ?? PAST_CHATS_LIMITS.searchResultsDefault;
        const scope: PastChatScope = { currentChatId: request.currentChatId, ownerId: request.ownerId,
          range: pastChatTurnRange(input, request.timeZone) };

        if (mode === "recent") {
          const rows = await raced(store.recent(scope, limit), signal);
          const results = boundedResults(mode, rows.map((row) => ({ needles: [], row })), RECENT_EXCERPT_CHARS, savedValues, request.timeZone);
          return { degraded: null, kind: "searched", rerank: "not_needed", result: { mode, results } };
        }

        const redacted = redactSearchQuery(input.query ?? "");
        // A redaction marker is no word of the query: searched for, it would find other redacted text.
        const query = redacted.eligible
          ? redactSavedSecretValues(redacted.safeText, savedValues).text.replace(REDACTION_MARKER, " ").replace(/\s+/gu, " ").trim()
          : "";
        if (!query) return { kind: "query_unusable" };
        const phrases = pastChatPhraseChunks(pastChatQueryChunks(query));

        const words = (async () => {
          const statistics = await store.wordStatistics(request.ownerId, query, phrases);
          const units = pastChatWordUnits(statistics);
          return { hits: await store.wordHits(scope, units, PAST_CHAT_RANKING.laneCandidates), units, weight: pastChatQueryWeight(statistics) };
        })();
        const meanings = (async (): Promise<Readonly<{ hits: PastChatLaneHit[] }> | Readonly<{ degraded: PastChatMeaningDegradation }>> => {
          let embedSignal: AbortSignal | undefined;
          try {
            const model = await raced(embedder.currentModel(), signal);
            if (model.kind === "unset") return { degraded: "meaning_search_not_set" };
            if (model.kind === "unavailable") {
              degrade("embed", model.code);
              return { degraded: "meaning_search_unavailable" };
            }
            embedSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(timeouts.embeddingMs, remaining())))]);
            const embedded = await raced(embedder.embed({ latencyClass: "interactive", mode: "query", providerModelId: model.providerModelId,
              signal: embedSignal, texts: [query], userId: request.ownerId }), embedSignal);
            const vector = embedded.vectors[0];
            if (embedded.vectors.length !== 1 || !vector || vector.length !== embedded.dimension || vector.length === 0 ||
              vector.some((value) => !Number.isFinite(value))) {
              degrade("embed", "embedding_response_vector_invalid");
              return { degraded: "meaning_search_failed" };
            }
            return { hits: await raced(store.vectorHits(scope, { providerModelId: model.providerModelId, values: vector },
              PAST_CHAT_RANKING.laneCandidates), signal) };
          } catch (error) {
            if (stopped()) throw error;
            if (finished.signal.aborted) return { degraded: "meaning_search_failed" };
            const late = deadline.signal.aborted || (embedSignal?.aborted === true && !(error instanceof ChatSearchEmbeddingError));
            degrade("embed", error instanceof ChatSearchEmbeddingError ? error.code : late ? "embedding_request_timed_out" : null);
            return { degraded: late ? "meaning_search_timed_out" : "meaning_search_failed" };
          }
        })();
        // A rejection of the meaning lane after the word lane failed is still observed.
        void meanings.catch(() => undefined);
        const [wordLane, meaningLane] = await Promise.all([raced(words, signal), meanings]);
        const degraded = "degraded" in meaningLane ? meaningLane.degraded : null;
        const fused = fusePastChatLanes(wordLane.hits, "hits" in meaningLane ? meaningLane.hits : [], wordLane.weight);
        if (fused.length === 0) return { degraded, kind: "searched", rerank: "not_needed", result: { mode, results: [] } };

        const candidates = fused.slice(0, PAST_CHAT_RANKING.detailCandidates);
        const rows = new Map((await raced(store.passages(scope, candidates.map((hit) => hit.id)), signal)).map((row) => [row.id, row]));
        const readable = candidates.filter((hit) => rows.has(hit.id));
        const needles = needlesFor(wordLane.units);

        const rerankTurns = async (top: readonly PastChatFusedHit[]): Promise<Readonly<{ kind: "scores"; scores: Map<string, number> }> |
          Readonly<{ kind: "not_set" | "failed" }>> => {
          let rerankSignal: AbortSignal | undefined;
          let binding: PastChatRerankBinding | null = null;
          try {
            const resolution = await raced(dependencies.reranker!.resolve(), signal);
            if (resolution.kind === "unset") return { kind: "not_set" };
            if (resolution.kind === "unavailable") {
              degrade("process", "reranker_model_unavailable");
              return { kind: "failed" };
            }
            binding = resolution.route.binding;
            const documents = top.map((hit, index) => ({ handle: `d${index + 1}`,
              text: pastChatExcerpt(redactPastChatText(rows.get(hit.id)!.text, savedValues), needles(hit.terms), RERANK_DOCUMENT_CHARS) }));
            rerankSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(timeouts.rerankMs, remaining())))]);
            const reranked = await raced(resolution.route.rerank({ documents, query, signal: rerankSignal }), rerankSignal);
            recordRerankUsage(request, binding, reranked.usage);
            // Coverage must be complete and one-to-one, or the ranking is not used at all.
            const handles = new Map(documents.map((document, index) => [document.handle, top[index]!.id]));
            const scores = new Map<string, number>();
            for (const score of reranked.scores) {
              const id = handles.get(score.handle);
              if (!id || scores.has(id) || !Number.isFinite(score.relevanceScore)) break;
              scores.set(id, score.relevanceScore);
            }
            if (scores.size !== documents.length || reranked.scores.length !== documents.length) {
              degrade("process", "rerank_response_invalid");
              return { kind: "failed" };
            }
            return { kind: "scores", scores };
          } catch (error) {
            if (stopped()) throw error;
            if (binding && error instanceof RerankAdapterError) {
              recordRerankUsage(request, binding, error.usage);
            }
            degrade("process", error instanceof RerankAdapterError ? error.code : rerankSignal?.aborted ? "rerank_request_timed_out" : null);
            return { kind: "failed" };
          }
        };

        let ordered: PastChatFusedHit[] = readable;
        let rerank: "used" | "not_set" | "failed" | "not_needed" = readable.length > 1 ? "not_set" : "not_needed";
        if (readable.length > 1 && dependencies.reranker) {
          const outcome = await rerankTurns(readable.slice(0, PAST_CHAT_RANKING.rerankCandidates));
          if (outcome.kind === "scores") {
            ordered = rerankedPastChatOrder(readable, outcome.scores);
            rerank = "used";
          } else rerank = outcome.kind;
        }
        const kept = capPastChatHits(ordered, limit);
        const results = boundedResults(mode, kept.map((hit) => ({ needles: needles(hit.terms), row: rows.get(hit.id)! })),
          PAST_CHATS_LIMITS.excerptChars, savedValues, request.timeZone);
        return { degraded, kind: "searched", rerank, result: { mode, results } };
      } catch (error) {
        if (stopped()) throw error;
        degrade("read", null);
        return { code: deadline.signal.aborted ? "past_chats_timed_out" : "past_chats_store_failed", kind: "failed" };
      } finally {
        clearTimeout(timer);
        finished.abort(new DeadlineError());
      }
    }
  });
}

/** For a passage's matched terms, the texts to center its excerpt on, best first; then every unit's, for meaning-only matches. */
function needlesFor(units: readonly PastChatWordUnit[]): (terms: readonly string[]) => string[] {
  const byTerm = new Map<string, string>();
  for (const unit of units) if (!byTerm.has(unit.term)) byTerm.set(unit.term, unit.needle);
  const all = [...new Set(units.map((unit) => unit.needle))];
  return (terms) => [...new Set([...terms.flatMap((term) => byTerm.get(term) ?? []), ...all])];
}
