import type { PrismaClient } from "@prisma/client";
import type {
  MemoryLaneCandidate,
  MemoryRetrievalLane
} from "../../../../domain/memory/retrieval";
import {
  createOpenSearchMemoryLexicalCandidateProvider
} from "./opensearchProvider";
import type {
  MemoryLexicalCandidateProvider,
  MemoryLexicalFailureCode,
  MemoryLexicalLaneEvidence,
  MemoryLexicalMatchMode
} from "./contract";
import {
  memoryLexicalBackendConfigurationFromEnv,
  type MemoryLexicalShadowConfiguration
} from "./config";
import type { PostgresUnicodeMemoryLexicalLane } from
  "./postgresUnicodeProvider";

export type MemoryLexicalShadowStage = "BASELINE" | "ENRICHED" | "INTRA_CHAT";

export type MemoryLexicalShadowRankComparison = Readonly<{
  candidateTop10Count: number;
  firstReferenceCandidateReciprocalRankDifference: number | null;
  referenceTop10Count: number;
  referenceTop10InCandidateTop50Count: number;
  referenceTop10InCandidateTop50Ratio: number | null;
  top10IntersectionCount: number;
  top10Jaccard: number | null;
}>;

export type MemoryLexicalShadowLaneReceipt = Readonly<{
  comparison: MemoryLexicalShadowRankComparison;
  lane: PostgresUnicodeMemoryLexicalLane;
  openSearch: Readonly<{
    canonicalAcceptedCount: number;
    durationMs: number;
    failureCode: MemoryLexicalFailureCode | null;
    matchModeCounts: Readonly<Record<MemoryLexicalMatchMode, number>>;
    opaqueIdPresent: boolean;
    projectionCaughtUp: boolean | null;
    projectionEventLag: number | null;
    projectionRevisionLag: number | null;
    projectionVisibleAgeMs: number | null;
    rawCandidateCount: number;
    rejectedAuthorityCount: number;
    rejectedGenerationCount: number;
    rejectedHashCount: number;
    timedOut: boolean;
  }>;
  postgres: Readonly<{
    canonicalAcceptedCount: number;
    rawCandidateCount: number;
  }>;
}>;

export type MemoryLexicalShadowReceipt = Readonly<{
  durationMs: number;
  event: "memory_lexical_shadow";
  failureCode: MemoryLexicalFailureCode | null;
  lanes: readonly MemoryLexicalShadowLaneReceipt[];
  stage: MemoryLexicalShadowStage;
  timedOut: boolean;
  version: 1;
}>;

export type MemoryLexicalShadowSink = (
  receipt: MemoryLexicalShadowReceipt
) => void;

export type MemoryLexicalShadowRuntime = Readonly<{
  providerForLane(
    lane: PostgresUnicodeMemoryLexicalLane
  ): MemoryLexicalCandidateProvider;
  submit(input: Readonly<{
    stage: MemoryLexicalShadowStage;
    work(deadlineAtMs: number): Promise<readonly MemoryLexicalShadowLaneReceipt[]>;
  }>): boolean;
}>;

function orderedUniqueEntryIds(
  candidates: readonly Pick<MemoryLaneCandidate, "entryId">[],
  maximum: number
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.entryId || seen.has(candidate.entryId)) continue;
    seen.add(candidate.entryId);
    ids.push(candidate.entryId);
    if (ids.length >= maximum) break;
  }
  return ids;
}

/** Runtime parity uses opaque entry identity only. It deliberately does not
 * label a candidate as relevant; true first-relevant MRR belongs to the
 * synthetic/redacted qualification corpus. */
export function compareMemoryLexicalShadowRanks(input: Readonly<{
  candidate: readonly Pick<MemoryLaneCandidate, "entryId">[];
  reference: readonly Pick<MemoryLaneCandidate, "entryId">[];
}>): MemoryLexicalShadowRankComparison {
  const referenceTop10 = orderedUniqueEntryIds(input.reference, 10);
  const candidateTop10 = orderedUniqueEntryIds(input.candidate, 10);
  const candidateTop50 = orderedUniqueEntryIds(input.candidate, 50);
  const candidateTop10Set = new Set(candidateTop10);
  const candidateTop50Set = new Set(candidateTop50);
  const referenceTop10Set = new Set(referenceTop10);
  const referenceContained = referenceTop10.filter((id) =>
    candidateTop50Set.has(id)).length;
  const intersection = referenceTop10.filter((id) =>
    candidateTop10Set.has(id)).length;
  const union = new Set([...referenceTop10, ...candidateTop10]).size;
  const firstReference = referenceTop10[0];
  const candidateRank = firstReference
    ? candidateTop50.indexOf(firstReference) + 1
    : 0;
  return Object.freeze({
    candidateTop10Count: candidateTop10.length,
    firstReferenceCandidateReciprocalRankDifference: firstReference
      ? (candidateRank > 0 ? 1 / candidateRank : 0) - 1
      : null,
    referenceTop10Count: referenceTop10.length,
    referenceTop10InCandidateTop50Count: referenceContained,
    referenceTop10InCandidateTop50Ratio: referenceTop10.length > 0
      ? referenceContained / referenceTop10.length
      : null,
    top10IntersectionCount: intersection,
    top10Jaccard: union > 0 ? intersection / union : null
  });
}

export function memoryLexicalShadowMatchModeCounts(
  candidates: readonly Readonly<{ matchMode: MemoryLexicalMatchMode }>[]
): Readonly<Record<MemoryLexicalMatchMode, number>> {
  const counts: Record<MemoryLexicalMatchMode, number> = {
    FOLDED: 0,
    NGRAM: 0,
    TRANSLITERATED: 0,
    UNICODE: 0
  };
  for (const candidate of candidates) counts[candidate.matchMode] += 1;
  return Object.freeze(counts);
}

export function memoryLexicalShadowLaneReceipt(input: Readonly<{
  candidate: readonly MemoryLaneCandidate[];
  lane: PostgresUnicodeMemoryLexicalLane;
  openSearchCandidates: readonly Readonly<{ matchMode: MemoryLexicalMatchMode }>[];
  openSearchEvidence: MemoryLexicalLaneEvidence;
  postgresCanonicalAcceptedCount: number;
  postgresRawCandidateCount: number;
  reference: readonly MemoryLaneCandidate[];
}>): MemoryLexicalShadowLaneReceipt {
  return Object.freeze({
    comparison: compareMemoryLexicalShadowRanks({
      candidate: input.candidate,
      reference: input.reference
    }),
    lane: input.lane,
    openSearch: Object.freeze({
      canonicalAcceptedCount: input.openSearchEvidence.canonicalAcceptedCount,
      durationMs: input.openSearchEvidence.durationMs,
      failureCode: input.openSearchEvidence.failureCode,
      matchModeCounts: memoryLexicalShadowMatchModeCounts(
        input.openSearchCandidates
      ),
      opaqueIdPresent: input.openSearchEvidence.opaqueId !== null,
      projectionCaughtUp: input.openSearchEvidence.projectionCaughtUp,
      projectionEventLag: input.openSearchEvidence.projectionEventLag,
      projectionRevisionLag: input.openSearchEvidence.projectionRevisionLag,
      projectionVisibleAgeMs: input.openSearchEvidence.projectionVisibleAgeMs,
      rawCandidateCount: input.openSearchEvidence.rawCandidateCount,
      rejectedAuthorityCount: input.openSearchEvidence.rejectedAuthorityCount,
      rejectedGenerationCount: input.openSearchEvidence.rejectedGenerationCount,
      rejectedHashCount: input.openSearchEvidence.rejectedHashCount,
      timedOut: input.openSearchEvidence.timedOut
    }),
    postgres: Object.freeze({
      canonicalAcceptedCount: input.postgresCanonicalAcceptedCount,
      rawCandidateCount: input.postgresRawCandidateCount
    })
  });
}

function failureReceipt(
  stage: MemoryLexicalShadowStage,
  failureCode: MemoryLexicalFailureCode,
  durationMs: number
): MemoryLexicalShadowReceipt {
  return Object.freeze({
    durationMs,
    event: "memory_lexical_shadow",
    failureCode,
    lanes: Object.freeze([]),
    stage,
    timedOut: failureCode === "memory_lexical_settle_timeout",
    version: 1
  });
}

export class BoundedMemoryLexicalShadowRuntime implements
MemoryLexicalShadowRuntime {
  #active = 0;
  readonly #providers = new Map<
    PostgresUnicodeMemoryLexicalLane,
    MemoryLexicalCandidateProvider
  >();

  constructor(
    private readonly client: PrismaClient,
    private readonly configuration: MemoryLexicalShadowConfiguration,
    private readonly env: NodeJS.ProcessEnv,
    private readonly sink: MemoryLexicalShadowSink
  ) {
    if (configuration.backend !== "SHADOW") {
      throw new Error("memory_lexical_shadow_runtime_disabled");
    }
  }

  providerForLane(
    lane: PostgresUnicodeMemoryLexicalLane
  ): MemoryLexicalCandidateProvider {
    const current = this.#providers.get(lane);
    if (current) return current;
    const created = createOpenSearchMemoryLexicalCandidateProvider(
      this.client,
      lane,
      this.env
    );
    this.#providers.set(lane, created);
    return created;
  }

  submit(input: Readonly<{
    stage: MemoryLexicalShadowStage;
    work(deadlineAtMs: number): Promise<readonly MemoryLexicalShadowLaneReceipt[]>;
  }>): boolean {
    if (this.#active >= this.configuration.maximumConcurrency) {
      this.#emit(failureReceipt(input.stage, "memory_lexical_shadow_capacity", 0));
      return false;
    }
    this.#active += 1;
    queueMicrotask(() => void this.#run(input));
    return true;
  }

  #emit(receipt: MemoryLexicalShadowReceipt): void {
    try {
      this.sink(receipt);
    } catch {
      // Observability must never affect retrieval or create an unhandled task.
    }
  }

  async #run(input: Readonly<{
    stage: MemoryLexicalShadowStage;
    work(deadlineAtMs: number): Promise<readonly MemoryLexicalShadowLaneReceipt[]>;
  }>): Promise<void> {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + this.configuration.timeoutMs;
    let reported = false;
    const timeout = setTimeout(() => {
      reported = true;
      this.#emit(failureReceipt(
        input.stage,
        "memory_lexical_settle_timeout",
        this.configuration.timeoutMs
      ));
    }, this.configuration.timeoutMs);
    try {
      const lanes = await input.work(deadlineAtMs);
      if (!reported) this.#emit(Object.freeze({
        durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
        event: "memory_lexical_shadow",
        failureCode: null,
        lanes: Object.freeze([...lanes]),
        stage: input.stage,
        timedOut: false,
        version: 1
      }));
    } catch {
      if (!reported) this.#emit(failureReceipt(
        input.stage,
        "memory_lexical_lane_unavailable",
        Math.min(60_000, Math.max(0, Date.now() - startedAt))
      ));
    } finally {
      clearTimeout(timeout);
      this.#active -= 1;
    }
  }
}

export function defaultMemoryLexicalShadowSink(
  receipt: MemoryLexicalShadowReceipt
): void {
  console.info(JSON.stringify(receipt));
}

const defaultShadowRuntimes = new WeakMap<object, Map<string,
  MemoryLexicalShadowRuntime>>();

export function defaultMemoryLexicalShadowRuntime(
  client: PrismaClient,
  env: NodeJS.ProcessEnv = process.env
): MemoryLexicalShadowRuntime | null {
  const configuration = memoryLexicalBackendConfigurationFromEnv(env);
  if (configuration.backend !== "SHADOW") return null;
  const cacheKey = `${configuration.maximumConcurrency}:${configuration.timeoutMs}`;
  const byConfiguration = defaultShadowRuntimes.get(client) ?? new Map();
  const current = byConfiguration.get(cacheKey);
  if (current) return current;
  const created = new BoundedMemoryLexicalShadowRuntime(
    client,
    configuration,
    env,
    defaultMemoryLexicalShadowSink
  );
  byConfiguration.set(cacheKey, created);
  defaultShadowRuntimes.set(client, byConfiguration);
  return created;
}

export function isShadowedMemoryLexicalLane(
  lane: MemoryRetrievalLane
): lane is PostgresUnicodeMemoryLexicalLane {
  return lane === "FACT_LEXICAL_UNICODE" || lane === "FACT_LEXICAL_NGRAM" ||
    lane === "HISTORY_RECALL_LEXICAL_UNICODE" ||
    lane === "HISTORY_RECALL_LEXICAL_NGRAM";
}
