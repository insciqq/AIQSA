import { describe, expect, it } from "vitest";
import { decodeKnowledgeAnswerDraftV21 } from "./answerGroundingV21";
import { buildKnowledgePublicationPlanV1, settleKnowledgeAnswerV22, validateKnowledgeGroundedSelectorV22 } from "./answerGroundingSelectorV22";
import { applyKnowledgeCoverageScopeClosureV3, validateKnowledgeCoverageScopeClosureV3 } from "./coverageScopeClosureV3";
import {
  KNOWLEDGE_EMPTY_SCOPE_OVERFLOW_V1,
  validateDecodedKnowledgeCoverageScopeV7,
  validateKnowledgeCoverageScopeCompletenessV2,
  validateKnowledgeCoverageScopeV7
} from "./coverageScopeV7";

function fixture(count = 9, pendingCount = 0) {
  const names = Array.from({ length: count }, (_, index) => `item${index + 1}`);
  const input = { evidence: [{ exactExcerpt: names.map((name, index) => `${name}\t${index + 1} kg`).join("\n"), handle: "K1" }],
    request: `Report ${names.join(", ")}.` };
  const task = (index: number) => ({ description: `Report ${names[index]}'s value.`, requestAnchor: names[index]! });
  const output = { evidenceUnits: [{ handle: "K1", findings: names.slice(0, 8).map((_, index) => ({
    ...task(index), evidenceAtomIds: [`A${index + 1}`]
  })) }], jointFindings: [], unsupportedDimensions: [], version: 7,
  overflow: { pending: names.slice(8, 8 + pendingCount).map((_, index) => task(index + 8)), unparsedRemainder: false, version: 1 } };
  const accepted = validateKnowledgeCoverageScopeV7(output, input);
  if (accepted.kind !== "accepted") throw new Error(accepted.reason);
  return { input, output, scope: accepted.value, task };
}

describe("bounded Scope requirement overflow", () => {
  it("admits eight independent requirements without a fictitious overflow", () => {
    const { input, scope } = fixture(8);
    expect(scope.scope).toHaveLength(8);
    expect(scope.overflow).toEqual(KNOWLEDGE_EMPTY_SCOPE_OVERFLOW_V1);
    expect(validateDecodedKnowledgeCoverageScopeV7(JSON.parse(JSON.stringify(scope)), input)).toBe(true);
  });

  it("keeps the ninth known requirement pending with stable identity", () => {
    const { input, scope, task } = fixture(9, 1);
    expect(scope.overflow).toEqual({ pending: [{ ...task(8), id: "P1" }], unparsedRemainder: false, version: 1 });
    expect(validateDecodedKnowledgeCoverageScopeV7(JSON.parse(JSON.stringify(scope)), input)).toBe(true);
    expect(validateDecodedKnowledgeCoverageScopeV7({ ...scope, overflow: { ...scope.overflow,
      pending: [{ ...scope.overflow.pending[0], id: "P2" }] } }, input)).toBe(false);
  });

  it.each([false, true])("keeps pending publication partial even after every admitted dimension closes (analysis incomplete=%s)", (unparsedRemainder) => {
    const current = fixture(9, 1);
    const scope = { ...current.scope, overflow: { ...current.scope.overflow, unparsedRemainder } };
    const draft = decodeKnowledgeAnswerDraftV21({ claims: scope.scope.map((_, index) => ({
      citationHints: ["K1"], text: `item${index + 1} has value ${index + 1} kg.`
    })), version: 1 }, { availableHandles: ["K1"] })!;
    const input = { ...current.input, atomIndexVersion: 3 as const, draft, scope };
    const selection = validateKnowledgeGroundedSelectorV22({ claims: draft.claims.map(({ id }) => ({
      id, supportHandles: ["K1"], verdict: "supported"
    })), coverage: scope.scope.map(({ id }, index) => ({ id, contributionIds: [`C${index + 1}`], status: "covered" })),
    insufficientReason: "not_applicable", version: 2 }, input);
    expect(selection.kind).toBe("accepted");
    if (selection.kind !== "accepted") return;
    const publication = { ...input, selector: selection.value };
    const closure = validateKnowledgeCoverageScopeClosureV3({ decisions: scope.scope.map(({ id }) => ({ id, status: "closed" })), version: 3 }, publication);
    expect(closure.kind).toBe("accepted");
    if (closure.kind !== "accepted") return;
    const closed = { ...publication, selector: applyKnowledgeCoverageScopeClosureV3({ ...publication, closure: closure.value }) };
    const plan = buildKnowledgePublicationPlanV1(closed);
    expect(plan.overflow).toEqual(scope.overflow);
    expect(plan.entries).toHaveLength(8);
    const settled = settleKnowledgeAnswerV22(closed);
    expect(settled).toMatchObject({ requestCoverage: "partial", supportedClaimCount: 8 });
    expect(settled.finalText).toContain("Unprocessed requirement: Report item9");
    expect(settled.finalText.includes("could not be fully analyzed")).toBe(unparsedRemainder);
  });

  it("records a newly discovered ninth requirement without invalidating the eight accepted items", () => {
    const { input, scope, task } = fixture();
    const complete = validateKnowledgeCoverageScopeCompletenessV2({ additions: [], version: 2,
      overflow: { pending: [task(8)], unparsedRemainder: false, version: 1 }
    }, { ...input, acceptedScope: scope });
    expect(complete).toMatchObject({ kind: "accepted", additionCount: 0, scope: {
      scope: scope.scope, overflow: { pending: [{ ...task(8), id: "P1" }] }
    } });
  });

  it("keeps bounded known pending tasks and sticky incomplete-analysis state when their ledger fills", () => {
    const { input, scope, task } = fixture(17, 8);
    const complete = validateKnowledgeCoverageScopeCompletenessV2({ additions: [], version: 2,
      overflow: { pending: [task(16)], unparsedRemainder: false, version: 1 }
    }, { ...input, acceptedScope: scope });
    expect(complete.kind).toBe("accepted");
    if (complete.kind !== "accepted") return;
    expect(complete.scope.scope).toEqual(scope.scope);
    expect(complete.scope.overflow).toEqual({ ...scope.overflow, unparsedRemainder: true });
    const next = validateKnowledgeCoverageScopeCompletenessV2({ additions: [], version: 2,
      overflow: { pending: [], unparsedRemainder: false, version: 1 }
    }, { ...input, acceptedScope: complete.scope });
    expect(next).toMatchObject({ kind: "accepted", scope: complete.scope });
    expect(validateDecodedKnowledgeCoverageScopeV7(JSON.parse(JSON.stringify(complete.scope)), input)).toBe(true);
  });

  it("rejects malformed overflow rather than silently accepting a truncated model payload", () => {
    const { input, output, task } = fixture(18);
    for (const pending of [[{ ...task(8), requestAnchor: "not in request" }], [task(0)],
      [task(8), task(8)], Array.from({ length: 9 }, (_, index) => task(index + 8)),
      [{ ...task(8), description: "x\ny" }], [{ ...task(8), id: "P1" }]]) {
      expect(validateKnowledgeCoverageScopeV7({ ...output, overflow: { ...output.overflow, pending } }, input).kind).toBe("rejected");
    }
  });

  it("retains an inseparable date/value/unit assertion as one supported requirement", () => {
    const input = { evidence: [{ exactExcerpt: "A\t2040-01-01\t10\tkg", handle: "K1" }], request: "Give A's dated measurement." };
    const accepted = validateKnowledgeCoverageScopeV7({ evidenceUnits: [{ handle: "K1", findings: [{
      description: "Give A's measurement with its date and unit.", requestAnchor: "dated measurement", evidenceAtomIds: ["A1"]
    }] }], jointFindings: [], unsupportedDimensions: [], overflow: KNOWLEDGE_EMPTY_SCOPE_OVERFLOW_V1, version: 7 }, input);
    expect(accepted).toMatchObject({ kind: "accepted", value: { scope: [expect.objectContaining({ evidenceAtomIds: ["A1"] })] } });
  });
});
