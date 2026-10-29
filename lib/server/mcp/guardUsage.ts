import type { RunUsageAttribution } from "../runs/runRepositoryContract";

// Like activeRunControllers, this process-global slot is shared by Next route bundles:
// gateway calls and model calls belong to the same live run's after-answer ledger.
const KEY = Symbol.for("aiqsa.mcp-guard-usage.v1");
const slot = globalThis as typeof globalThis & { [KEY]?: Map<string, (usage: RunUsageAttribution) => void> };
const ledgers = slot[KEY] ??= new Map();
export function registerMcpGuardUsage(runId: string, add: (usage: RunUsageAttribution) => void): () => void {
  ledgers.set(runId, add);
  return () => { if (ledgers.get(runId) === add) ledgers.delete(runId); };
}
export function collectMcpGuardUsage(runId: string, usage: RunUsageAttribution): void {
  ledgers.get(runId)?.(usage);
}
