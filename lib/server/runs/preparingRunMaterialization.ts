import type { CreatedRun, PreparingRunMemoryMaterializer } from "./runRepositoryContract";
import type { NormalizedRunRequest, ProviderAdapter, ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import type { materializePreparedRunData } from "./runPreparation";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import { contextCompactionPolicyRetired } from "./contextCompactionContract";

export function createPreparingMemoryMaterializer(
  prepared: ReturnType<typeof materializePreparedRunData>,
  adapter: ProviderAdapter,
  bridge: ProviderToolBridge | undefined
): PreparingRunMemoryMaterializer {
  return (personalContext, memoryActionAnswerResult) => {
    const normalizedRequest: NormalizedRunRequest = {
      ...prepared.normalizedRequest,
      ...(personalContext ? { personalContext } : {}),
      prompt: {
        ...prepared.normalizedRequest.prompt,
        ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {})
      }
    };
    const request: ProviderRunRequest = {
      ...prepared.providerRequest,
      ...normalizedRequest,
      ...(personalContext ? { personalContext } : {})
    };
    // A request accepted under the retired context policy is never budgeted;
    // its executor ends it as `context_compaction_policy_retired`.
    if (contextCompactionPolicyRetired(request)) return null;
    const budgeted = applyProviderRequestContextBudget({
      ...(bridge ? { bridge } : {}),
      request
    });
    if (!budgeted.ok || !budgeted.request.context) return null;
    const finalNormalizedRequest: NormalizedRunRequest = {
      ...normalizedRequest,
      context: budgeted.request.context
    };
    const providerRequest: ProviderRunRequest = {
      ...budgeted.request,
      ...finalNormalizedRequest,
      attachments: budgeted.request.attachments
    };
    return {
      contextTruncation: budgeted.contextTruncation ?? prepared.contextTruncation,
      normalizedRequest: finalNormalizedRequest,
      providerRequest,
      providerRequestPreview: adapter.buildRequestPreview(providerRequest)
    };
  };
}

export function applyPreparingMaterialization(
  prepared: ReturnType<typeof materializePreparedRunData>,
  created: CreatedRun
): ReturnType<typeof materializePreparedRunData> {
  return created.materializedRequest
    ? {
        ...prepared,
        contextTruncation: created.materializedRequest.contextTruncation,
        normalizedRequest: created.materializedRequest.normalizedRequest,
        providerRequest: created.materializedRequest.providerRequest,
        providerRequestPreview: { ...created.materializedRequest.providerRequestPreview }
      }
    : prepared;
}
