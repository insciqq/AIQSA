import { knowledgeAnswerCanonicalJson, knowledgeAnswerHash } from "./answerGroundingV5";
import { executeKnowledgeEvidenceAnswerV1, executeKnowledgeEvidenceAnswerWithRefinementV1, type KnowledgeEvidenceAnswerExecutionV1Result } from "./evidenceAnswerExecutionV1";
import { decodeKnowledgeEvidenceAnswerSnapshot, isKnowledgeEvidenceComposeOperation } from "./evidenceAnswerSnapshot";
import type { StoredKnowledgeEvidenceDispatch } from "./evidenceDispatchRepository";
import type { KnowledgeProviderDispatchLifecycle } from "./providerDispatchLifecycle";

/** Publication and recovery use the execution state machine itself. This
 * replay can read settled records only; it cannot authorize, send or settle
 * another provider request. */
export async function replayKnowledgeEvidenceAnswerV1(input: Readonly<{
  dispatches: readonly StoredKnowledgeEvidenceDispatch[];
  forbiddenIdentityFragments: readonly string[];
  modelRunId: string;
}>): Promise<KnowledgeEvidenceAnswerExecutionV1Result> {
  const first = input.dispatches[0];
  const snapshot = decodeKnowledgeEvidenceAnswerSnapshot(first?.attempt.acceptedRequest);
  if (!first || !snapshot || !isKnowledgeEvidenceComposeOperation(snapshot.operation) || input.dispatches.length < 2 || input.dispatches.length > (snapshot.workflowVersion !== undefined ? 8 : 4)) {
    throw Error("knowledge_evidence_answer_replay_invalid");
  }
  let request: unknown;
  try { request = JSON.parse(snapshot.userPrompt).request; }
  catch { throw Error("knowledge_evidence_answer_replay_invalid"); }
  if (typeof request !== "string" || !request.trim()) throw Error("knowledge_evidence_answer_replay_invalid");
  for (const [index, dispatch] of input.dispatches.entries()) {
    const accepted = decodeKnowledgeEvidenceAnswerSnapshot(dispatch.attempt.acceptedRequest);
    if (!accepted || dispatch.attempt.modelRunId !== input.modelRunId || dispatch.attempt.ordinal !== index + 1 ||
      dispatch.attempt.purpose !== accepted.operation || dispatch.attempt.contractVersion !== accepted.contractVersion || dispatch.attempt.providerBindingKey !== "answer" ||
      dispatch.attempt.state !== "settled" || !dispatch.attempt.actualUsage || !dispatch.attempt.acceptedResult ||
      !dispatch.attempt.dispatchedAt || !dispatch.attempt.settledAt || !dispatch.attempt.resultAcceptedAt ||
      dispatch.attempt.dispatchedAt > dispatch.attempt.settledAt || dispatch.attempt.resultAcceptedAt < dispatch.attempt.dispatchedAt ||
      dispatch.attempt.resultAcceptedAt > dispatch.attempt.settledAt || dispatch.attempt.resultHash !== knowledgeAnswerHash(dispatch.attempt.acceptedResult) ||
      dispatch.attempt.requestHash !== knowledgeAnswerHash(accepted) || accepted.evidenceReceiptHash !== dispatch.draft.manifestHash ||
      dispatch.attempt.evidenceReceiptHash !== dispatch.draft.manifestHash || dispatch.retrievalSessionId !== first.retrievalSessionId ||
      accepted.workflowVersion !== snapshot.workflowVersion ||
      snapshot.workflowVersion === undefined && knowledgeAnswerCanonicalJson(dispatch.draft) !== knowledgeAnswerCanonicalJson(first.draft)) throw Error("knowledge_evidence_answer_replay_invalid");
  }
  const unavailable = async (): Promise<never> => { throw Error("knowledge_evidence_answer_replay_io_forbidden"); };
  let consumed = 0;
  const lifecycle: KnowledgeProviderDispatchLifecycle = {
    dispatch: unavailable, markAmbiguous: unavailable, prepare: unavailable, recover: unavailable, release: unavailable, settle: unavailable,
    inspect: async ({ modelRunId, ordinal }) => {
      if (modelRunId !== input.modelRunId || ordinal !== consumed + 1 || !input.dispatches[consumed]) throw Error("knowledge_evidence_answer_replay_incomplete");
      return input.dispatches[consumed++]!;
    }
  };
  const executionInput = { authorize: unavailable, draft: first.draft, execute: unavailable,
    executionPolicy: snapshot.executionPolicy, forbiddenIdentityFragments: input.forbiddenIdentityFragments,
    lifecycle, modelRunId: input.modelRunId, request, shouldAbort: () => true, transport: snapshot.transport };
  const result = snapshot.workflowVersion !== undefined
    ? await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...executionInput,
        ...(snapshot.workflowVersion === 10 || snapshot.workflowVersion === 11 ? { workflowVersion: snapshot.workflowVersion } : {}),
        refineEvidence: async () => input.dispatches[consumed]?.draft ?? null })
    : await executeKnowledgeEvidenceAnswerV1(executionInput);
  if (consumed !== input.dispatches.length || result.operations.length !== consumed) throw Error("knowledge_evidence_answer_replay_incomplete");
  return result;
}
