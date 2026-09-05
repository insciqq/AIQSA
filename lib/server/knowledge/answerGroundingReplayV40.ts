import { knowledgeAnswerCanonicalJson, knowledgeAnswerHash } from "./answerGroundingV5";
import {
  decodeKnowledgeAnswerDraftPrimaryPromptV40,
  decodeKnowledgeAnswerOperationRequestSnapshotV40
} from "./answerGroundingSnapshotV40";
import {
  executeKnowledgeAnswerGroundingV21,
  type KnowledgeAnswerGroundingExecutionV21ScopeV6Result
} from "./answerGroundingExecutionV21ScopeV6";
import type { StoredKnowledgeEvidenceDispatch } from "./evidenceDispatchRepository";
import type { KnowledgeProviderDispatchLifecycle } from "./providerDispatchLifecycle";

/** Reuses the production state machine for settlement. The only available
 * lifecycle action is an ordered read of already accepted operations; every
 * mutation, authorization or provider call is an error. */
export async function replayKnowledgeAnswerGroundingV40(input: Readonly<{
  dispatches: readonly StoredKnowledgeEvidenceDispatch[];
  forbiddenIdentityFragments: readonly string[];
  modelRunId: string;
}>): Promise<KnowledgeAnswerGroundingExecutionV21ScopeV6Result> {
  const first = input.dispatches[0];
  const snapshot = decodeKnowledgeAnswerOperationRequestSnapshotV40(first?.attempt.acceptedRequest);
  const prompt = first && snapshot ? decodeKnowledgeAnswerDraftPrimaryPromptV40({ draft: first.draft, snapshot }) : null;
  if (!first || !snapshot || !prompt || input.dispatches.length < 4 || input.dispatches.length > 8) {
    throw new Error("knowledge_answer_replay_invalid");
  }
  const manifest = knowledgeAnswerCanonicalJson(first.draft);
  for (const [index, dispatch] of input.dispatches.entries()) {
    const request = decodeKnowledgeAnswerOperationRequestSnapshotV40(dispatch.attempt.acceptedRequest);
    if (!request || dispatch.attempt.modelRunId !== input.modelRunId || dispatch.attempt.ordinal !== index + 1 ||
      dispatch.attempt.purpose !== request.operation || dispatch.attempt.contractVersion !== request.contractVersion ||
      dispatch.attempt.providerBindingKey !== "answer" || dispatch.attempt.state !== "settled" ||
      !dispatch.attempt.actualUsage || !dispatch.attempt.acceptedResult ||
      !dispatch.attempt.dispatchedAt || !dispatch.attempt.settledAt || !dispatch.attempt.resultAcceptedAt ||
      dispatch.attempt.dispatchedAt > dispatch.attempt.settledAt ||
      dispatch.attempt.resultAcceptedAt < dispatch.attempt.dispatchedAt ||
      dispatch.attempt.resultAcceptedAt > dispatch.attempt.settledAt ||
      dispatch.attempt.resultHash !== knowledgeAnswerHash(dispatch.attempt.acceptedResult) ||
      request.evidenceReceiptHash !== first.draft.manifestHash ||
      dispatch.attempt.evidenceReceiptHash !== first.draft.manifestHash ||
      dispatch.retrievalSessionId !== first.retrievalSessionId || knowledgeAnswerCanonicalJson(dispatch.draft) !== manifest) {
      throw new Error("knowledge_answer_replay_invalid");
    }
  }
  const unavailable = async (): Promise<never> => { throw new Error("knowledge_answer_replay_io_forbidden"); };
  let consumed = 0;
  const lifecycle: KnowledgeProviderDispatchLifecycle = {
    dispatch: unavailable,
    inspect: async ({ modelRunId, ordinal }) => {
      if (modelRunId !== input.modelRunId || ordinal !== consumed + 1 || !input.dispatches[consumed]) {
        throw new Error("knowledge_answer_replay_incomplete");
      }
      return input.dispatches[consumed++]!;
    },
    markAmbiguous: unavailable,
    prepare: unavailable,
    recover: unavailable,
    release: unavailable,
    settle: unavailable
  };
  const result = await executeKnowledgeAnswerGroundingV21({
    authorize: unavailable,
    draft: first.draft,
    execute: unavailable,
    executionPolicy: snapshot.executionPolicy,
    forbiddenIdentityFragments: input.forbiddenIdentityFragments,
    lifecycle,
    modelRunId: input.modelRunId,
    ...prompt,
    shouldAbort: () => true,
    snapshotVersion: 40,
    transport: snapshot.transport
  });
  if (consumed !== input.dispatches.length || result.operations.length !== consumed || !result.contributionReceipt) {
    throw new Error("knowledge_answer_replay_incomplete");
  }
  return result;
}
