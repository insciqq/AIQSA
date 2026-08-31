import { describe, expect, it } from "vitest";
import {
  normalizeKnowledgeClaimPayloadV1,
  normalizeKnowledgeClaimSurfaceV1,
  normalizeKnowledgeTargetedSupplementPayloadV2
} from "./answerClaimSurfaceV1";

describe("Knowledge claim presentation recovery", () => {
  it("canonicalizes only harmless provider presentation artifacts", () => {
    expect(normalizeKnowledgeClaimSurfaceV1(
      "\n- **Atlas retains exports for 30 days.** [K2]\n"
    )).toBe("Atlas retains exports for 30 days.");
    expect(normalizeKnowledgeClaimSurfaceV1(
      "`Atlas retains exports for 30 days.`"
    )).toBe("Atlas retains exports for 30 days.");
    expect(normalizeKnowledgeClaimSurfaceV1(
      "Atlas retains exports for 30 days. citeK1K2"
    )).toBe("Atlas retains exports for 30 days.");
  });

  it("leaves ambiguous or semantic markup for the strict validator to reject", () => {
    const values = [
      "- First assertion.\n- Second assertion.",
      "Atlas links to [policy](https://example.test).",
      "Atlas contains <b>formatted</b> content.",
      "Atlas contains a malformed citation citeK1.",
      "Atlas contains\u0007an opaque control."
    ];
    for (const value of values) {
      expect(normalizeKnowledgeClaimSurfaceV1(value)).toBe(value);
    }
  });

  it("preserves object identity unless at least one claim changes", () => {
    const accepted = {
      claims: [{ citationHints: ["K1"], text: "Already plain." }],
      version: 1
    };
    expect(normalizeKnowledgeClaimPayloadV1(accepted)).toBe(accepted);
    expect(normalizeKnowledgeClaimPayloadV1({
      claims: [{ targetDimensionId: "D1", text: "  Recovered. [K1]  " }],
      version: 1
    })).toEqual({
      claims: [{ targetDimensionId: "D1", text: "Recovered." }],
      version: 1
    });
  });

  it("canonicalizes grouped supplement claims without changing target identity", () => {
    const accepted = { targets: { D2: ["Already plain."] }, version: 2 };
    expect(normalizeKnowledgeTargetedSupplementPayloadV2(accepted)).toBe(accepted);
    expect(normalizeKnowledgeTargetedSupplementPayloadV2({
      targets: {
        D2: ["  - **Recovered.** [K2]  "],
        D4: ["Still plain."]
      },
      version: 2
    })).toEqual({
      targets: {
        D2: ["Recovered."],
        D4: ["Still plain."]
      },
      version: 2
    });
  });
});
