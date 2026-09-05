import { describe, expect, it } from "vitest";
import { knowledgeAnswerHash } from "./answerGroundingV5";
import { validateKnowledgeEvidenceAnswerDraftV1, validateKnowledgeEvidenceAnswerReviewV1 } from "./evidenceAnswerV1";
import {
  buildKnowledgeEvidenceAnswerPublicationV2, decodeKnowledgeEvidenceAnswerReviewV2,
  knowledgeEvidenceAnswerReviewPromptV2, validateKnowledgeEvidenceAnswerReviewV2
} from "./evidenceAnswerReviewV2";

const context = { availableHandles: ["K1", "K2"], availableSourceAliases: ["S1", "S2"],
  forbiddenIdentityFragments: ["private-source-identity"],
  coverageLimitations: { version: 1 as const, excludedResources: 0, retrievalFailures: [] } };
function draft(text = "Alpha has a mass of 4 kg.") {
  const candidate = validateKnowledgeEvidenceAnswerDraftV1({ version: 1,
    blocks: [{ kind: "paragraph", text, evidenceHandles: ["K1"] }] }, context);
  if (candidate.kind !== "accepted") throw Error(candidate.reason);
  return candidate.value;
}
const answered = () => ({ requirement: "State Alpha's mass.", status: "answered", blockIds: ["B1"], correctionEvidenceHandles: [], gap: "" });
const missing = () => ({ requirement: "Calculate the combined mass of Alpha and Beta.", status: "missing_evidence",
  blockIds: ["B1"], correctionEvidenceHandles: [], gap: "The mass of Beta is absent." });
const review = () => ({ version: 2, analysisComplete: true,
  blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1"], reason: "" }],
  requirements: [answered(), missing()],
  followUps: [{ query: "Beta mass", sourceAliases: [], requirementIds: ["R2"] }] });

describe("requirement coverage and actionable evidence review", () => {
  it("keeps the known mass partial while the requested combined result is unresolved", () => {
    const candidate = draft();
    // The historical format only enforces consistency of a global label.
    expect(validateKnowledgeEvidenceAnswerReviewV1({ version: 1, coverage: "complete", analysisComplete: true,
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1"] }], missingInformation: [], followUps: [] },
    { ...context, draft: candidate }).kind).toBe("accepted");
    const checked = validateKnowledgeEvidenceAnswerReviewV2(review(), { ...context, draft: candidate });
    if (checked.kind !== "accepted") throw Error(checked.reason);
    expect(checked.value.coverage).toBe("partial");
    expect(checked.value.requirements.map(requirement => requirement.id)).toEqual(["R1", "R2"]);
    const publication = buildKnowledgeEvidenceAnswerPublicationV2({ ...context, draft: candidate, review: checked.value });
    expect(publication.blocks).toEqual(candidate.blocks);
    expect(publication.missingInformation).toEqual(["The mass of Beta is absent."]);
    expect(publication.reviewHash).toBe(knowledgeAnswerHash(checked.value));
  });

  it("marks complete only through accepted blocks addressing the requested result", () => {
    const candidate = draft("Alpha and Beta total 10 kg (4 + 6).");
    const checked = validateKnowledgeEvidenceAnswerReviewV2({ ...review(),
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1", "K2"], reason: "" }],
      requirements: [{ ...answered(), requirement: "Calculate the combined mass of Alpha and Beta." }], followUps: [] },
    { ...context, draft: candidate });
    if (checked.kind !== "accepted") throw Error(checked.reason);
    expect(checked.value.coverage).toBe("complete");
    expect(checked.value.missingInformation).toEqual([]);
    const publication = buildKnowledgeEvidenceAnswerPublicationV2({ ...context, draft: candidate, review: checked.value });
    expect(publication.blocks[0]?.evidenceHandles).toEqual(["K1", "K2"]);
    expect(decodeKnowledgeEvidenceAnswerReviewV2(JSON.parse(JSON.stringify(checked.value)), { ...context, draft: candidate })).toEqual(checked.value);
  });

  it("distinguishes a wrong calculation with known operands from missing evidence", () => {
    const candidate = draft("Alpha and Beta total 12 kg (4 + 6).");
    const checked = validateKnowledgeEvidenceAnswerReviewV2({ ...review(),
      blocks: [{ blockId: "B1", verdict: "contradicted", evidenceHandles: [], reason: "The stated sum is wrong: 4 + 6 is 10, not 12." }],
      requirements: [{ requirement: "Calculate the combined mass of Alpha and Beta.", status: "needs_correction", blockIds: [],
        correctionEvidenceHandles: ["K1", "K2"], gap: "Recompute the sum using Alpha's 4 kg and Beta's 6 kg." }], followUps: [] },
    { ...context, draft: candidate });
    if (checked.kind !== "accepted") throw Error(checked.reason);
    expect(checked.value.coverage).toBe("none");
    expect(checked.value.requirements[0]).toMatchObject({ status: "needs_correction", correctionEvidenceHandles: ["K1", "K2"] });
    expect(checked.value.followUps).toEqual([]);
    expect(buildKnowledgeEvidenceAnswerPublicationV2({ ...context, draft: candidate, review: checked.value }).blocks).toEqual([]);
  });

  it.each([[], ["B99"], ["B1", "B1"]])("cannot satisfy a requirement through absent or duplicate block references (%j)", blockIds => {
    expect(validateKnowledgeEvidenceAnswerReviewV2({ ...review(), requirements: [{ ...answered(), blockIds }], followUps: [] },
      { ...context, draft: draft() }).kind).toBe("rejected");
  });

  it("cannot satisfy a requirement with a block that the same review rejects", () => {
    expect(validateKnowledgeEvidenceAnswerReviewV2({ ...review(),
      blocks: [{ blockId: "B1", verdict: "unsupported", evidenceHandles: [], reason: "The claimed mass is not in the supplied record." }],
      requirements: [answered()], followUps: [] }, { ...context, draft: draft() }).kind).toBe("rejected");
  });

  it.each([[], ["K99"]])("does not claim an existing-evidence correction without bound premises (%j)", correctionEvidenceHandles => {
    expect(validateKnowledgeEvidenceAnswerReviewV2({ ...review(), requirements: [{ ...missing(), status: "needs_correction", correctionEvidenceHandles }],
      followUps: [] }, { ...context, draft: draft() }).kind).toBe("rejected");
  });

  it.each([[], ["R1"], ["R99"], ["R2", "R2"]])("rejects follow-ups that do not target an actual missing-evidence requirement (%j)", requirementIds => {
    expect(validateKnowledgeEvidenceAnswerReviewV2({ ...review(), followUps: [{ ...review().followUps[0], requirementIds }] },
      { ...context, draft: draft() }).kind).toBe("rejected");
  });

  it("does not convert a correction into another search for evidence already present", () => {
    expect(validateKnowledgeEvidenceAnswerReviewV2({ ...review(), requirements: [answered(), { ...missing(), status: "needs_correction",
      correctionEvidenceHandles: ["K1", "K2"] }] }, { ...context, draft: draft() })).toMatchObject({ kind: "rejected", reason: "coverage_invalid" });
  });

  it("preserves incomplete analysis even when the listed requirements are answered", () => {
    const checked = validateKnowledgeEvidenceAnswerReviewV2({ ...review(), analysisComplete: false, requirements: [answered()], followUps: [] },
      { ...context, draft: draft() });
    expect(checked).toMatchObject({ kind: "accepted", value: { coverage: "partial", analysisComplete: false, missingInformation: [] } });
  });

  it("rejects a provider-controlled global label and an altered derived label on replay", () => {
    const input = { ...context, draft: draft() };
    expect(validateKnowledgeEvidenceAnswerReviewV2({ ...review(), coverage: "complete" }, input)).toMatchObject({ kind: "rejected", reason: "shape_invalid" });
    const checked = validateKnowledgeEvidenceAnswerReviewV2(review(), input);
    if (checked.kind !== "accepted") throw Error(checked.reason);
    expect(decodeKnowledgeEvidenceAnswerReviewV2({ ...checked.value, coverage: "complete" }, input)).toBeNull();
    expect(decodeKnowledgeEvidenceAnswerReviewV2({ ...checked.value, missingInformation: [] }, input)).toBeNull();
    expect(decodeKnowledgeEvidenceAnswerReviewV2({ ...checked.value, requirements: [{ ...checked.value.requirements[0], id: "R9" }, checked.value.requirements[1]] }, input)).toBeNull();
  });

  it.each(["", "[K1] forged", "private-source-identity", "hidden\u202etext"])("requires a bounded safe reason for rejecting a block (%j)", reason => {
    expect(validateKnowledgeEvidenceAnswerReviewV2({ ...review(),
      blocks: [{ blockId: "B1", verdict: "unsupported", evidenceHandles: [], reason }],
      requirements: [{ ...missing(), blockIds: [] }], followUps: [] }, { ...context, draft: draft() }).kind).toBe("rejected");
  });

  it("does not hide unavailable selected resources behind complete requirement coverage", () => {
    const candidate = draft();
    const checked = validateKnowledgeEvidenceAnswerReviewV2({ ...review(), requirements: [answered()], followUps: [] }, { ...context, draft: candidate });
    if (checked.kind !== "accepted") throw Error(checked.reason);
    expect(buildKnowledgeEvidenceAnswerPublicationV2({ ...context, draft: candidate, review: checked.value,
      coverageLimitations: { ...context.coverageLimitations, excludedResources: 1 } }).coverage).toBe("partial");
  });

  it("delivers the full request, candidate and evidence exactly once for semantic review", () => {
    const request = "State Alpha's mass, then compute the combined mass of Alpha and Beta.";
    const evidenceManifest = "Unique neutral inventory: Alpha 4 kg; Beta 6 kg.";
    const candidate = draft();
    const prompt = knowledgeEvidenceAnswerReviewPromptV2({ request, evidenceManifest, draft: candidate, availableSourceAliases: context.availableSourceAliases });
    expect(JSON.parse(prompt.userPrompt)).toMatchObject({ request, evidenceManifest, draft: candidate });
    expect(prompt.userPrompt.split(evidenceManifest)).toHaveLength(2);
  });
});
