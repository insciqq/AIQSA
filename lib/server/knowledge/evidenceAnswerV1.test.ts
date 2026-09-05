import { describe, expect, it } from "vitest";
import {
  buildKnowledgeEvidenceAnswerPublicationV1,
  decodeKnowledgeEvidenceAnswerDraftV1,
  knowledgeEvidenceAnswerDraftPromptV1,
  knowledgeEvidenceAnswerReviewPromptV1,
  renderKnowledgeEvidenceAnswerPublicationV1,
  validateKnowledgeEvidenceAnswerDraftV1,
  validateKnowledgeEvidenceAnswerReviewV1,
  type KnowledgeEvidenceAnswerDraftV1
} from "./evidenceAnswerV1";

const context = {
  availableHandles: ["K1", "K2"],
  availableSourceAliases: ["S1", "S2"],
  forbiddenIdentityFragments: ["private-source-identity"],
  coverageLimitations: { version: 1 as const, excludedResources: 0, retrievalFailures: [] }
};
function draft(text = "Crate Alpha has a mass of 4 kg."): KnowledgeEvidenceAnswerDraftV1 {
  const result = validateKnowledgeEvidenceAnswerDraftV1({ version: 1,
    blocks: [{ kind: "paragraph", text, evidenceHandles: ["K1"] }] }, context);
  if (result.kind !== "accepted") throw Error(result.reason);
  return result.value;
}
const review = () => ({ version: 1, blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1"] }],
  coverage: "partial", analysisComplete: true, missingInformation: ["The mass of crate Beta."],
  followUps: [{ query: "crate Beta mass", sourceAliases: [] }] });

describe("reviewed evidence answers", () => {
  it("keeps a known operand useful while the other operand is missing", () => {
    const candidate = draft();
    const checked = validateKnowledgeEvidenceAnswerReviewV1(review(), { ...context, draft: candidate });
    expect(checked.kind).toBe("accepted");
    if (checked.kind !== "accepted") return;
    const publication = buildKnowledgeEvidenceAnswerPublicationV1({ ...context, draft: candidate, review: checked.value });
    expect(publication.coverage).toBe("partial");
    expect(publication.blocks).toEqual(candidate.blocks);
    expect(renderKnowledgeEvidenceAnswerPublicationV1(publication)).toContain("4 kg. [K1]");
    expect(publication.missingInformation).toEqual(["The mass of crate Beta."]);
  });

  it("binds a reviewed calculation to both independently supplied operands", () => {
    const candidate = draft("On 2026-02-04, North was 118 kPa and South was 121 kPa; South was 3 kPa higher (121 − 118).");
    const checked = validateKnowledgeEvidenceAnswerReviewV1({ ...review(), coverage: "complete", missingInformation: [], followUps: [],
      blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1", "K2"] }] }, { ...context, draft: candidate });
    expect(checked.kind).toBe("accepted");
    if (checked.kind !== "accepted") return;
    const publication = buildKnowledgeEvidenceAnswerPublicationV1({ ...context, draft: candidate, review: checked.value });
    expect(publication.coverage).toBe("complete");
    expect(publication.blocks[0]?.text).toBe(candidate.blocks[0]?.text);
    expect(renderKnowledgeEvidenceAnswerPublicationV1(publication)).toContain("[K1][K2]");
  });

  it("never publishes an unsupported block or its proposed citation", () => {
    const primary = validateKnowledgeEvidenceAnswerDraftV1({ version: 1, blocks: [
      { kind: "paragraph", text: "Alpha weighs 4 kg.", evidenceHandles: ["K1"] },
      { kind: "paragraph", text: "Beta weighs 9 kg.", evidenceHandles: ["K2"] }
    ] }, context);
    if (primary.kind !== "accepted") throw Error("fixture_invalid");
    const checked = validateKnowledgeEvidenceAnswerReviewV1({ ...review(), blocks: [
      { blockId: "B2", verdict: "unsupported", evidenceHandles: [] },
      { blockId: "B1", verdict: "supported", evidenceHandles: ["K1"] }
    ] }, { ...context, draft: primary.value });
    if (checked.kind !== "accepted") throw Error(checked.reason);
    const publication = buildKnowledgeEvidenceAnswerPublicationV1({ ...context, draft: primary.value, review: checked.value });
    expect(publication.blocks).toHaveLength(1);
    const rendered = renderKnowledgeEvidenceAnswerPublicationV1(publication);
    expect(rendered).not.toContain("9 kg");
    expect(rendered).not.toContain("[K2]");
    expect(rendered).toContain("4 kg");
  });

  it.each([
    { coverage: "complete", missingInformation: [], followUps: [], analysisComplete: false },
    { coverage: "complete", missingInformation: ["A missing condition."], followUps: [] },
    { coverage: "none" },
    { coverage: "partial", missingInformation: [], followUps: [] }
  ])("rejects coverage that contradicts its own accepted evidence (%j)", change => {
    expect(validateKnowledgeEvidenceAnswerReviewV1({ ...review(), ...change }, { ...context, draft: draft() }))
      .toMatchObject({ kind: "rejected", reason: "coverage_invalid" });
  });

  it("retains explicit incomplete-analysis and resource limitations", () => {
    const candidate = draft();
    const checked = validateKnowledgeEvidenceAnswerReviewV1({ ...review(), coverage: "complete", missingInformation: [], followUps: [] }, { ...context, draft: candidate });
    if (checked.kind !== "accepted") throw Error(checked.reason);
    const publication = buildKnowledgeEvidenceAnswerPublicationV1({ ...context, draft: candidate, review: checked.value,
      coverageLimitations: { version: 1, excludedResources: 2, retrievalFailures: ["opensearch_timeout"] } });
    expect(publication.coverage).toBe("partial");
    expect(renderKnowledgeEvidenceAnswerPublicationV1(publication)).toContain("unavailable");
    const incomplete = validateKnowledgeEvidenceAnswerReviewV1({ ...review(), analysisComplete: false, missingInformation: [], followUps: [] }, { ...context, draft: candidate });
    expect(incomplete.kind).toBe("accepted");
  });

  it.each([
    { blocks: [{ blockId: "B9", verdict: "supported", evidenceHandles: ["K1"] }] },
    { blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K99"] }] },
    { blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: [] }] },
    { blocks: [{ blockId: "B1", verdict: "unsupported", evidenceHandles: ["K1"] }] },
    { blocks: [] }
  ])("rejects missing, unknown or unproved publication references", ({ blocks }) => {
    expect(validateKnowledgeEvidenceAnswerReviewV1({ ...review(), blocks }, { ...context, draft: draft() }).kind).toBe("rejected");
  });

  it("cannot narrow a follow-up to an undisclosed Source", () => {
    expect(validateKnowledgeEvidenceAnswerReviewV1({ ...review(), followUps: [{ query: "Beta mass", sourceAliases: ["S99"] }] }, { ...context, draft: draft() }))
      .toMatchObject({ kind: "rejected", reason: "evidence_invalid" });
  });

  it("preserves literal API spelling and inert nested code fences", () => {
    const text = 'const item: Archive<Row> = archive.filter(row => row.active);\nconst __receipt__ = item.exportTo("```archive```");';
    const result = validateKnowledgeEvidenceAnswerDraftV1({ version: 1, blocks: [{ kind: "code", text, evidenceHandles: ["K1"] }] }, context);
    if (result.kind !== "accepted") throw Error(result.reason);
    expect(decodeKnowledgeEvidenceAnswerDraftV1(JSON.parse(JSON.stringify(result.value)), context)).toEqual(result.value);
    const checked = validateKnowledgeEvidenceAnswerReviewV1(review(), { ...context, draft: result.value });
    if (checked.kind !== "accepted") throw Error(checked.reason);
    const publication = buildKnowledgeEvidenceAnswerPublicationV1({ ...context, draft: result.value, review: checked.value });
    const rendered = renderKnowledgeEvidenceAnswerPublicationV1(publication);
    expect(rendered).toContain(`\`\`\`\`\n${text}\n\`\`\`\`\n\n[K1]`);
  });

  it.each(["[K1] fabricated", "private-source-identity", "hidden\u202etext", "broken\ud800text"]) ("rejects forged citations, private identity and hidden controls", text => {
    expect(validateKnowledgeEvidenceAnswerDraftV1({ version: 1, blocks: [{ kind: "paragraph", text, evidenceHandles: ["K1"] }] }, context).kind).toBe("rejected");
  });

  it("preserves indentation, trailing newlines and citation-shaped data in literal code", () => {
    const text = "    rows = [K1]\n    print(rows)\n";
    const result = validateKnowledgeEvidenceAnswerDraftV1({ version: 1, blocks: [{ kind: "code", text, evidenceHandles: ["K1"] }] }, context);
    expect(result).toMatchObject({ kind: "accepted", value: { blocks: [{ text }] } });
  });

  it("does not accept a provider-supplied block identity or a changed replay identity", () => {
    const candidate = draft();
    expect(validateKnowledgeEvidenceAnswerDraftV1(candidate, context).kind).toBe("rejected");
    expect(decodeKnowledgeEvidenceAnswerDraftV1({ ...candidate, blocks: [{ ...candidate.blocks[0], id: "B2" }] }, context)).toBeNull();
  });

  it("delivers the complete evidence text once to each operation", () => {
    const evidenceManifest = "Unique neutral evidence excerpt: record Delta is 19 units.";
    const input = { evidenceManifest, request: "What is Delta's value?", draft: draft(), availableSourceAliases: ["S1"] };
    for (const prompt of [knowledgeEvidenceAnswerDraftPromptV1(input), knowledgeEvidenceAnswerReviewPromptV1(input)]) {
      expect(prompt.userPrompt.split(evidenceManifest)).toHaveLength(2);
      expect(JSON.parse(prompt.userPrompt).evidenceManifest).toBe(evidenceManifest);
    }
  });
});
