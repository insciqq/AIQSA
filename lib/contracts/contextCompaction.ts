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

/** A terminal run cannot still be compacting, and the browser never invents
 * the outcome: an unsettled cycle stays unshown unless the server publishes
 * its settlement. Not every open cycle is settled (an interrupted run
 * leaves it running), so a terminal run may keep a hidden running cycle. */
export function terminalContextCompactionStatus(status: ContextCompactionStatus | null | undefined): ContextCompactionStatus | null {
  return status?.state === "running" ? null : status ?? null;
}
