import { mergeThreadSearchEngineActivity, type ThreadSearchEngineActivity } from "../../contracts/searchActivity";
import { plainWorkspaceActivityText } from "../workspace/activityText";

type SearchOption = Readonly<{ adapterKind?: unknown; displayName?: unknown; optionId?: unknown }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Accepted names and ordinal identities only; no integration IDs reach the browser. */
export function acceptedClientSearchOptions(request: unknown): Readonly<{ optionId: string; name: string; engine: number }>[] {
  if (!record(request) || !record(request.searchPlan) || !Array.isArray(request.searchPlan.options)) return [];
  return (request.searchPlan.options as SearchOption[])
    .filter(option => record(option) && option.adapterKind === "provider_model_client" && typeof option.optionId === "string")
    .slice(0, 3)
    .map((option, index) => {
      const name = typeof option.displayName === "string" ? plainWorkspaceActivityText(option.displayName) : "";
      return { optionId: option.optionId as string,
        name: name.trim().replace(/\s+/gu, " ").slice(0, 160) || "Web search", engine: index + 1 };
    });
}

/** A persisted SearchRun is one outcome of one accepted logical engine invocation. */
export function projectSearchEngineActivity(input: Readonly<{
  normalizedRequest: unknown;
  runStatus?: string;
  searchRuns: readonly Readonly<{ invocationId?: string | null; status?: string; strategyId?: string }>[];
  toolCalls: readonly Readonly<{ state: string; toolName: string }>[];
  snapshots?: readonly ThreadSearchEngineActivity[];
}>): ThreadSearchEngineActivity[] {
  const options = acceptedClientSearchOptions(input.normalizedRequest);
  if (!options.length) return [];
  const names = options.map(option => option.optionId);
  const counts = options.map(option => ({ engine: option.engine, name: option.name,
    requested: 0, settled: 0, complete: 0, error: 0, skipped: 0 }));
  const mode = record(input.normalizedRequest) && record(input.normalizedRequest.searchPlan)
    ? input.normalizedRequest.searchPlan.mode : null;
  for (const call of input.toolCalls) {
    const selected = call.toolName === "search_selected_engines" && mode === "all_selected"
      ? counts
      : /^search_engine_[1-3]$/u.test(call.toolName)
        ? [counts[Number(call.toolName.slice(-1)) - 1]].filter((row): row is typeof counts[number] => Boolean(row))
        : [];
    for (const row of selected) {
      row.requested += 1;
      if (call.state === "complete" || call.state === "error" || call.state === "cancelled") row.settled += 1;
    }
  }
  const seenInvocations = new Set<string>();
  for (const row of input.searchRuns) {
    if (!row.invocationId || !row.strategyId) continue;
    if (seenInvocations.has(row.invocationId)) continue;
    seenInvocations.add(row.invocationId);
    const index = names.indexOf(row.strategyId);
    if (index < 0) continue;
    if (row.status === "complete") counts[index]!.complete += 1;
    else if (row.status === "error") counts[index]!.error += 1;
  }
  // A settled call with no SearchRun may still be awaiting accounting, or may
  // be legacy evidence. Only an explicit snapshot can classify it as skipped.
  for (const row of counts) {
    row.settled = Math.max(row.settled, row.complete + row.error);
    row.requested = Math.max(row.requested, row.settled);
  }
  const snapshots = (input.snapshots ?? []).flatMap(snapshot => {
    const accepted = options.find(option => option.engine === snapshot.engine);
    return accepted ? [{ ...snapshot, name: accepted.name }] : [];
  });
  return mergeThreadSearchEngineActivity(counts, snapshots)
    .filter(row => row.requested > 0)
    .map(row => input.runStatus === "complete" || input.runStatus === "error" || input.runStatus === "cancelled"
      ? { ...row, settled: row.requested }
      : row);
}
