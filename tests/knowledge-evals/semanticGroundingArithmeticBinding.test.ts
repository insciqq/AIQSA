import { createHash } from "node:crypto";
import { segmentKnowledgeSemanticClaims } from "../../lib/server/knowledge/semanticGrounding";
import {
  auditKnowledgeSemanticArithmeticBindings,
  createKnowledgeSemanticArithmeticBinding,
  verifyKnowledgeSemanticArithmeticBinding
} from "./semanticGroundingArithmeticBinding";
import { knowledgeSemanticGroundingFixtures } from "./semanticGroundingFixtures";

function claimSha256(claim: ReturnType<typeof segmentKnowledgeSemanticClaims>[number]): string {
  return createHash("sha256").update(JSON.stringify({
    answerEnd: claim.answerEnd,
    answerStart: claim.answerStart,
    context: claim.context,
    ordinal: claim.ordinal,
    sourceShape: claim.sourceShape,
    text: claim.text,
    type: claim.type
  }), "utf8").digest("hex");
}

function bindings() {
  return knowledgeSemanticGroundingFixtures.flatMap((fixture) => {
    const claims = new Map(segmentKnowledgeSemanticClaims({
      answer: fixture.answer,
      evidence: fixture.evidence
    }).map((claim) => [claim.ordinal, claim] as const));
    return fixture.arithmeticPlans.map((plan) => {
      const claim = claims.get(plan.claimOrdinal);
      if (!claim || claim.type !== "derived_arithmetic") {
        throw new Error("arithmetic_test_claim_missing");
      }
      const digest = claimSha256(claim);
      return Object.freeze({
        binding: createKnowledgeSemanticArithmeticBinding({
          claimSha256: digest,
          evidencePackage: fixture.evidence,
          plan
        }),
        claimSha256: digest,
        evidencePackage: fixture.evidence,
        fixtureId: fixture.id
      });
    });
  });
}

describe("Knowledge semantic arithmetic corpus binding", () => {
  it("routes every derived-arithmetic claim through the production receipt verifier", () => {
    const corpusBindings = bindings();
    const audit = auditKnowledgeSemanticArithmeticBindings(corpusBindings);

    expect(audit).toEqual({
      aggregateOnly: true,
      bindingVersion: "knowledge-semantic-arithmetic-binding-v1",
      contradictedByRecomputation: 33,
      failed: 0,
      passed: true,
      productionReceiptVersion: "knowledge-semantic-arithmetic-receipt-v1",
      productionVerifierUsed: true,
      receiptCount: 70,
      verified: 37
    });
    expect(JSON.stringify(audit)).not.toMatch(
      /Operation|Операция|manifest|манифест|sourceId|claimSha256|receiptSha256/u
    );
  });

  it("binds the receipt to the exact claim and immutable Source tuple", () => {
    const corpusBindings = bindings();
    const supported = corpusBindings.find((entry) =>
      verifyKnowledgeSemanticArithmeticBinding(entry).verified);
    if (!supported) throw new Error("arithmetic_test_supported_binding_missing");
    const first = supported.evidencePackage.items[0]!;
    const changedEvidence = Object.freeze({
      ...supported.evidencePackage,
      items: Object.freeze([
        Object.freeze({ ...first, sourceArtifactId: `${first.sourceArtifactId}-changed` }),
        ...supported.evidencePackage.items.slice(1)
      ])
    });

    expect(verifyKnowledgeSemanticArithmeticBinding({
      ...supported,
      claimSha256: "f".repeat(64)
    })).toEqual({ code: "authoritative_binding_mismatch", verified: false });
    expect(verifyKnowledgeSemanticArithmeticBinding({
      ...supported,
      evidencePackage: changedEvidence
    })).toEqual({ code: "authoritative_binding_mismatch", verified: false });
  });

  it("uses a structured range when the evidence carries an exact workbook locator", () => {
    const structured = bindings().find((entry) => entry.fixtureId === "held-en-arithmetic");
    expect(structured?.binding.receipt.specification.inputs).toHaveLength(3);
    expect(structured?.binding.receipt.specification.inputs.every((input) =>
      input.locator.kind === "structured_range" && input.locator.range === "B2:B4")).toBe(true);
  });
});
