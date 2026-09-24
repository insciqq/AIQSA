import type { ProviderRunRequest } from "../providers/types";
import { applyProviderRequestContextBudget } from "../runs/runContextBudget";
import { isSkillToolName, skillToolError } from "../tools/skill";
import type { ModelToolCall, ProviderToolBridge, ToolExecutionResult } from "../tools/types";
import { projectObservationForProvider, projectSkillObservationForBudget } from "../toolObservations/projection";

/** Shared by execution and recovery. Skill calls settle after the other tools
 * in the round, so their admission includes every other result and reserves a
 * small error result for each Skill call still pending. */
export function createSkillToolResultBudget() {
  let request: ProviderRunRequest | null = null;
  let bridge: ProviderToolBridge | undefined;
  let calls: readonly Pick<ModelToolCall, "id" | "name">[] = [];
  const results = new Map<string, ToolExecutionResult>();
  return {
    begin(input: { request: ProviderRunRequest; bridge: ProviderToolBridge; calls: readonly Pick<ModelToolCall, "id" | "name">[] }) {
      request = input.request;
      bridge = input.bridge;
      calls = input.calls;
      results.clear();
    },
    accept(result: ToolExecutionResult): ToolExecutionResult {
      let admitted = result;
      if (request && bridge && isSkillToolName(result.name) && result.status === "complete") {
        const next = calls.flatMap((call) => {
          const value = call.id === result.callId ? result : results.get(call.id) ??
            (isSkillToolName(call.name) ? skillToolError(call, "skill_too_large_for_context") : null);
          const projected = value && request!.toolObservationVersion === 1
            ? isSkillToolName(value.name) && value.status === "complete"
              ? projectSkillObservationForBudget(value) : projectObservationForProvider(value)
            : value;
          return projected ? [bridge!.appendToolResult(undefined, projected)] : [];
        });
        const budget = applyProviderRequestContextBudget({ bridge, request: {
          ...request, providerToolMessages: [...(request.providerToolMessages ?? []), ...next]
        } });
        if (!budget.ok) admitted = skillToolError({ id: result.callId, name: result.name }, "skill_too_large_for_context");
      }
      results.set(result.callId, admitted);
      return admitted;
    },
    restore(result: ToolExecutionResult) { results.set(result.callId, result); }
  };
}
