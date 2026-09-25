export type ContextPlanOutcome = "already_fits" | "masking_applied" | "needs_summary" | "irreducible_overflow";

export type ContextSummaryAttemptState =
  | "claim"
  | "dispatched"
  | "settled"
  | "committed"
  | "invalid"
  | "unknown"
  | "failed";

/** Content-free provider usage kept with a summary attempt. */
export type ContextSummaryUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

/** A bounded, model-derived note set. Exact pins and source handles remain
 * outside this object and continue to be owned by the planner/reader. */
export type ContextSummary = Readonly<{
  formatVersion: 1;
  id: string;
  notes: string;
  sourceDigest: string;
  sourceRefs: readonly string[];
}>;

export type ContextSummaryAttempt = Readonly<{
  attempt: number;
  bindingDigest: string;
  errorCode?: string;
  id: string;
  state: ContextSummaryAttemptState;
  sourceDigest: string;
  usage?: ContextSummaryUsage;
}>;

/** Content-free planner measurement. The source transcript and observation
 * descriptors remain server-owned and are never part of this projection. */
export type ContextPlanMeasurement = Readonly<{
  version: 1;
  outcome: ContextPlanOutcome;
  beforeTokens: number;
  afterTokens: number;
  budgetTokens: number | null;
  maskedBatches: number;
  maskedObservations: number;
  legacyFallback: boolean;
}>;

/** Content-free status shared by the run event feed and Chat disclosure. */
export type ContextCompactionStatus = Readonly<{
  cycle: number;
  afterTokens: number | null;
  beforeTokens: number | null;
  outcome:
    | "irreducible_overflow"
    | "masking_applied"
    | "pending"
    | "provider_failed"
    | "source_unavailable"
    | "summary_applied"
    | "summary_failed"
    | "unknown";
  reducedTokens: number | null;
  stage: "settled" | "summarizing";
  state: "complete" | "failed" | "running";
  version: 1;
}>;

const contextCompactionOutcomes = new Set<ContextCompactionStatus["outcome"]>([
  "irreducible_overflow", "masking_applied", "pending", "provider_failed",
  "source_unavailable", "summary_applied", "summary_failed", "unknown"
]);

/** Strict browser boundary: notes, source handles and provider receipts never cross it. */
export function decodeContextCompactionStatus(value: unknown): ContextCompactionStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "afterTokens,beforeTokens,cycle,outcome,reducedTokens,stage,state,version" ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.cycle) || Number(record.cycle) < 1 ||
    (record.stage !== "settled" && record.stage !== "summarizing") ||
    (record.state !== "complete" && record.state !== "failed" && record.state !== "running") ||
    !contextCompactionOutcomes.has(record.outcome as ContextCompactionStatus["outcome"])) return null;
  const tokenValue = (candidate: unknown): candidate is number | null =>
    candidate === null || typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  if (!tokenValue(record.beforeTokens) || !tokenValue(record.afterTokens) || !tokenValue(record.reducedTokens)) return null;
  if (record.state === "running" && (record.stage !== "summarizing" || record.outcome !== "pending")) return null;
  if ((record.state !== "running" && record.stage !== "settled") || (record.outcome === "pending" && record.state !== "running")) return null;
  const successful = record.outcome === "summary_applied" || record.outcome === "masking_applied";
  if ((record.state === "complete") !== successful) return null;
  if (record.reducedTokens !== null && (record.beforeTokens === null || record.afterTokens === null ||
    record.afterTokens > record.beforeTokens || record.reducedTokens !== record.beforeTokens - record.afterTokens)) return null;
  return record as ContextCompactionStatus;
}

export function makeContextCompactionStatus(input: Readonly<{
  cycle?: number;
  afterTokens?: number | null;
  beforeTokens?: number | null;
  outcome: ContextCompactionStatus["outcome"];
  state: ContextCompactionStatus["state"];
}>): ContextCompactionStatus {
  const beforeTokens = input.beforeTokens ?? null;
  const afterTokens = input.afterTokens ?? null;
  const reducedTokens = beforeTokens !== null && afterTokens !== null && afterTokens <= beforeTokens
    ? beforeTokens - afterTokens : null;
  const status: ContextCompactionStatus = {
    cycle: input.cycle ?? 1,
    afterTokens,
    beforeTokens,
    outcome: input.outcome,
    reducedTokens,
    stage: input.state === "running" ? "summarizing" : "settled",
    state: input.state,
    version: 1
  };
  const decoded = decodeContextCompactionStatus(status);
  if (!decoded) throw new Error("context_compaction_status_invalid");
  return decoded;
}

/** A later server-owned cycle may start again; a settled cycle never regresses. */
export function mergeContextCompactionStatus(
  current: ContextCompactionStatus | null | undefined,
  next: ContextCompactionStatus | null | undefined
): ContextCompactionStatus | null {
  if (!next) return current ?? null;
  if (!current || next.cycle > current.cycle) return next;
  if (next.cycle < current.cycle || current.state !== "running") return current;
  return next;
}

/** A terminal run cannot still be compacting. Never infer successful completion. */
export function terminalContextCompactionStatus(status: ContextCompactionStatus | null | undefined): ContextCompactionStatus | null {
  return status?.state === "running"
    ? makeContextCompactionStatus({ beforeTokens: status.beforeTokens, cycle: status.cycle, outcome: "unknown", state: "failed" })
    : status ?? null;
}

export type ConversationContextPolicy = Readonly<{
  version: 1;
  mode: "legacy_compatible" | "hybrid";
  source: Readonly<{ leafMessageId: string | null; digest: string; messageCount: number }>;
}>;

export type ContextCompactionCheckpoint = Readonly<{
  version: 1;
  ownerId: string;
  runId: string;
  branchId: string;
  policyRevision: "legacy-compatible-v1" | "hybrid-v1";
  sourceDigest: string;
  pinDigest: string;
  followupRevision: number;
  followupDigest: string;
  observationRefs: readonly string[];
  recentTailCallIds: readonly string[];
  providerProjectionRevision: number;
  measurement: ContextPlanMeasurement;
  summary?: ContextSummary;
  summaryAttempts?: readonly ContextSummaryAttempt[];
}>;
