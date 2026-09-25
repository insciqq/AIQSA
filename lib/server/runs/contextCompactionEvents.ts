import { makeContextCompactionStatus, type ContextCompactionStatus, type ContextPlanMeasurement } from "../../contracts/contextCompaction";
import type { RunOutputArtifactEvent } from "./runOutputEvents";

export function contextCompactionArtifact(status: ContextCompactionStatus): RunOutputArtifactEvent {
  return {
    data: { artifactType: "context_compaction", payload: status },
    type: "artifact"
  };
}

/** The one mapping from a run failure code to the published compaction
 * outcome, so a failed cycle and its run always report the same class. */
export function contextCompactionFailureOutcome(code: string): ContextCompactionStatus["outcome"] {
  if (code === "context_compaction_source_unavailable") return "source_unavailable";
  if (code === "context_too_large") return "irreducible_overflow";
  if (code.startsWith("context_compaction_summary_")) return "summary_failed";
  if (code === "context_compaction_provider_failed" || code.startsWith("provider_") || code === "model_not_available") {
    return "provider_failed";
  }
  return "unknown";
}

export function createContextCompactionPublisher(
  append: (status: ContextCompactionStatus) => Promise<void>,
  initial?: ContextCompactionStatus | null
) {
  let latest = initial ?? null;
  let beforeTokens = latest?.beforeTokens ?? null;
  let closed = false;
  let queue = Promise.resolve();
  function serialize(operation: () => Promise<void>): Promise<void> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }
  async function publish(status: ContextCompactionStatus): Promise<void> {
    const cycle = latest ? latest.cycle + (latest.state === "running" ? 0 : 1) : 1;
    const next = { ...status, cycle };
    await append(next);
    latest = next;
    beforeTokens = next.beforeTokens;
  }
  return {
    get running() { return !closed && latest?.state === "running"; },
    begin: (measurement: ContextPlanMeasurement | undefined) => serialize(async () => {
      if (closed || latest?.state === "running") return;
      await publish(makeContextCompactionStatus({ beforeTokens: measurement?.beforeTokens, outcome: "pending", state: "running" }));
    }),
    settle: (outcome: ContextCompactionStatus["outcome"], measurement?: ContextPlanMeasurement) => serialize(async () => {
      if (closed || latest?.state !== "running" && !measurement) return;
      await publish(makeContextCompactionStatus({
        afterTokens: measurement?.afterTokens,
        beforeTokens: latest?.state === "running" ? beforeTokens : measurement?.beforeTokens,
        outcome,
        state: outcome === "summary_applied" || outcome === "masking_applied" ? "complete" : "failed"
      }));
    }),
    /** Stop and terminal settlement close the feed: an unfinished cycle fails
     * with the terminal outcome once, and no later cycle can start. */
    terminate: (outcome?: ContextCompactionStatus["outcome"]) => serialize(async () => {
      if (closed) return;
      closed = true;
      if (!outcome || latest?.state !== "running") return;
      await publish(makeContextCompactionStatus({
        beforeTokens,
        outcome: outcome === "summary_applied" || outcome === "masking_applied" || outcome === "pending" ? "unknown" : outcome,
        state: "failed"
      }));
    })
  };
}

export type ContextCompactionPublisher = ReturnType<typeof createContextCompactionPublisher>;
