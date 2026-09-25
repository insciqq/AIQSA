import { makeContextCompactionStatus, type ContextCompactionStatus, type ContextPlanMeasurement } from "../../contracts/contextCompaction";
import type { RunOutputArtifactEvent } from "./runOutputEvents";

export function contextCompactionArtifact(status: ContextCompactionStatus): RunOutputArtifactEvent {
  return {
    data: { artifactType: "context_compaction", payload: status },
    type: "artifact"
  };
}

export function contextCompactionFailureOutcome(code: string): ContextCompactionStatus["outcome"] {
  if (code === "context_compaction_source_unavailable") return "source_unavailable";
  if (code === "context_too_large") return "irreducible_overflow";
  if (code.startsWith("context_compaction_summary_")) return "summary_failed";
  if (code.startsWith("provider_") || code === "model_not_available") return "provider_failed";
  return "unknown";
}

export function createContextCompactionPublisher(
  append: (status: ContextCompactionStatus) => Promise<void>,
  initial?: ContextCompactionStatus | null
) {
  let latest = initial ?? null;
  let beforeTokens = latest?.beforeTokens ?? null;
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
    get running() { return latest?.state === "running"; },
    publish: (status: ContextCompactionStatus) => serialize(() => publish(status)),
    begin: (measurement: ContextPlanMeasurement | undefined) => serialize(async () => {
      if (latest?.state === "running") return;
      await publish(makeContextCompactionStatus({ beforeTokens: measurement?.beforeTokens, outcome: "pending", state: "running" }));
    }),
    settle: (outcome: ContextCompactionStatus["outcome"], measurement?: ContextPlanMeasurement) => serialize(async () => {
      if (latest?.state !== "running" && !measurement) return;
      await publish(makeContextCompactionStatus({
        afterTokens: measurement?.afterTokens,
        beforeTokens: latest?.state === "running" ? beforeTokens : measurement?.beforeTokens,
        outcome,
        state: outcome === "summary_applied" || outcome === "masking_applied" ? "complete" : "failed"
      }));
    })
  };
}
