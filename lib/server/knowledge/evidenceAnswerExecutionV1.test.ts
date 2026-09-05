import { describe, expect, it, vi } from "vitest";
import { executeKnowledgeEvidenceAnswerV1, executeKnowledgeEvidenceAnswerWithRefinementV1, knowledgeEvidenceRefinementAddsEvidence } from "./evidenceAnswerExecutionV1";
import { replayKnowledgeEvidenceAnswerV1 } from "./evidenceAnswerReplayV1";
import { decodeKnowledgeEvidenceAnswerSnapshot } from "./evidenceAnswerSnapshot";
import { packKnowledgeEvidenceDispatchManifest } from "./evidenceDispatchManifest";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import { resolveKnowledgeGroundingExecutionPolicyV1 } from "./groundingExecutionPolicy";
import type { StoredKnowledgeEvidenceDispatch } from "./evidenceDispatchRepository";
import type { KnowledgeProviderDispatchLifecycle, PreparedKnowledgeProviderDispatch } from "./providerDispatchLifecycle";

const usage = { cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 };
const request = "Calculate the combined mass of Alpha and Beta.";
const policy = resolveKnowledgeGroundingExecutionPolicyV1({ modelCapabilities: {} });
type RefineEvidence = Parameters<typeof executeKnowledgeEvidenceAnswerWithRefinementV1>[0]["refineEvidence"];
function manifest(withBeta = false, extraOperands = 0) {
  return packKnowledgeEvidenceDispatchManifest({ candidates: [{ ambiguity: "none", evidenceId: "fixture-evidence", exactExcerpt: "Alpha has a mass of 4 kg.",
    fileName: "fixture.txt", handle: "K1", locator: "page=1", operationOrdinal: 1, resultOrdinal: 1,
    sourceAlias: "S1", sourceLabel: "Warehouse inventory", sourceTruncated: false, sourceVersionNumber: 1, state: "available" },
    ...(withBeta ? [{ ambiguity: "none" as const, evidenceId: "fixture-beta-evidence", exactExcerpt: "Beta has a mass of 6 kg.",
      fileName: "beta.txt", handle: "K2", locator: "page=1", operationOrdinal: 2, resultOrdinal: 1,
      sourceAlias: "S2", sourceLabel: "Second warehouse", sourceTruncated: false, sourceVersionNumber: 1, state: "available" as const }] : []),
    ...["Gamma", "Delta"].slice(0, extraOperands).map((name, index) => ({
      ambiguity: "none" as const, evidenceId: `fixture-${name}-evidence`, exactExcerpt: `${name} has a mass of ${8 + index * 2} kg.`,
      fileName: `${name}.txt`, handle: `K${index + 3}`, locator: "page=1", operationOrdinal: index + 3, resultOrdinal: 1,
      sourceAlias: `S${index + 3}`, sourceLabel: `Warehouse ${name}`, sourceTruncated: false, sourceVersionNumber: 1, state: "available" as const
    }))],
    coverageStatement: "Coverage is limited to the delivered evidence.", header: "<private_knowledge_evidence>", footer: "</private_knowledge_evidence>",
    maximumBytes: 32_000, maximumTokens: 8_000, profileId: "fake:answer", promptFragmentVersion: 1, runtimeVersion: 1 });
}
const compose = () => ({ version: 1, blocks: [{ kind: "paragraph", text: "Alpha has a mass of 4 kg.", evidenceHandles: ["K1"] }] });
const review = () => ({ version: 1, blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1"] }],
  coverage: "partial", analysisComplete: true, missingInformation: ["The mass of Beta."], followUps: [{ query: "Beta mass", sourceAliases: [] }] });
function recorder() {
  const entries = new Map<number, StoredKnowledgeEvidenceDispatch>();
  const unavailable = async (): Promise<never> => { throw Error("unexpected_lifecycle_action"); };
  const lifecycle: KnowledgeProviderDispatchLifecycle = {
    inspect: vi.fn(async ({ ordinal }) => entries.get(ordinal) ?? null),
    prepare: vi.fn(async input => {
      const dispatch = { draft: input.draft, retrievalSessionId: "fixture-session", manifestId: `manifest-${input.ordinal}`,
        attempt: { id: `attempt-${input.ordinal}`, modelRunId: input.modelRunId, ordinal: input.ordinal,
          purpose: input.purpose, providerBindingKey: "answer", contractVersion: input.contractVersion,
          evidenceReceiptHash: input.evidenceReceiptHash, acceptedRequest: JSON.parse(JSON.stringify(input.acceptedRequest)) as unknown,
          acceptedResult: null, actualUsage: null, resultHash: null, requestHash: knowledgeAnswerHash(input.acceptedRequest),
          dispatchedAt: null, settledAt: null, resultAcceptedAt: null, providerResponseId: null, state: "reserved" }
      } as StoredKnowledgeEvidenceDispatch;
      entries.set(input.ordinal, dispatch);
      return { dispatch } as PreparedKnowledgeProviderDispatch;
    }),
    dispatch: vi.fn(async ({ dispatch }) => { Object.assign(dispatch.attempt, { state: "dispatched", dispatchedAt: new Date(1) }); }),
    settle: vi.fn(async ({ dispatch }, result) => { Object.assign(dispatch.attempt, { state: "settled", acceptedResult: result.acceptedResult,
      resultHash: knowledgeAnswerHash(result.acceptedResult), actualUsage: result.usage, providerResponseId: result.providerResponseId,
      resultAcceptedAt: new Date(2), settledAt: new Date(2) }); }),
    markAmbiguous: vi.fn(async () => undefined), release: vi.fn(async () => undefined), recover: unavailable
  };
  const stored = () => JSON.parse(JSON.stringify([...entries.values()]), (key, value: unknown) =>
    ["dispatchedAt", "settledAt", "resultAcceptedAt"].includes(key) && typeof value === "string" ? new Date(value) : value) as StoredKnowledgeEvidenceDispatch[];
  return { lifecycle, stored };
}
function execution(outputs: readonly unknown[]) {
  const store = recorder();
  let cursor = 0;
  const execute = vi.fn(async () => {
    if (cursor >= outputs.length) throw Error("unexpected_extra_provider_call");
    const output = outputs[cursor++];
    if (output instanceof Error || output instanceof DOMException) throw output;
    return { output: output as Readonly<Record<string, unknown>>, usage, providerResponseId: `response-${cursor}` };
  });
  const input = { authorize: vi.fn(async () => undefined), draft: manifest(), execute, executionPolicy: policy,
    forbiddenIdentityFragments: ["fixture-private-identity"], lifecycle: store.lifecycle,
    modelRunId: "fixture-run", request, shouldAbort: () => false, transport: "native_strict" as const };
  return { input, execute, store };
}

describe("evidence answer execution and recovery", () => {
  it("corrects a known-operand calculation once without another search and replays the accepted critique", async () => {
    const wrong = { version: 1, blocks: [{ kind: "paragraph", text: "Alpha and Beta total 12 kg (4 + 6).", evidenceHandles: ["K1", "K2"] }] };
    const critique = { version: 2, analysisComplete: true, followUps: [],
      blocks: [{ blockId: "B1", verdict: "contradicted", evidenceHandles: [], reason: "4 + 6 equals 10, not 12." }],
      requirements: [{ requirement: request, status: "needs_correction", blockIds: [], correctionEvidenceHandles: ["K1", "K2"],
        gap: "Compute the sum using the two cited masses." }] };
    const corrected = { version: 1, blocks: [{ kind: "paragraph", text: "Alpha and Beta total 10 kg (4 + 6).", evidenceHandles: ["K1", "K2"] }] };
    const accepted = { version: 2, analysisComplete: true, followUps: [],
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1", "K2"], reason: "" }],
      requirements: [{ requirement: request, status: "answered", blockIds: ["B1"], correctionEvidenceHandles: [], gap: "" }] };
    const fixture = execution([wrong, critique, corrected, accepted]);
    const refineEvidence = vi.fn(async () => { throw Error("unexpected_search"); });
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, draft: manifest(true), workflowVersion: 11, refineEvidence });
    expect(result.publication.coverage).toBe("complete");
    expect(result.publication.blocks[0]?.text).toBe(corrected.blocks[0]?.text);
    expect(result.operations).toHaveLength(4);
    expect(refineEvidence).not.toHaveBeenCalled();
    expect(result.compositionRepairAttempted).toBe(false);
    expect(result.reviewRepairAttempted).toBe(false);
    const stored = fixture.store.stored();
    expect(stored[2]?.draft.manifestHash).toBe(stored[0]?.draft.manifestHash);
    expect(stored[2]?.attempt.acceptedRequest).toMatchObject({ version: 42, workflowVersion: 11, contractVersion: 2,
      reviewPayloadHash: knowledgeAnswerHash(stored[1]?.attempt.acceptedResult) });
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: stored, forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(4);
    for (const mutation of [{ workflowVersion: 10 }, { contractVersion: 1 }, { pipeline: "evidence_answer_review_v1" },
      { schema: {} }, { name: "knowledge_evidence_compose_v1" }]) {
      const altered = fixture.store.stored();
      Object.assign(altered[0]!.attempt.acceptedRequest!, mutation);
      altered[0]!.attempt.requestHash = knowledgeAnswerHash(altered[0]!.attempt.acceptedRequest);
      expect(decodeKnowledgeEvidenceAnswerSnapshot(altered[0]!.attempt.acceptedRequest)).toBeNull();
      await expect(replayKnowledgeEvidenceAnswerV1({ dispatches: altered, forbiddenIdentityFragments: [], modelRunId: "fixture-run" }))
        .rejects.toThrow("knowledge_evidence_answer_replay_invalid");
    }
  });

  it.each([{ repairs: false, correctionFailure: false }, { repairs: true, correctionFailure: false },
    { repairs: false, correctionFailure: true }])("retrieves then corrects a derivation within the shared budget ($repairs, $correctionFailure)", async ({ repairs, correctionFailure }) => {
    const missing = { version: 2, analysisComplete: true,
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1"], reason: "" }],
      requirements: [{ requirement: request, status: "missing_evidence", blockIds: ["B1"], correctionEvidenceHandles: [], gap: "The mass of Beta." }],
      followUps: [{ query: "Beta mass", sourceAliases: [], requirementIds: ["R1"] }] };
    const wrong = { version: 1, blocks: [{ kind: "paragraph", text: "The combined mass is 12 kg (4 + 6).", evidenceHandles: ["K1", "K2"] }] };
    const critique = { version: 2, analysisComplete: true, followUps: [],
      blocks: [{ blockId: "B1", verdict: "contradicted", evidenceHandles: [], reason: "The sum of 4 and 6 is 10." }],
      requirements: [{ requirement: request, status: "needs_correction", blockIds: [], correctionEvidenceHandles: ["K1", "K2"], gap: "Correct the addition." }] };
    const corrected = { version: 1, blocks: [{ kind: "paragraph", text: "The combined mass is 10 kg (4 + 6).", evidenceHandles: ["K1", "K2"] }] };
    const accepted = { version: 2, analysisComplete: true, followUps: [],
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1", "K2"], reason: "" }],
      requirements: [{ requirement: request, status: "answered", blockIds: ["B1"], correctionEvidenceHandles: [], gap: "" }] };
    const fixture = execution([...(repairs ? [{}] : []), compose(), ...(repairs ? [{}] : []), missing, wrong, critique,
      ...(correctionFailure ? [new TypeError("fetch failed")] : [corrected, accepted])]);
    const refineEvidence = vi.fn(async () => manifest(true));
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, workflowVersion: 11, refineEvidence });
    expect(result.publication).toMatchObject({ coverage: correctionFailure ? "partial" : "complete",
      blocks: [{ text: correctionFailure ? compose().blocks[0]!.text : corrected.blocks[0]!.text }] });
    expect(result.operations).toHaveLength(correctionFailure ? 5 : repairs ? 8 : 6);
    expect(result.compositionRepairAttempted).toBe(repairs);
    expect(result.reviewRepairAttempted).toBe(repairs);
    expect(refineEvidence).toHaveBeenCalledOnce();
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored(), forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(correctionFailure ? 5 : repairs ? 8 : 6);
  });

  it.each([false, true])("does not reroll an unchanged answer or keep correcting the same evidence (%s)", changed => {
    const wrong = { version: 1, blocks: [{ kind: "paragraph", text: "Alpha and Beta total 12 kg (4 + 6).", evidenceHandles: ["K1", "K2"] }] };
    const critique = { version: 2, analysisComplete: true, followUps: [],
      blocks: [{ blockId: "B1", verdict: "contradicted", evidenceHandles: [], reason: "The sum of the two cited masses is 10 kg." }],
      requirements: [{ requirement: request, status: "needs_correction", blockIds: [], correctionEvidenceHandles: ["K1", "K2"],
        gap: "Compute the sum using the two cited masses." }] };
    const fixture = execution([wrong, critique, changed ? { ...wrong,
      blocks: [{ ...wrong.blocks[0], text: "Alpha and Beta total 11 kg (4 + 6)." }] } : wrong, ...(changed ? [critique] : [])]);
    const refineEvidence = vi.fn(async () => null);
    return executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, draft: manifest(true), workflowVersion: 11, refineEvidence }).then(async result => {
      expect(result.operations).toHaveLength(changed ? 4 : 3);
      expect(result.publication.blocks).toEqual([]);
      expect(refineEvidence).not.toHaveBeenCalled();
      expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored(), forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
      expect(fixture.execute).toHaveBeenCalledTimes(changed ? 4 : 3);
    });
  });

  it.each([undefined, 10] as const)("follows successive evidence gaps only under the admitted adaptive workflow (%s)", async workflowVersion => {
    const beta = { version: 1, blocks: [{ kind: "paragraph", text: "Alpha and Beta total 10 kg.", evidenceHandles: ["K1", "K2"] }] };
    const needsGamma = { ...review(), missingInformation: ["The mass of Gamma."], followUps: [{ query: "Gamma mass", sourceAliases: [] }],
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1", "K2"] }] };
    const complete = { ...needsGamma, coverage: "complete", missingInformation: [], followUps: [],
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1", "K2", "K3"] }] };
    const fixture = execution([compose(), review(), beta, needsGamma,
      { version: 1, blocks: [{ kind: "paragraph", text: "The combined mass is 18 kg (4 + 6 + 8).", evidenceHandles: ["K1", "K2", "K3"] }] }, complete]);
    const refineEvidence = vi.fn<RefineEvidence>(async (result, previousDraft) => {
      if (result.operations.length === 2) {
        expect(previousDraft.manifestHash).toBe(manifest().manifestHash);
        return manifest(true);
      }
      expect(result.operations).toHaveLength(4);
      expect(previousDraft.manifestHash).toBe(manifest(true).manifestHash);
      return manifest(true, 1);
    });
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, workflowVersion,
      request: "Calculate the combined mass of Alpha, Beta and Gamma.", refineEvidence });
    expect(result.publication.coverage).toBe(workflowVersion === 10 ? "complete" : "partial");
    expect(refineEvidence).toHaveBeenCalledTimes(workflowVersion === 10 ? 2 : 1);
    expect(result.operations).toHaveLength(workflowVersion === 10 ? 6 : 4);
    expect(result.compositionRepairAttempted).toBe(false);
    expect(result.reviewRepairAttempted).toBe(false);
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored(), forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(workflowVersion === 10 ? 6 : 4);
  });

  it("uses at most eight answer operations and never searches for a fifth cycle", async () => {
    const fixture = execution(["Beta", "Gamma", "Delta", "Epsilon"].flatMap(name => [compose(), {
      ...review(), missingInformation: [`The mass of ${name}.`], followUps: [{ query: `${name} mass`, sourceAliases: [] }]
    }]));
    let count = 0;
    const refineEvidence = vi.fn(async () => manifest(true, count++));
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, workflowVersion: 10,
      request: "Calculate the combined mass of Alpha, Beta, Gamma, Delta and Epsilon.", refineEvidence });
    expect(result.operations.map(operation => operation.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(refineEvidence).toHaveBeenCalledTimes(3);
    expect(result.publication.coverage).toBe("partial");
    expect(result.compositionRepairAttempted).toBe(false);
    expect(result.reviewRepairAttempted).toBe(false);
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored(), forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(8);
  });

  it("retains the last reviewed answer when a structural repair consumes the remaining budget", async () => {
    const fixture = execution([compose(), review(), compose(), review(), compose(), review(), {}, compose()]);
    let count = 0;
    const refineEvidence = vi.fn(async () => manifest(true, count++));
    const accepted = vi.fn();
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, workflowVersion: 10,
      refineEvidence, onOperationAccepted: accepted });
    expect(result.operations.map(operation => operation.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.evidenceReceiptHash).toBe(manifest(true, 1).manifestHash);
    expect(result.publication.blocks).toMatchObject([{ text: "Alpha has a mass of 4 kg." }]);
    expect(result.compositionRepairAttempted).toBe(true);
    expect(result.reviewRepairAttempted).toBe(false);
    expect(refineEvidence).toHaveBeenCalledTimes(3);
    expect(accepted).toHaveBeenCalledTimes(8);
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored(), forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(8);
  });

  it.each(["provider_failure", "empty_publication"] as const)("retains a successful revision after a later %s", async failure => {
    const beta = { version: 1, blocks: [{ kind: "paragraph", text: "Alpha and Beta total 10 kg.", evidenceHandles: ["K1", "K2"] }] };
    const needsGamma = { ...review(), missingInformation: ["The mass of Gamma."], followUps: [{ query: "Gamma mass", sourceAliases: [] }],
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1", "K2"] }] };
    const fixture = execution([compose(), review(), beta, needsGamma, ...(failure === "provider_failure"
      ? [new TypeError("fetch failed")]
      : [{ version: 1, blocks: [] }, { ...needsGamma, blocks: [], coverage: "none" }])]);
    let count = 0;
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, workflowVersion: 10,
      request: "Calculate the combined mass of Alpha, Beta and Gamma.", refineEvidence: async () => manifest(true, count++) });
    expect(result.publication.blocks).toMatchObject([{ text: "Alpha and Beta total 10 kg." }]);
    expect(result.evidenceReceiptHash).toBe(manifest(true).manifestHash);
    expect(result.operations).toHaveLength(failure === "provider_failure" ? 5 : 6);
    expect(count).toBe(2);
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored(), forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(result.operations.length);
  });

  it.each([undefined, 10] as const)("retrieves a missing operand once, binds both accepted parents and replays without I/O (%s)", async workflowVersion => {
    const fixture = execution([compose(), review(),
      { version: 1, blocks: [{ kind: "paragraph", text: "The combined mass is 10 kg (4 + 6).", evidenceHandles: ["K1", "K2"] }] },
      { ...review(), coverage: "complete", missingInformation: [], followUps: [],
        blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1", "K2"] }] }]);
    const refineEvidence = vi.fn(async () => manifest(true));
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, workflowVersion, refineEvidence });
    expect(result.publication.coverage).toBe("complete");
    expect(result.refinementAttempted).toBe(true);
    expect(result.operations).toHaveLength(4);
    expect(result.compositionRepairAttempted).toBe(false);
    expect(result.reviewRepairAttempted).toBe(false);
    expect(refineEvidence).toHaveBeenCalledTimes(1);
    const stored = fixture.store.stored();
    expect(stored[2]!.attempt.acceptedRequest).toMatchObject({ workflowVersion: workflowVersion ?? 9,
      draftPayloadHash: knowledgeAnswerHash(stored[0]!.attempt.acceptedResult), reviewPayloadHash: knowledgeAnswerHash(stored[1]!.attempt.acceptedResult) });
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: stored, forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(4);
  });

  it.each([undefined, 10] as const)("does not compose again when searches add no delivered evidence (%s)", async workflowVersion => {
    const fixture = execution([compose(), review()]);
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, workflowVersion, refineEvidence: async () => manifest() });
    expect(result.refinementAttempted).toBe(false);
    expect(result.operations).toHaveLength(2);
    expect(knowledgeEvidenceRefinementAddsEvidence(manifest(true), manifest(), result)).toBe(false);
  });

  it("does not treat a second receipt for the same source passage as new evidence", async () => {
    const fixture = execution([compose(), review()]);
    const previous = manifest();
    const next = packKnowledgeEvidenceDispatchManifest({ candidates: previous.items.map(item => ({ ...item,
      evidenceId: "another-call:same-passage", handle: "K2", state: "available" as const, operationOrdinal: 2 })),
      coverageStatement: previous.coverageStatement, header: previous.header, footer: previous.footer,
      maximumBytes: 32_000, maximumTokens: 8_000, profileId: previous.profileId, promptFragmentVersion: 1, runtimeVersion: 1 });
    const result = await executeKnowledgeEvidenceAnswerV1(fixture.input);
    expect(knowledgeEvidenceRefinementAddsEvidence(previous, next, { publication: { ...result.publication, blocks: [] } })).toBe(false);
  });

  it("preserves the first verified partial answer after a settled optional provider failure and includes its charge", async () => {
    const fixture = execution([compose(), review(), new TypeError("fetch failed")]);
    const accepted = vi.fn();
    const result = await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, onOperationAccepted: accepted, refineEvidence: async () => manifest(true) });
    expect(result.publication.blocks).toMatchObject([{ text: "Alpha has a mass of 4 kg." }]);
    expect(result.operations).toHaveLength(3);
    expect(accepted).toHaveBeenCalledTimes(3);
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored(), forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
  });

  it("reports already settled charges even when initial review exhausts structural repairs", async () => {
    const fixture = execution([compose(), {}, {}]);
    const accepted = vi.fn();
    await expect(executeKnowledgeEvidenceAnswerV1({ ...fixture.input, onOperationAccepted: accepted })).rejects.toMatchObject({ code: "knowledge_answer_contract_failed" });
    expect(accepted).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, 10] as const)("does not convert lost authority during optional retrieval into success (%s)", async workflowVersion => {
    const fixture = execution([compose(), review()]);
    await expect(executeKnowledgeEvidenceAnswerWithRefinementV1({ ...fixture.input, workflowVersion,
      refineEvidence: async () => { throw Error("knowledge_authority_lost"); } })).rejects.toThrow("knowledge_authority_lost");
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it("publishes reviewed partial evidence in two operations and replays without provider I/O", async () => {
    const fixture = execution([compose(), review()]);
    const result = await executeKnowledgeEvidenceAnswerV1(fixture.input);
    expect(result.publication).toMatchObject({ coverage: "partial", blocks: [{ text: "Alpha has a mass of 4 kg." }] });
    expect(result.review.followUps).toEqual([{ query: "Beta mass", sourceAliases: [] }]);
    expect(result.operations.map(operation => operation.operation)).toEqual(["knowledge_evidence_compose_v1", "knowledge_evidence_review_v1"]);
    const replay = await replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored(), forbiddenIdentityFragments: fixture.input.forbiddenIdentityFragments, modelRunId: "fixture-run" });
    expect(replay).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.input.authorize).toHaveBeenCalledTimes(2);
  });

  it("uses one fresh structural repair per operation, preserving every charge and replay input", async () => {
    const fixture = execution([{ version: 1, blocks: [{ kind: "paragraph", text: "[K99] invalid", evidenceHandles: ["K99"] }] }, compose(),
      { ...review(), blocks: [] }, review()]);
    const result = await executeKnowledgeEvidenceAnswerV1(fixture.input);
    expect(result.operations).toHaveLength(4);
    expect(fixture.execute).toHaveBeenCalledTimes(4);
    const stored = fixture.store.stored();
    expect(stored[0]?.attempt.acceptedResult).toEqual({ version: 1, kind: "rejected", reason: "text_invalid" });
    expect(stored[2]?.attempt.acceptedResult).toEqual({ version: 1, kind: "rejected", reason: "capacity_exceeded" });
    expect(JSON.stringify(stored)).not.toContain("K99");
    expect(stored[0]?.attempt.requestHash).not.toBe(stored[1]?.attempt.requestHash);
    expect(await replayKnowledgeEvidenceAnswerV1({ dispatches: stored, forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).toEqual(result);
    expect(fixture.execute).toHaveBeenCalledTimes(4);
  });

  it("does not repeat a paid transport failure", async () => {
    const fixture = execution([new TypeError("fetch failed")]);
    await expect(executeKnowledgeEvidenceAnswerV1(fixture.input)).rejects.toMatchObject({ code: "knowledge_answer_contract_failed" });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.store.stored()[0]?.attempt.acceptedResult).toEqual({ version: 1, kind: "failed", reason: "transport" });
  });

  it("rejects a second invalid review instead of publishing an unchecked draft", async () => {
    const fixture = execution([compose(), { ...review(), blocks: [] }, { ...review(), blocks: [] }]);
    await expect(executeKnowledgeEvidenceAnswerV1(fixture.input)).rejects.toMatchObject({ code: "knowledge_answer_contract_failed" });
    expect(fixture.execute).toHaveBeenCalledTimes(3);
  });

  it("keeps cancellation and authority loss terminal before another provider call", async () => {
    const denied = execution([compose()]);
    denied.input.authorize.mockRejectedValueOnce(Error("authority_lost"));
    await expect(executeKnowledgeEvidenceAnswerV1(denied.input)).rejects.toThrow("authority_lost");
    expect(denied.execute).not.toHaveBeenCalled();
    expect(denied.store.lifecycle.release).toHaveBeenCalledOnce();
    const cancelled = execution([new DOMException("cancelled", "AbortError")]);
    await expect(executeKnowledgeEvidenceAnswerV1({ ...cancelled.input, shouldAbort: () => true })).rejects.toThrow("cancelled");
    expect(cancelled.store.lifecycle.markAmbiguous).toHaveBeenCalledOnce();
    expect(cancelled.store.lifecycle.settle).not.toHaveBeenCalled();
  });

  it("rejects an altered accepted result, prompt or evidence binding on replay", async () => {
    const fixture = execution([compose(), review()]);
    await executeKnowledgeEvidenceAnswerV1(fixture.input);
    for (const mutate of [
      (dispatches: StoredKnowledgeEvidenceDispatch[]) => Object.assign(dispatches[1]!.attempt, { resultHash: "0".repeat(64) }),
      (dispatches: StoredKnowledgeEvidenceDispatch[]) => Object.assign(dispatches[1]!.attempt, { evidenceReceiptHash: "0".repeat(64) }),
      (dispatches: StoredKnowledgeEvidenceDispatch[]) => Object.assign(dispatches[1]!.attempt.acceptedRequest!, { reasoningEffort: "high" })
    ]) {
      const stored = fixture.store.stored(); mutate(stored);
      await expect(replayKnowledgeEvidenceAnswerV1({ dispatches: stored, forbiddenIdentityFragments: [], modelRunId: "fixture-run" })).rejects.toThrow("knowledge_evidence_answer_replay_invalid");
    }
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it("cannot recover a missing operation by generating a new answer during finalization", async () => {
    const fixture = execution([compose(), review()]);
    await executeKnowledgeEvidenceAnswerV1(fixture.input);
    await expect(replayKnowledgeEvidenceAnswerV1({ dispatches: fixture.store.stored().slice(0, 1), forbiddenIdentityFragments: [], modelRunId: "fixture-run" }))
      .rejects.toThrow("knowledge_evidence_answer_replay_invalid");
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });
});
