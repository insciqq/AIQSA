import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { groundKnowledgeAnswer } from "../../lib/server/knowledge/grounding";
import {
  KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX,
  createPersistedProviderAnswerReviewArtifacts,
  providerAnswerEvalCases,
  providerAnswerEvalProfiles,
  runProviderAnswerEval,
  type ProviderAnswerCallInput,
  type ProviderAnswerEvalCase,
  type ProviderAnswerOutputFreeze,
  type ProviderAnswerReviewMapping,
  type ProviderAnswerReviewPacket
} from "./providerAnswerEval";
import {
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ADJUDICATION_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_A_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_B_FILE,
  ProviderAnswerReleaseReviewError,
  assertProviderAnswerReleaseReviewArtifacts,
  createProviderAnswerReleaseAdjudication,
  createProviderAnswerReleaseReviewerSubmission,
  importProviderAnswerReleaseReviewEvidence,
  providerAnswerReleaseReviewDimensions,
  readProviderAnswerReleaseReviewEvidenceDirectory,
  type ProviderAnswerReleaseAdjudication,
  type ProviderAnswerReleaseAdjudicator,
  type ProviderAnswerReleaseDimensionAssessment,
  type ProviderAnswerReleaseDisagreementResolution,
  type ProviderAnswerReleaseOutputDecision,
  type ProviderAnswerReleaseReviewer,
  type ProviderAnswerReleaseReviewerSubmission
} from "./providerAnswerReleaseReview";

// All decisions and principals in this file are synthetic contract fixtures.
// They are not human review evidence and cannot make the aggregate production-eligible.

type OutputArtifacts = Readonly<{
  freeze: ProviderAnswerOutputFreeze;
  mapping: ProviderAnswerReviewMapping;
  packet: ProviderAnswerReviewPacket;
}>;

type ReviewBundle = Readonly<{
  adjudication: ProviderAnswerReleaseAdjudication;
  submissions: readonly [
    ProviderAnswerReleaseReviewerSubmission,
    ProviderAnswerReleaseReviewerSubmission
  ];
}>;

const temporaryPaths: string[] = [];
let artifacts: OutputArtifacts;
let allProviderArtifacts: OutputArtifacts;
let otherArtifacts: OutputArtifacts;
let partialArtifacts: OutputArtifacts;
let generationExecutorCallCount = 0;

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function answerFor(input: ProviderAnswerCallInput): string {
  expect(input.request.toolMode).toBe("none");
  return "The selected sources do not provide enough evidence to answer.";
}

function answerForCase(caseDefinition: ProviderAnswerEvalCase): string {
  const cited = caseDefinition.evidence.items
    .filter((item) => item.state === "available" && item.excerpt)
    .map((item) => `${item.excerpt} [${item.handle}]`);
  return cited.length > 0
    ? cited.join(" ")
    : "The selected sources do not provide enough evidence to answer.";
}

async function generateOutputArtifacts(
  label: string,
  failAfterCompletedCalls: number | null = null,
  selectedProvider: "anthropic" | null = "anthropic"
): Promise<OutputArtifacts> {
  const directory = await mkdtemp(join(
    "/tmp",
    KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX
  ));
  await chmod(directory, 0o700);
  temporaryPaths.push(directory);
  let reviewId = 0;
  let completedCalls = 0;
  await runProviderAnswerEval({
    executePaid: true,
    prepareExecutor: () => async (input) => {
      generationExecutorCallCount += 1;
      if (failAfterCompletedCalls !== null &&
        completedCalls >= failAfterCompletedCalls) {
        throw new Error("synthetic_partial_provider_failure");
      }
      completedCalls += 1;
      return {
        answer: answerFor(input),
        usage: { inputTokens: 2, outputTokens: 2, reasoningTokens: 0 }
      };
    },
    randomId: () => `${label}-frozen-output-${++reviewId}`,
    randomIndex: () => 0,
    reviewDirectory: directory,
    ...(selectedProvider ? { selectedProvider } : {})
  });
  return {
    freeze: await jsonFile(join(directory, KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE)),
    mapping: await jsonFile(join(directory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE)),
    packet: await jsonFile(join(directory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE))
  };
}

function reviewer(principal: string): ProviderAnswerReleaseReviewer {
  return {
    completedIndependently: true,
    humanAttestation: "independent_external_human_release_review",
    implementationAgent: false,
    modelGeneratedDecisions: false,
    principalSha256: principal.repeat(64),
    provenance: "external_human",
    role: "independent_reviewer"
  };
}

function adjudicator(principal = "3"): ProviderAnswerReleaseAdjudicator {
  return {
    humanAttestation: "external_human_release_review_adjudication",
    implementationAgent: false,
    modelGeneratedDecisions: false,
    principalSha256: principal.repeat(64),
    provenance: "external_human",
    role: "adjudicator"
  };
}

function decisionsFor(
  source: OutputArtifacts,
  supportedAssessment: ProviderAnswerReleaseDimensionAssessment =
    "not_applicable_pre_h7"
): ProviderAnswerReleaseOutputDecision[] {
  return source.freeze.outputs.map(({ outputSha256, reviewId }) => ({
    dimensions: providerAnswerReleaseReviewDimensions.map((dimension) => ({
      assessment: dimension === "supported_claim_preservation"
        ? supportedAssessment
        : "pass" as const,
      dimension
    })),
    materialErrors: { citation: "none", factual: "none" },
    outputSha256,
    reviewId
  }));
}

function withMaterialFactualError(
  decisions: readonly ProviderAnswerReleaseOutputDecision[]
): ProviderAnswerReleaseOutputDecision[] {
  return decisions.map((decision, index) => index === 0
    ? {
        ...decision,
        dimensions: decision.dimensions.map((dimension) =>
          dimension.dimension === "correctness"
            ? { ...dimension, assessment: "fail" as const }
            : dimension),
        materialErrors: { ...decision.materialErrors, factual: "material" as const }
      }
    : decision);
}

function withMaterialCitationError(
  decisions: readonly ProviderAnswerReleaseOutputDecision[]
): ProviderAnswerReleaseOutputDecision[] {
  return decisions.map((decision, index) => index === 1
    ? {
        ...decision,
        dimensions: decision.dimensions.map((dimension) =>
          dimension.dimension === "citation_usability"
            ? { ...dimension, assessment: "fail" as const }
            : dimension),
        materialErrors: { ...decision.materialErrors, citation: "material" as const }
      }
    : decision);
}

function createBundle(input: Readonly<{
  adjudicated?: readonly ProviderAnswerReleaseOutputDecision[];
  artifacts?: OutputArtifacts;
  first?: readonly ProviderAnswerReleaseOutputDecision[];
  resolutions?: readonly ProviderAnswerReleaseDisagreementResolution[];
  second?: readonly ProviderAnswerReleaseOutputDecision[];
}> = {}): ReviewBundle {
  const source = input.artifacts ?? artifacts;
  const firstDecisions = input.first ?? decisionsFor(source);
  const secondDecisions = input.second ?? decisionsFor(source);
  const first = createProviderAnswerReleaseReviewerSubmission({
    artifacts: source,
    decisions: firstDecisions,
    reviewer: reviewer("1"),
    reviewerSlot: "reviewer_a"
  });
  const second = createProviderAnswerReleaseReviewerSubmission({
    artifacts: source,
    decisions: secondDecisions,
    reviewer: reviewer("2"),
    reviewerSlot: "reviewer_b"
  });
  const submissions = [first, second] as const;
  return {
    adjudication: createProviderAnswerReleaseAdjudication({
      adjudicator: adjudicator(),
      artifacts: source,
      decisions: input.adjudicated ?? decisionsFor(source),
      disagreementResolutions: input.resolutions ?? [],
      submissions
    }),
    submissions
  };
}

beforeAll(async () => {
  artifacts = await generateOutputArtifacts("release-a");
  allProviderArtifacts = await generateOutputArtifacts("release-all", null, null);
  otherArtifacts = await generateOutputArtifacts("release-b");
  partialArtifacts = await generateOutputArtifacts("release-partial", 1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })));
});

describe("provider answer independent release review", () => {
  it("binds every frozen output to all eight PRD dimensions and returns aggregates only", () => {
    const bundle = createBundle();
    const report = importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      ...bundle
    });

    expect(() => assertProviderAnswerReleaseReviewArtifacts({
      ...artifacts,
      ...bundle
    })).not.toThrow();
    expect(report).toMatchObject({
      aggregateOnly: true,
      privateContentIncluded: false,
      review: {
        adjudicationComplete: true,
        adjudicatorCount: 1,
        allArtifactsFrozenBeforeReview: true,
        independentReviewerCount: 2,
        provenanceVerification: "self_attested_unverified",
        reviewedDimensionDecisionCount: artifacts.freeze.outputCount * 8,
        reviewedOutputCount: artifacts.freeze.outputCount,
        unresolvedMaterialDisagreements: 0
      },
      gates: {
        fullProductionReleaseEligible: false,
        humanProvenanceGatePassed: false,
        materialErrorGatePassed: true,
        outputReviewGatePassed: true,
        supportedClaimPreservation: "not_applicable_pre_h7"
      }
    });
    expect(Object.keys(report.dimensions)).toEqual(providerAnswerReleaseReviewDimensions);
    expect(report.dimensions.supported_claim_preservation).toEqual({
      fail: 0,
      not_applicable_pre_h7: artifacts.freeze.outputCount,
      pass: 0,
      uncertain: 0
    });
    expect(report.gates.reasonCodes).toContain(
      "supported_claim_preservation_not_assessed_or_failed"
    );
    expect(report.gates.reasonCodes).toContain("external_human_provenance_unverified");

    const reportText = JSON.stringify(report);
    const firstItem = artifacts.packet.items[0]!;
    const firstMapping = artifacts.mapping.entries.find((entry) => entry.status === "complete")!;
    expect(reportText).not.toContain(firstItem.answer);
    expect(reportText).not.toContain(firstItem.query);
    expect(reportText).not.toContain(firstItem.reviewId);
    expect(reportText).not.toContain(firstItem.sourceLocalEvidence[0]?.excerpt ?? "never");
    expect(reportText).not.toContain(bundle.submissions[0].reviewer.principalSha256);
    expect(reportText).not.toContain(firstMapping.caseId);
    expect(reportText).not.toContain(firstMapping.modelId);
    expect(reportText).not.toContain(firstMapping.provider);
  });

  it("rejects a partial provider cohort before it can produce a review gate", () => {
    expect(partialArtifacts.freeze.outputCount).toBe(1);
    expect(partialArtifacts.mapping.entries.map(({ status }) => status)).toEqual([
      "complete",
      "failed",
      ...Array.from({ length: 6 }, () => "skipped_after_provider_failure")
    ]);
    expect(() => createProviderAnswerReleaseReviewerSubmission({
      artifacts: partialArtifacts,
      decisions: decisionsFor(partialArtifacts, "pass"),
      reviewer: reviewer("4"),
      reviewerSlot: "reviewer_a"
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_coverage_incomplete"
    }));

    const completeBundle = createBundle();
    expect(() => importProviderAnswerReleaseReviewEvidence({
      ...partialArtifacts,
      ...completeBundle
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_coverage_incomplete"
    }));
  });

  it("requires exactly one complete eight-case provider cohort", () => {
    expect(allProviderArtifacts.freeze.outputCount).toBe(24);
    expect(allProviderArtifacts.mapping.entries.every((entry) =>
      entry.status === "complete")).toBe(true);
    expect(() => createProviderAnswerReleaseReviewerSubmission({
      artifacts: allProviderArtifacts,
      decisions: decisionsFor(allProviderArtifacts, "pass"),
      reviewer: reviewer("4"),
      reviewerSlot: "reviewer_a"
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_coverage_incomplete"
    }));
  });

  it("blocks the output gate on any explicit material factual or citation error", () => {
    const materialDecisions = withMaterialCitationError(
      withMaterialFactualError(decisionsFor(artifacts))
    );
    const bundle = createBundle({
      adjudicated: materialDecisions,
      first: materialDecisions,
      second: materialDecisions
    });
    const report = importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      ...bundle
    });

    expect(report.materialErrors).toEqual({
      citationOutputCount: 1,
      factualOutputCount: 1,
      outputCount: 2
    });
    expect(report.gates.materialErrorGatePassed).toBe(false);
    expect(report.gates.outputReviewGatePassed).toBe(false);
    expect(report.gates.fullProductionReleaseEligible).toBe(false);
    expect(report.gates.reasonCodes).toEqual(expect.arrayContaining([
      "dimension_failure_or_uncertainty",
      "material_citation_error",
      "material_factual_error"
    ]));
  });

  it("requires exact resolutions for reviewer and adjudicator disagreements", () => {
    const first = decisionsFor(artifacts);
    const second = withMaterialFactualError(decisionsFor(artifacts));
    const reviewId = first[0]!.reviewId;

    expect(() => createBundle({ first, second })).toThrowError(
      expect.objectContaining({
        code: "knowledge_provider_answer_release_disagreement_resolution_incomplete"
      })
    );

    const bundle = createBundle({
      adjudicated: first,
      first,
      resolutions: [{
        categories: ["dimension_assessment", "material_factual_error"],
        resolved: true,
        reviewId
      }],
      second
    });
    const report = importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      ...bundle
    });
    expect(report.disagreement).toEqual({
      citationMaterialClassificationCount: 0,
      dimensionAssessmentCount: 1,
      factualMaterialClassificationCount: 1,
      outputsRequiringAdjudication: 1
    });
    expect(report.review.unresolvedMaterialDisagreements).toBe(0);
  });

  it("rejects incomplete, reordered, cross-swapped, or materially inconsistent decisions", () => {
    const complete = decisionsFor(artifacts);
    expect(() => createProviderAnswerReleaseReviewerSubmission({
      artifacts,
      decisions: complete.slice(1),
      reviewer: reviewer("1"),
      reviewerSlot: "reviewer_a"
    })).toThrow();

    const reordered = structuredClone(complete);
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(() => createProviderAnswerReleaseReviewerSubmission({
      artifacts,
      decisions: reordered,
      reviewer: reviewer("1"),
      reviewerSlot: "reviewer_a"
    })).toThrow();

    const missingDimension = structuredClone(complete);
    missingDimension[0]!.dimensions.pop();
    expect(() => createProviderAnswerReleaseReviewerSubmission({
      artifacts,
      decisions: missingDimension,
      reviewer: reviewer("1"),
      reviewerSlot: "reviewer_a"
    })).toThrow();

    const invalidApplicability = structuredClone(complete);
    invalidApplicability[0]!.dimensions[0]!.assessment = "not_applicable_pre_h7";
    expect(() => createProviderAnswerReleaseReviewerSubmission({
      artifacts,
      decisions: invalidApplicability,
      reviewer: reviewer("1"),
      reviewerSlot: "reviewer_a"
    })).toThrow();

    const inconsistent = structuredClone(complete);
    inconsistent[0]!.materialErrors.factual = "material";
    expect(() => createProviderAnswerReleaseReviewerSubmission({
      artifacts,
      decisions: inconsistent,
      reviewer: reviewer("1"),
      reviewerSlot: "reviewer_a"
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_material_classification_invalid"
    }));

    const otherBundle = createBundle({ artifacts: otherArtifacts });
    expect(() => importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      ...otherBundle
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_binding_invalid"
    }));
  });

  it("requires two distinct reviewers and a third distinct external adjudicator", () => {
    const decisions = decisionsFor(artifacts);
    const first = createProviderAnswerReleaseReviewerSubmission({
      artifacts,
      decisions,
      reviewer: reviewer("1"),
      reviewerSlot: "reviewer_a"
    });
    const duplicatePrincipal = createProviderAnswerReleaseReviewerSubmission({
      artifacts,
      decisions,
      reviewer: reviewer("1"),
      reviewerSlot: "reviewer_b"
    });
    expect(() => createProviderAnswerReleaseAdjudication({
      adjudicator: adjudicator(),
      artifacts,
      decisions,
      disagreementResolutions: [],
      submissions: [first, duplicatePrincipal]
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_human_authorities_not_distinct"
    }));

    const second = createProviderAnswerReleaseReviewerSubmission({
      artifacts,
      decisions,
      reviewer: reviewer("2"),
      reviewerSlot: "reviewer_b"
    });
    expect(() => createProviderAnswerReleaseAdjudication({
      adjudicator: adjudicator("1"),
      artifacts,
      decisions,
      disagreementResolutions: [],
      submissions: [first, second]
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_human_authorities_not_distinct"
    }));
  });

  it("rejects packet, mapping, and freeze tampering before reading decisions", () => {
    const bundle = createBundle();
    const packet = structuredClone(artifacts.packet);
    (packet.items[0] as { answer: string }).answer += " tampered";
    expect(() => importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      packet,
      ...bundle
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_artifact_chain_invalid"
    }));

    const mapping = structuredClone(artifacts.mapping);
    (mapping as { mappingSha256: string }).mappingSha256 = "0".repeat(64);
    expect(() => importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      mapping,
      ...bundle
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_artifact_chain_invalid"
    }));

    const freeze = structuredClone(artifacts.freeze);
    (freeze as { outputCount: number }).outputCount += 1;
    expect(() => importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      freeze,
      ...bundle
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_artifact_chain_invalid"
    }));

    const submission = structuredClone(bundle.submissions[0]);
    submission.decisions[0]!.dimensions[0]!.assessment = "uncertain";
    expect(() => importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      adjudication: bundle.adjudication,
      submissions: [submission, bundle.submissions[1]]
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_review_artifact_invalid"
    }));

    const adjudication = structuredClone(bundle.adjudication);
    adjudication.decisions[0]!.dimensions[0]!.assessment = "uncertain";
    expect(() => importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      adjudication,
      submissions: bundle.submissions
    })).toThrowError(expect.objectContaining({
      code: "knowledge_provider_answer_release_review_artifact_invalid"
    }));
  });

  it("derives a persisted-route viewer gate but never self-verifies human provenance", () => {
    const caseDefinitions = providerAnswerEvalCases();
    const profile = providerAnswerEvalProfiles().find((candidate) =>
      candidate.provider === "anthropic")!;
    const persisted = createPersistedProviderAnswerReviewArtifacts({
      completed: caseDefinitions.map((caseDefinition, index) => {
        const mappingEntry = artifacts.mapping.entries.find((entry) =>
          entry.status === "complete" && entry.caseId === caseDefinition.id);
        const packetItem = artifacts.packet.items.find((item) =>
          item.reviewId === mappingEntry?.reviewId);
        expect(mappingEntry?.status).toBe("complete");
        expect(packetItem).toBeDefined();
        const answer = answerForCase(caseDefinition);
        return {
          answer,
          caseDefinition,
          citationViewerArtifacts: packetItem!.citationViewerArtifacts.map((artifact) => ({
            provenance: "persisted_route" as const,
            releaseEvidenceEligible: true as const,
            viewer: artifact.viewer
          })),
          grounding: groundKnowledgeAnswer({ answer, evidence: caseDefinition.evidence }),
          latencyMs: 1,
          profile,
          reviewId: `persisted-route-release-review-${index + 1}`,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }),
      randomIndex: () => 0
    });
    const allPassed = decisionsFor(persisted, "pass");
    const bundle = createBundle({
      adjudicated: allPassed,
      artifacts: persisted,
      first: allPassed,
      second: allPassed
    });
    const report = importProviderAnswerReleaseReviewEvidence({
      ...persisted,
      ...bundle
    });

    expect(report.citationViewerArtifacts).toMatchObject({
      allPersistedRoute: true,
      syntheticProjectionCount: 0
    });
    expect(report.gates).toMatchObject({
      citationViewerGatePassed: true,
      fullProductionReleaseEligible: false,
      humanProvenanceGatePassed: false,
      outputReviewGatePassed: true,
      supportedClaimPreservation: "passed"
    });
    expect(report.gates.reasonCodes).toEqual([
      "external_human_provenance_unverified"
    ]);
  });

  it("performs no provider or network execution after the output freeze", () => {
    const bundle = createBundle();
    const callsBeforeImport = generationExecutorCallCount;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    importProviderAnswerReleaseReviewEvidence({
      ...artifacts,
      ...bundle
    });
    expect(generationExecutorCallCount).toBe(callsBeforeImport);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reads only the exact owner-only 0600 artifact set from a 0700 directory", async () => {
    const directory = await mkdtemp(join(
      "/tmp",
      KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX
    ));
    await chmod(directory, 0o700);
    temporaryPaths.push(directory);
    const bundle = createBundle();
    const files: readonly (readonly [string, unknown])[] = [
      [KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE, artifacts.freeze],
      [KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE, artifacts.mapping],
      [KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE, artifacts.packet],
      [KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_A_FILE, bundle.submissions[0]],
      [KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_B_FILE, bundle.submissions[1]],
      [KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ADJUDICATION_FILE, bundle.adjudication]
    ];
    await Promise.all(files.map(async ([name, value]) => {
      const path = join(directory, name);
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    }));

    await expect(readProviderAnswerReleaseReviewEvidenceDirectory(directory))
      .resolves.toMatchObject({ aggregateOnly: true, privateContentIncluded: false });

    await chmod(join(directory, KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_A_FILE), 0o644);
    await expect(readProviderAnswerReleaseReviewEvidenceDirectory(directory))
      .rejects.toBeInstanceOf(ProviderAnswerReleaseReviewError);
  });
});
