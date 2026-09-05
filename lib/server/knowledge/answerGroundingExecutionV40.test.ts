import { describe, expect, it, vi } from "vitest";
import { packKnowledgeEvidenceDispatchManifest, type KnowledgeEvidencePackingVersion } from "./evidenceDispatchManifest";
import { executeKnowledgeAnswerGroundingV21 } from "./answerGroundingExecutionV21ScopeV6";
import { replayKnowledgeAnswerGroundingV40 } from "./answerGroundingReplayV40";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import { decodeKnowledgeAnswerOperationRequestSnapshotV21 } from "./answerGroundingV21";
import type { StoredKnowledgeEvidenceDispatch } from "./evidenceDispatchRepository";
import type { KnowledgeProviderDispatchLifecycle, PreparedKnowledgeProviderDispatch } from "./providerDispatchLifecycle";
import { knowledgeCoverageRequestAnchorIndexV1 } from "./coverageScopeRequestAnchorIdsV1";
import { knowledgeCoverageRequestAnchorIndexV2 } from "./coverageScopeRequestAnchorIdsV2";
import type { KnowledgeCoverageLimitationsV1 } from "./searchFailure";

const usage = { cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 };
const request = "Explain alpha and beta.";
const primaryTexts = ["Alpha measured 42 on June 1.", "Beta measured 35 on June 2."];
function manifest(texts = primaryTexts, packingVersion?: KnowledgeEvidencePackingVersion, coverageLimitations?: KnowledgeCoverageLimitationsV1) {
  return packKnowledgeEvidenceDispatchManifest({
    candidates: texts.map((text, index) => ({
      ambiguity: "none" as const, evidenceId: `synthetic-evidence-${index + 1}`, exactExcerpt: text,
      fileName: `source-${index + 1}.txt`, handle: `K${index + 1}`, locator: "page=1",
      operationOrdinal: 1, resultOrdinal: index + 1, sourceAlias: `S${index + 1}`,
      sourceLabel: index === 0 ? "Alpha" : "Beta", sourceTruncated: false,
      sourceVersionNumber: 1, state: "available" as const
    })),
    ...(packingVersion ? { packingVersion } : {}),
    ...(coverageLimitations ? { coverageLimitations } : {}),
    coverageStatement: "Coverage is limited to the supplied SOURCE blocks.",
    footer: "</private_knowledge_evidence>", header: '<private_knowledge_evidence version="4">',
    maximumBytes: 32_000, maximumTokens: 8_000, profileId: "fake:answer", promptFragmentVersion: 1, runtimeVersion: 1
  });
}
function scopeOutput() {
  return { evidenceUnits: ["alpha", "beta"].map((anchor, index) => ({
    findings: [{ description: `Explain ${anchor}.`, evidenceAtomIds: [`A${index + 1}`], requestAnchor: anchor }],
    handle: `K${index + 1}`
  })), jointFindings: [], unsupportedDimensions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 7 };
}
function draftOutput(count = 2, texts = primaryTexts) {
  return { claims: Array.from({ length: count }, (_, index) => ({
    citationHints: [index === 1 ? "K2" : "K1"], text: texts[index] ?? `Unused candidate ${index + 1}.`
  })), version: 1 };
}
function selectorOutput(count = 2, states: readonly ("covered" | "missing")[] = ["missing", "missing"], ids: readonly string[][] = [["C1"], []]) {
  return { claims: Array.from({ length: count }, (_, index) => ({ id: `C${index + 1}`,
    supportHandles: index < 2 ? [`K${index + 1}`] : [], verdict: index < 2 ? "supported" : "unsupported" })),
  coverage: states.map((status, index) => ({ id: `D${index + 1}`, contributionIds: ids[index], status })),
  insufficientReason: ids.some((contributions) => contributions.length > 0) ? "not_applicable" : "not_found", version: 2 };
}
function deltaOutput(states: readonly ("covered" | "missing")[] = ["missing", "covered"]) {
  return { claims: [], targets: Object.fromEntries(states.map((status, index) => [
    `D${index + 1}`, { addContributionIds: [`C${index + 1}`], status }
  ])), version: 2 };
}

/** Stores JSON-compatible accepted requests/results separately from executor
 * locals, including operation identity, hashes, usage and terminal timestamps. */
function recorder() {
  const entries = new Map<number, StoredKnowledgeEvidenceDispatch>();
  const unavailable = async (): Promise<never> => { throw new Error("unexpected_lifecycle_action"); };
  const lifecycle: KnowledgeProviderDispatchLifecycle = {
    inspect: vi.fn(async ({ ordinal }) => entries.get(ordinal) ?? null),
    prepare: vi.fn(async (input) => {
      const dispatch = { draft: input.draft, retrievalSessionId: "synthetic-session", manifestId: `manifest-${input.ordinal}`,
        attempt: { id: `attempt-${input.ordinal}`, modelRunId: input.modelRunId, ordinal: input.ordinal,
          purpose: input.purpose, providerBindingKey: "answer", contractVersion: input.contractVersion,
          evidenceReceiptHash: input.evidenceReceiptHash, acceptedRequest: JSON.parse(JSON.stringify(input.acceptedRequest)) as unknown,
          acceptedResult: null, actualUsage: null, resultHash: null, requestHash: knowledgeAnswerHash(input.acceptedRequest),
          dispatchedAt: null, settledAt: null, resultAcceptedAt: null, providerResponseId: null, state: "reserved" }
      } as StoredKnowledgeEvidenceDispatch;
      entries.set(input.ordinal, dispatch);
      return { dispatch } as PreparedKnowledgeProviderDispatch;
    }),
    dispatch: vi.fn(async ({ dispatch }) => {
      const entry = entries.get(dispatch.attempt.ordinal)!;
      entries.set(dispatch.attempt.ordinal, { ...entry,
        attempt: { ...entry.attempt, dispatchedAt: new Date("2026-09-05T00:00:00Z"), state: "dispatched" } });
    }),
    settle: vi.fn(async ({ dispatch }, input) => {
      const entry = entries.get(dispatch.attempt.ordinal)!;
      const acceptedResult = JSON.parse(JSON.stringify(input.acceptedResult)) as Readonly<Record<string, unknown>>;
      entries.set(dispatch.attempt.ordinal, { ...entry, attempt: { ...entry.attempt,
        acceptedResult, actualUsage: { ...input.usage, estimatedCostMicros: null }, resultHash: knowledgeAnswerHash(acceptedResult),
        providerResponseId: input.providerResponseId ?? null, settledAt: new Date("2026-09-05T00:00:01Z"),
        resultAcceptedAt: new Date("2026-09-05T00:00:01Z"), state: "settled" } });
    }),
    markAmbiguous: unavailable, recover: unavailable, release: unavailable
  };
  const stored = () => JSON.parse(JSON.stringify([...entries.values()]), (key, value: unknown) =>
    ["dispatchedAt", "settledAt", "resultAcceptedAt"].includes(key) && typeof value === "string" ? new Date(value) : value
  ) as StoredKnowledgeEvidenceDispatch[];
  return { entries, lifecycle, stored };
}
async function run(outputs: readonly unknown[], options: { request?: string; texts?: string[]; coverageLimitations?: KnowledgeCoverageLimitationsV1; workflowVersion?: 2 | 3 | 4 | 5 | 6 | 7 } = {}) {
  const store = recorder();
  let cursor = 0;
  const execute = vi.fn(async () => {
    if (cursor >= outputs.length) throw new Error("unexpected_extra_provider_call");
    const output = outputs[cursor++];
    if (output instanceof Error) throw output;
    return { output: output as Readonly<Record<string, unknown>>, usage, providerResponseId: `response-${cursor}` };
  });
  const result = await executeKnowledgeAnswerGroundingV21({
    authorize: async () => undefined, draft: manifest(options.texts, undefined, options.coverageLimitations), execute,
    lifecycle: store.lifecycle, modelRunId: "synthetic-run", request: options.request ?? request,
    ...(options.workflowVersion !== undefined ? { workflowVersion: options.workflowVersion } : {}),
    routeInstruction: "Answer only from supplied Knowledge evidence.", shouldAbort: () => false, transport: "native_strict"
  });
  expect(execute).toHaveBeenCalledTimes(outputs.length);
  const replayed = await replayKnowledgeAnswerGroundingV40({ dispatches: store.stored(),
    forbiddenIdentityFragments: [], modelRunId: "synthetic-run" });
  expect(replayed).toEqual(result);
  expect(execute).toHaveBeenCalledTimes(outputs.length);
  return { execute, result, store };
}
const start = (count = 2, texts = primaryTexts) => [draftOutput(count, texts), scopeOutput(), { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 }];

describe("V40 contribution execution and durable replay", () => {
  it("preserves exact literal claim spelling and inert rendering through workflow 7 replay", async () => {
    const texts = ["__entry__", "A<Box> stores $token$ and ~~state~~."];
    const { result, store } = await run([...start(2, texts),
      selectorOutput(2, ["covered", "covered"], [["C1"], ["C2"]]),
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "closed" }], version: 3 }
    ], { texts, workflowVersion: 7 });
    expect(result.settlement).toMatchObject({ requestCoverage: "complete", supportedClaimCount: 2 });
    expect(result.settlement.finalText).toContain("\\_\\_entry\\_\\_ [K1]");
    expect(result.settlement.finalText).toContain("A&lt;Box&gt; stores \\$token\\$ and \\~\\~state\\~\\~. [K2]");
    expect(store.stored()[0]!.attempt.acceptedResult).toEqual(draftOutput(2, texts));
  });

  it("retains literal text through target-local supplement validation, merging and replay", async () => {
    const texts = ["Alpha measured 42 on June 1 and uses __entry__.", "Beta measured 35 on June 2 and uses <Box>."];
    const { result } = await run([...start(), selectorOutput(),
      { targets: { D1: ["Alpha uses __entry__."], D2: ["Beta uses <Box>."] }, version: 3 },
      { claims: [{ id: "C3", supportHandles: ["K1"], verdict: "supported" },
        { id: "C4", supportHandles: ["K2"], verdict: "supported" }],
      targets: { D1: { addContributionIds: ["C3"], status: "covered" },
        D2: { addContributionIds: ["C2", "C4"], status: "covered" } }, version: 2 }
    ], { texts, workflowVersion: 7 });
    expect(result.operations).toHaveLength(6);
    expect(result.contributionReceipt?.correctionAccepted).toBe(true);
    expect(result.settlement).toMatchObject({ requestCoverage: "complete", supportedClaimCount: 4 });
    expect(result.settlement.finalText).toContain("Alpha uses \\_\\_entry\\_\\_. [K1]");
    expect(result.settlement.finalText).toContain("Beta uses &lt;Box&gt;. [K2]");
  });

  it.each([
    { request: "Compare readings on day Alpha and day Beta.", texts: ["The reading on day Alpha is 18 units."] },
    { request: "Calculate the combined mass of crates Alpha, Beta and Gamma.",
      texts: ["Crate Alpha mass is 4 kg.", "Crate Beta mass is 5 kg."] }
  ])("publishes known operands without inventing the incomplete result: $request", async ({ request, texts }) => {
    const finding = { description: request, requestAnchor: "Q1", evidenceAtomIds: texts.map((_, index) => `A${index + 1}`) };
    const scope = { version: 7, overflow: { pending: [], unparsedRemainder: false, version: 1 },
      evidenceUnits: texts.map((_, index) => ({ handle: `K${index + 1}`,
        findings: texts.length === 1 ? [finding] : [] })),
      jointFindings: texts.length > 1 ? [finding] : [], unsupportedDimensions: [] };
    const selection = { ...selectorOutput(texts.length), coverage: [{ id: "D1", status: "missing",
      contributionIds: texts.map((_, index) => `C${index + 1}`) }] };
    const { result } = await run([draftOutput(texts.length, texts), scope,
      { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 },
      selection, { targets: { D1: [] }, version: 3 },
      { claims: [], targets: { D1: { addContributionIds: [], status: "missing" } }, version: 2 }
    ], { request, texts, workflowVersion: 7 });
    expect(result.operations).toHaveLength(6);
    expect(result.settlement).toMatchObject({ requestCoverage: "partial", supportedClaimCount: texts.length, outcome: "answered" });
    for (const text of texts) expect(result.settlement.finalText).toContain(text);
    expect(result.settlement.finalText).toContain(request);
    expect(result.contributionReceipt?.coverage).toMatchObject({ coveredDimensionCount: 0, missingDimensionCount: 1 });
    expect(result.contributionReceipt?.closure).toBeNull();
  });

  it("publishes and replays separate evidence bindings with the same Scope description", async () => {
    const scope = scopeOutput();
    scope.evidenceUnits.forEach((unit) => { unit.findings[0]!.description = "Report the reading."; });
    const { result } = await run([draftOutput(), scope,
      { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 },
      selectorOutput(2, ["covered", "covered"], [["C1"], ["C2"]]),
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "closed" }], version: 3 }
    ], { workflowVersion: 6 });
    expect(result.settlement).toMatchObject({ requestCoverage: "complete", supportedClaimCount: 2 });
    expect(result.settlement.finalText).toContain(`- Report the reading: ${primaryTexts[0]} [K1]`);
    expect(result.settlement.finalText).toContain(`- Report the reading: ${primaryTexts[1]} [K2]`);
  });

  it.each([3, 4, 5, 6, 7] as const)("repairs a malformed Draft within eight operations under workflow %s", async (workflowVersion) => {
    const selection = selectorOutput(2, ["covered", "covered"], [["C1"], ["C2"]]);
    const malformedSelection = { ...selection, coverage: [{ ...selection.coverage[0]!, id: "D99" }, selection.coverage[1]!] };
    const reason = workflowVersion === 7 ? "draft_claim_citation_invalid" : "draft_claim_backtick_invalid";
    const malformedText = workflowVersion === 7 ? "Alpha [K1] measured 42." : "`Alpha` measured 42.";
    const malformedDraft = { claims: [{ citationHints: ["K1"], text: malformedText }], version: 1 };
    const { result, store } = await run([malformedDraft, draftOutput(), {}, scopeOutput(),
      { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 },
      malformedSelection, selection,
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "closed" }], version: 3 }
    ], { workflowVersion });
    expect(result.operations).toHaveLength(8);
    expect(result.settlement).toMatchObject({ supportedClaimCount: 2, requestCoverage: "complete" });
    const stored = store.stored();
    expect(stored[0]!.attempt.acceptedResult).toEqual({ kind: "draft_malformed", reason });
    expect(stored[1]!.attempt.purpose).toBe("knowledge_answer_draft_v21");
    const initial = JSON.parse(stored[0]!.attempt.acceptedRequest!.userPrompt);
    const repair = JSON.parse(stored[1]!.attempt.acceptedRequest!.userPrompt);
    expect(repair).toEqual({ ...initial, draftRepairReason: reason });
    if (workflowVersion !== 7) expect(stored[1]!.attempt.acceptedRequest!.systemPrompt).toContain("including inline code wrappers");
    expect(JSON.stringify(stored)).not.toContain(malformedText);
    expect(stored.every(({ attempt }) => attempt.acceptedRequest?.version === 40 && attempt.acceptedRequest.workflowVersion === workflowVersion)).toBe(true);
  });

  it("stops after one failed Draft repair before spending Scope or Selector calls", async () => {
    const store = recorder();
    const execute = vi.fn(async () => ({ output: {}, usage, providerResponseId: "synthetic-response" }));
    await expect(executeKnowledgeAnswerGroundingV21({ authorize: async () => undefined,
      draft: manifest(), execute, lifecycle: store.lifecycle, modelRunId: "synthetic-run", request,
      routeInstruction: "Answer only from supplied Knowledge evidence.", shouldAbort: () => false,
      transport: "native_strict", workflowVersion: 3
    })).rejects.toMatchObject({ code: "knowledge_answer_contract_failed" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.stored().map(({ attempt }) => attempt.purpose)).toEqual([
      "knowledge_answer_draft_v21", "knowledge_answer_draft_v21"
    ]);
  });

  it.each([2, 3, 4, 5, 6, 7] as const)("freezes anchors, task labels and instructions through workflow %s replay", async (workflowVersion) => {
    const request = Array.from({ length: 12 }, (_, index) => `Explain item${index + 1} with its exact dated reading.`).join("\n");
    const anchors = knowledgeCoverageRequestAnchorIndexV2(request);
    const scope = scopeOutput();
    scope.evidenceUnits.forEach((unit, index) => { unit.findings[0]!.requestAnchor = anchors.items[index]!.id; });
    const { result, store } = await run([draftOutput(), scope,
      { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 },
      selectorOutput(2, ["covered", "covered"], [["C1"], ["C2"]]),
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "closed" }], version: 3 }
    ], { request, workflowVersion });
    expect(result.settlement.finalText).toContain(`- Explain alpha: ${primaryTexts[0]}`);
    expect(result.settlement.finalText).not.toContain(anchors.items[0]!.text);
    const stored = store.stored();
    for (const dispatch of stored) expect(dispatch.attempt.acceptedRequest).toMatchObject({ workflowVersion });
    expect(JSON.parse(stored[1]!.attempt.acceptedRequest!.userPrompt).requestAnchorIndex).toEqual(anchors);
    expect(stored[1]!.attempt.acceptedRequest!.systemPrompt.includes("The primary requested outcome belongs in active Scope"))
      .toBe(workflowVersion === 4 || workflowVersion === 5 || workflowVersion === 6 || workflowVersion === 7);
    expect(stored[3]!.attempt.acceptedRequest!.systemPrompt.includes("Equivalent text elsewhere is not transferable provenance"))
      .toBe(workflowVersion === 4 || workflowVersion === 5 || workflowVersion === 6 || workflowVersion === 7);
    expect(Object.hasOwn(JSON.parse(stored[3]!.attempt.acceptedRequest!.userPrompt), "contributionSourceIndex"))
      .toBe(workflowVersion === 5 || workflowVersion === 6 || workflowVersion === 7);
    expect(stored[1]!.attempt.acceptedRequest!.systemPrompt.includes("Scope descriptions must be unique"))
      .toBe(workflowVersion !== 6 && workflowVersion !== 7);
    expect(stored[2]!.attempt.acceptedRequest!.systemPrompt.includes("Descriptions must be unique across acceptedScope and additions"))
      .toBe(workflowVersion !== 6 && workflowVersion !== 7);
    expect(stored[1]!.attempt.acceptedRequest!.systemPrompt.includes("Descriptions are human-readable task labels, not identities"))
      .toBe(workflowVersion === 6 || workflowVersion === 7);
    const tampered = store.stored();
    const acceptedRequest = { ...tampered[0]!.attempt.acceptedRequest, workflowVersion: 8 };
    tampered[0] = { ...tampered[0]!, attempt: { ...tampered[0]!.attempt,
      acceptedRequest: acceptedRequest as never, requestHash: knowledgeAnswerHash(acceptedRequest) } };
    await expect(replayKnowledgeAnswerGroundingV40({ dispatches: tampered,
      forbiddenIdentityFragments: [], modelRunId: "synthetic-run" })).rejects.toThrow("knowledge_answer_replay_invalid");
  });

  it.each([
    { stage: "scope", outputs: [draftOutput(), {}, {}] },
    { stage: "selector after malformed Draft", outputs: [{}, scopeOutput(), { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 }, {}] }
  ])("classifies unaccepted $stage as a Knowledge contract failure", async ({ outputs }) => {
    await expect(run(outputs)).rejects.toMatchObject({ code: "knowledge_answer_contract_failed" });
  });

  it("repairs selection with the exact validation reason and replays the accepted feedback", async () => {
    const selection = selectorOutput(2, ["covered", "covered"], [["C1"], ["C2"]]);
    const malformed = { ...selection, coverage: [{ ...selection.coverage[0]!, id: "D99" }, selection.coverage[1]!] };
    const { result, store } = await run([...start(), malformed, selection,
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "closed" }], version: 3 }]);
    expect(result.operations).toHaveLength(6);
    expect(result.settlement).toMatchObject({ finalizationMode: "selected_claims", requestCoverage: "complete", supportedClaimCount: 2 });
    expect(result.settlement.finalText).toContain(primaryTexts[0]);
    expect(result.settlement.finalText).toContain(primaryTexts[1]);
    expect(store.stored()[3]!.attempt.acceptedResult).toEqual({ kind: "contribution_operation_failed",
      reason: "invalid_output", validationReason: "selector_dimension_id_invalid", version: 1 });
    expect(JSON.parse(store.stored()[4]!.attempt.acceptedRequest!.userPrompt)).toMatchObject({
      repairReason: "selector_dimension_id_invalid", selectorPass: "repair"
    });
    expect(store.stored()[4]!.attempt.acceptedRequest!.systemPrompt)
      .toContain("Do not invent, reorder, omit or repeat a D ID");
  });

  it.each([
    { excludedResources: 1, retrievalFailures: [], version: 1 },
    { excludedResources: 0, retrievalFailures: ["opensearch_timeout"], version: 1 }
  ] satisfies KnowledgeCoverageLimitationsV1[])("preserves accepted scope/search limitations through closed coverage and replay: %j", async (coverageLimitations) => {
    const { result } = await run([...start(), selectorOutput(2, ["covered", "covered"], [["C1"], ["C2"]]),
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "closed" }], version: 3 }
    ], { coverageLimitations });
    expect(result.settlement).toMatchObject({ supportedClaimCount: 2, requestCoverage: "partial" });
    expect(result.contributionReceipt?.coverageLimitations).toEqual(coverageLimitations);
    expect(result.contributionReceipt?.coverage.missingDimensionCount).toBe(0);
    expect(result.settlement.finalText).toContain(coverageLimitations.excludedResources > 0 ? "cannot establish absence" : "timed out");
    expect(result.operations).toHaveLength(5);
  });

  it.each(["scope", "completeness", "saturated", "repaired"] as const)(
    "preserves pending requirements through publication and durable replay after %s decomposition", async (stage) => {
      const count = stage === "saturated" ? 17 : 9;
      const names = Array.from({ length: count }, (_, index) => `item${index + 1}`);
      const request = `Report ${names.join(", ")}.`;
      const anchors = knowledgeCoverageRequestAnchorIndexV1(request);
      const task = (index: number) => ({ description: `Report ${names[index]}'s value.`,
        requestAnchor: anchors.items.find(({ text }) => text === names[index])!.id });
      const pending = (start: number, end: number) => names.slice(start, end).map((_, index) => task(start + index));
      const empty = { pending: [], unparsedRemainder: false, version: 1 };
      const scope = { evidenceUnits: [{ handle: "K1", findings: names.slice(0, 8).map((_, index) => ({
        ...task(index), evidenceAtomIds: [`A${index + 1}`]
      })) }], jointFindings: [], unsupportedDimensions: [], version: 7,
      overflow: stage === "completeness" ? empty : { ...empty, pending: pending(8, stage === "saturated" ? 16 : 9) } };
      const completeness = { additions: [], version: 2, overflow: { ...empty,
        pending: stage === "completeness" ? pending(8, 9) : stage === "saturated" ? pending(16, 17) : [] } };
      const selector = { claims: names.slice(0, 8).map((_, index) => ({ id: `C${index + 1}`, supportHandles: ["K1"], verdict: "supported" })),
        coverage: names.slice(0, 8).map((_, index) => ({ id: `D${index + 1}`, status: "covered", contributionIds: [`C${index + 1}`] })),
        insufficientReason: "not_applicable", version: 2 };
      const { result, store } = await run([
        { claims: names.slice(0, 8).map((name, index) => ({ citationHints: ["K1"], text: `${name} has value ${index + 1} kg.` })), version: 1 },
        ...(stage === "repaired" ? [{}] : []), scope,
        ...(stage === "repaired" ? [{}] : []), completeness,
        ...(stage === "repaired" ? [{}] : []), selector,
        { decisions: names.slice(0, 8).map((_, index) => ({ id: `D${index + 1}`, status: "closed" })), version: 3 }
      ], { request, texts: [names.map((name, index) => `${name}\t${index + 1} kg`).join("\n")] });
      expect(result.operations).toHaveLength(stage === "repaired" ? 8 : 5);
      expect(result.settlement).toMatchObject({ requestCoverage: "partial", supportedClaimCount: 8, outcome: "answered" });
      expect(result.settlement.finalText).toContain("Unprocessed requirement: Report item9");
      expect(result.settlement.finalText.includes("could not be fully analyzed")).toBe(stage === "saturated");
      expect(result.contributionReceipt).toMatchObject({ coverage: { coveredDimensionCount: 8, missingDimensionCount: 0 },
        coverageScope: { dimensionCount: 8, pendingRequirementCount: stage === "saturated" ? 8 : 1,
          requestAnalysisIncomplete: stage === "saturated" } });
      // Even a self-consistently rehashed Scope edit cannot erase a previously
      // accepted pending task: downstream immutable request hashes bind it.
      if (stage === "scope") {
        const tampered = store.stored();
        const acceptedResult = { ...tampered[1]!.attempt.acceptedResult, overflow: empty };
        tampered[1] = { ...tampered[1]!, attempt: { ...tampered[1]!.attempt,
          acceptedResult, resultHash: knowledgeAnswerHash(acceptedResult) } };
        await expect(replayKnowledgeAnswerGroundingV40({ dispatches: tampered,
          forbiddenIdentityFragments: [], modelRunId: "synthetic-run" })).rejects.toThrow();
      }
    }
  );

  it("rejects a legacy oversized atom projection before Draft or lifecycle I/O", async () => {
    const store = recorder();
    const execute = vi.fn(async () => { throw new Error("unexpected_provider_call"); });
    const authorize = vi.fn(async () => undefined);
    const draft = manifest([Array.from({ length: 1_025 }, () => "A\tX\t10").join("\n")], "whole_source_item_v1");
    expect(draft.items).toHaveLength(1);
    await expect(executeKnowledgeAnswerGroundingV21({ authorize, draft, execute, lifecycle: store.lifecycle,
      modelRunId: "synthetic-run", request, routeInstruction: "Use supplied Knowledge.",
      shouldAbort: () => false, transport: "native_strict"
    })).rejects.toThrow("knowledge_coverage_atom_limit_exceeded");
    expect(execute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(store.stored()).toEqual([]);
  });

  it("publishes equal-valued table rows with their own occurrences and replays the same projection", async () => {
    const texts = ["A\tX\t10\nB\tX\t10", "Issued 2041-02-03."];
    const { result, store } = await run([
      { claims: [{ citationHints: ["K1"], text: "A has value 10." }, { citationHints: ["K1"], text: "B has value 10." }], version: 1 },
      { evidenceUnits: [{ handle: "K1", findings: [
        { description: "State A's value.", evidenceAtomIds: ["A1"], requestAnchor: "A" },
        { description: "State B's value.", evidenceAtomIds: ["A2"], requestAnchor: "B" }
      ] }, { handle: "K2", findings: [] }], jointFindings: [], unsupportedDimensions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 7 },
      { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 },
      { claims: ["C1", "C2"].map((id) => ({ id, supportHandles: ["K1"], verdict: "supported" })),
        coverage: ["D1", "D2"].map((id, index) => ({ id, contributionIds: [`C${index + 1}`], status: "covered" })),
        insufficientReason: "not_applicable", version: 2 },
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "closed" }], version: 3 }
    ], { texts, request: "State A and B values." });
    expect(result.settlement).toMatchObject({ supportedClaimCount: 2, requestCoverage: "complete" });
    expect(result.settlement.finalText).toContain("A has value 10.");
    expect(result.settlement.finalText).toContain("B has value 10.");
    expect(result.settlement.finalText).not.toContain("2041-02-03");
    const scope = store.stored()[1]!.attempt.acceptedRequest as { userPrompt: string; pipeline: string };
    expect(scope.pipeline).toContain("occurrence_atoms_v3");
    expect(JSON.parse(scope.userPrompt)).toMatchObject({ atomProjection: "source_ordered_occurrences_v3",
      evidenceUnitIndex: { version: 3, units: [{ handle: "K1", atoms: [
        expect.objectContaining({ text: "A\tX\t10", occurrence: expect.objectContaining({ unitId: "U1" }) }),
        expect.objectContaining({ text: "B\tX\t10", occurrence: expect.objectContaining({ unitId: "U2" }) })
      ] }, expect.anything()] } });
  });

  it("repairs zero mapping with a full 24-claim Draft and no supplement call", async () => {
    const { result, store } = await run([...start(24), selectorOutput(24, ["missing", "missing"], [[], []]), deltaOutput()]);
    expect(result.operations.map(({ operation }) => operation)).toEqual([
      "knowledge_answer_draft_v21", "knowledge_coverage_scope_v7", "knowledge_coverage_scope_completeness_v2",
      "knowledge_grounded_selector_v22", "knowledge_grounded_selector_final_v22"
    ]);
    expect(result.settlement).toMatchObject({ requestCoverage: "partial", supportedClaimCount: 2, outcome: "answered" });
    expect(result.settlement.finalText).toContain("[K1]");
    expect(result.settlement.finalText).toContain("[K2]");
    expect(result.settlement.finalText).not.toContain("Unused candidate");
    expect(store.stored().every((entry) => decodeKnowledgeAnswerOperationRequestSnapshotV21(entry.attempt.acceptedRequest)?.version === 40)).toBe(true);
  });

  it.each([
    { name: "empty", output: { targets: { D1: [], D2: [] }, version: 3 } },
    { name: "duplicate-only", output: { targets: { D1: [primaryTexts[0]], D2: [primaryTexts[1]] }, version: 3 } },
    { name: "malformed", output: { targets: { D1: [null], D2: [] }, version: 3 } },
    { name: "timeout", output: new Error("timeout") }
  ])("continues mapping from the accepted base after $name supplement", async ({ output }) => {
    const { result } = await run([...start(), selectorOutput(), output, deltaOutput()]);
    expect(result.operations).toHaveLength(6);
    expect(result.settlement).toMatchObject({ supportedClaimCount: 2, requestCoverage: "partial" });
    expect(result.contributionReceipt?.correctionAccepted).toBe(true);
  });

  it("does not publish an unverified supplement when the delta times out", async () => {
    const { result } = await run([...start(), selectorOutput(),
      { targets: { D1: ["Alpha has an unstated trend."], D2: [] }, version: 3 }, new Error("timeout")]);
    expect(result.settlement).toMatchObject({ supportedClaimCount: 1, requestCoverage: "partial", outcome: "answered" });
    expect(result.settlement.finalText).toContain(primaryTexts[0]);
    expect(result.settlement.finalText).not.toContain("unstated trend");
    expect(result.settlement.finalText).not.toContain("[K2]");
    expect(result.contributionReceipt?.correctionAccepted).toBe(false);
  });

  it("retains both source/requirement bindings when the published text is identical", async () => {
    const texts = ["The value is 42.", "The value is 42."];
    const { result } = await run([...start(2, texts), selectorOutput(2, ["covered", "covered"], [["C1"], ["C2"]]),
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "closed" }], version: 3 }], { texts });
    expect(result.settlement).toMatchObject({ supportedClaimCount: 2, requestCoverage: "complete" });
    expect(result.settlement.finalText).toContain("alpha: The value is 42. [K1]");
    expect(result.settlement.finalText).toContain("beta: The value is 42. [K2]");
  });

  it("reopens failed collective closure while preserving proven contributions", async () => {
    const { result } = await run([...start(), selectorOutput(2, ["covered", "covered"], [["C1"], ["C2"]]),
      new Error("timeout"), { targets: { D1: [], D2: [] }, version: 3 }, new Error("timeout")]);
    expect(result.settlement).toMatchObject({ supportedClaimCount: 2, requestCoverage: "partial" });
    expect(result.contributionReceipt?.closure).toBeNull();
  });

  it("publishes three dated readings after trend closure reopens, and omits an unrelated supported fact", async () => {
    const texts = ["Reading on 2040-01-01 was 42 units.", "Reading on 2040-02-01 was 35 units.",
      "Reading on 2040-03-01 was 38 units.", "The cabinet is blue."];
    const handles = texts.map((_text, index) => `K${index + 1}`);
    const { result } = await run([
      { claims: texts.map((text, index) => ({ text, citationHints: [handles[index]] })), version: 1 },
      { evidenceUnits: handles.map((handle) => ({ handle, findings: [] })),
        jointFindings: [{ description: "Report the dated readings and explain the trend.",
          evidenceAtomIds: ["A1", "A2", "A3"], requestAnchor: "dated readings" }], unsupportedDimensions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 7 },
      { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 },
      { claims: handles.map((handle, index) => ({ id: `C${index + 1}`, supportHandles: [handle], verdict: "supported" })),
        coverage: [{ id: "D1", contributionIds: ["C1", "C2", "C3"], status: "covered" }], insufficientReason: "not_applicable", version: 2 },
      { decisions: [{ id: "D1", status: "missing" }], version: 3 },
      { targets: { D1: [] }, version: 3 }, new Error("timeout")
    ], { texts, request: "Report the dated readings and explain the trend." });
    expect(result.settlement).toMatchObject({ supportedClaimCount: 3, requestCoverage: "partial", outcome: "answered" });
    for (const text of texts.slice(0, 3)) expect(result.settlement.finalText).toContain(text);
    for (const handle of ["[K1]", "[K2]", "[K3]", "trend"]) expect(result.settlement.finalText).toContain(handle);
    expect(result.settlement.finalText).not.toContain("cabinet");
    expect(result.settlement.finalText).not.toContain("[K4]");
  });

  it("keeps dated measurements, an independently requested count and an unproved trend distinct", async () => {
    const dates = ["2040-01-01", "2040-02-01", "2040-03-01"];
    const values = [42, 35, 38];
    const texts = dates.map((date, index) => `The reading on ${date} was ${values[index]} kg.`);
    texts.push("Three readings were recorded.");
    const anchors = [...dates, "count", "trend"];
    const descriptions = [...dates.map((date) => `Report the measurement on ${date} with its unit.`),
      "Report the count of readings.", "Explain the trend."];
    const { result } = await run([
      { claims: texts.map((text, index) => ({ text, citationHints: [`K${index + 1}`] })), version: 1 },
      { evidenceUnits: texts.map((_text, index) => ({ handle: `K${index + 1}`, findings: [{
        description: descriptions[index], evidenceAtomIds: [`A${index + 1}`], requestAnchor: anchors[index]
      }] })), jointFindings: [], unsupportedDimensions: [{ description: descriptions[4], requestAnchor: anchors[4] }],
      overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 7 },
      { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 },
      { claims: texts.map((_text, index) => ({ id: `C${index + 1}`, supportHandles: [`K${index + 1}`], verdict: "supported" })),
        coverage: anchors.map((_anchor, index) => ({ id: `D${index + 1}`, status: index < 4 ? "covered" : "missing",
          contributionIds: index < 4 ? [`C${index + 1}`] : [] })), insufficientReason: "not_applicable", version: 2 },
      { decisions: anchors.map((_anchor, index) => ({ id: `D${index + 1}`, status: index < 4 ? "closed" : "missing" })), version: 3 }
    ], { texts, request: `Report the dated readings for ${dates.join(", ")}, the count, and the trend.` });
    expect(result.settlement).toMatchObject({ requestCoverage: "partial", supportedClaimCount: 4 });
    expect(result.contributionReceipt).toMatchObject({ coverage: { coveredDimensionCount: 4, missingDimensionCount: 1 },
      coverageScope: { dimensionCount: 5, pendingRequirementCount: 0, requestAnalysisIncomplete: false } });
    for (const [index, text] of texts.entries()) expect(result.settlement.finalText).toContain(`${text} [K${index + 1}]`);
    expect(result.settlement.finalText).toContain("Explain the trend.");
  });

  it("reserves the eighth slot for mapping after adjacent selector and closure repairs", async () => {
    const { result } = await run([...start(), {}, selectorOutput(2, ["covered", "missing"]), {},
      { decisions: [{ id: "D1", status: "closed" }, { id: "D2", status: "missing" }], version: 3 },
      { claims: [], targets: { D2: { addContributionIds: ["C2"], status: "covered" } }, version: 2 }]);
    expect(result.operations).toHaveLength(8);
    expect(result.operations.some(({ operation }) => operation === "knowledge_answer_draft_supplement_v22")).toBe(false);
    expect(result.settlement).toMatchObject({ supportedClaimCount: 2, requestCoverage: "complete" });
  });

  it.each(["atom", "description"])("replays an accepted Scope repair without process-local rejected output (%s)", async (defect) => {
    const malformedScope = scopeOutput();
    if (defect === "atom") malformedScope.evidenceUnits[0]!.findings[0]!.evidenceAtomIds = ["A99"];
    else malformedScope.evidenceUnits[0]!.findings.push({ ...malformedScope.evidenceUnits[0]!.findings[0]! });
    const { result, store } = await run([draftOutput(24), malformedScope, scopeOutput(), { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 },
      selectorOutput(24), deltaOutput()]);
    expect(result.operations).toHaveLength(6);
    expect(result.settlement).toMatchObject({ supportedClaimCount: 2, requestCoverage: "partial" });
    if (defect === "description") {
      expect(store.stored()[1]!.attempt.acceptedResult).toEqual({
        kind: "coverage_scope_failed", reason: "coverage_scope_finding_duplicate"
      });
      const repair = store.stored()[2]!.attempt.acceptedRequest!;
      expect(JSON.parse(repair.userPrompt)).toMatchObject({ repairReason: "coverage_scope_finding_duplicate" });
    }
  });

  it("rejects missing, reordered and forged accepted checkpoints during replay", async () => {
    const { store } = await run([...start(24), selectorOutput(24), deltaOutput()]);
    const replay = (dispatches: StoredKnowledgeEvidenceDispatch[]) => replayKnowledgeAnswerGroundingV40({
      dispatches, forbiddenIdentityFragments: [], modelRunId: "synthetic-run"
    });
    await expect(replay(store.stored().slice(0, -1))).rejects.toThrow("knowledge_answer_replay_incomplete");
    await expect(replay(store.stored().reverse())).rejects.toThrow("knowledge_answer_replay_invalid");
    const forged = store.stored();
    const badDelta = { ...deltaOutput(), claims: [{ id: "C1", supportHandles: ["K2"], verdict: "supported" }] };
    forged[4] = { ...forged[4]!, attempt: { ...forged[4]!.attempt,
      acceptedResult: badDelta, resultHash: knowledgeAnswerHash(badDelta) } };
    await expect(replay(forged)).rejects.toThrow("knowledge_correction_delta_invalid");
    const snapshot = store.stored()[4]!.attempt.acceptedRequest!;
    expect(decodeKnowledgeAnswerOperationRequestSnapshotV21({ ...snapshot, version: 39 })).toBeNull();
    expect(decodeKnowledgeAnswerOperationRequestSnapshotV21({ ...snapshot, reasoningEffort: "unauthorized" })).toBeNull();
    const schema = { ...snapshot.schema as Record<string, unknown>, additionalProperties: true };
    expect(decodeKnowledgeAnswerOperationRequestSnapshotV21({ ...snapshot, schema, schemaHash: knowledgeAnswerHash(schema) })).toBeNull();
  });
});
