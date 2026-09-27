import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { tokenEstimateProfileFor } from "../../domain/tokenEstimate";
import { reportedTokenCount } from "../../domain/usage";
import { logEvent } from "../observability";
import type { ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import { providerRequestTokenEstimate } from "./runContextBudget";

/**
 * Drift evidence for the context estimate, without content: per estimate
 * family, the provider-reported input tokens of one dispatched round against
 * the budget's estimate of that exact request. Only numbers and enumerated
 * families leave; a failure here never affects the round.
 */
export function observeContextEstimate(
  bridge: ProviderToolBridge | undefined,
  request: ProviderRunRequest,
  usage: ModelRunUsage
): void {
  try {
    const profile = tokenEstimateProfileFor(request);
    const reported = reportedTokenCount(usage.inputTokens);
    if (!profile || reported === null || reported === 0) return;
    const estimated = providerRequestTokenEstimate(request, bridge);
    if (!Number.isSafeInteger(estimated) || estimated <= 0) return;
    logEvent("context_estimate", {
      estimate_family: profile.family,
      estimated_tokens: estimated,
      providerFamily: request.provider,
      ratio_permille: Math.round((reported * 1_000) / estimated),
      reported_input_tokens: reported
    });
  } catch {
    // Diagnostics never replace the round's outcome.
  }
}
