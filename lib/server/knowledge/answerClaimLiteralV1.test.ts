import { describe, expect, it } from "vitest";
import { escapeKnowledgeAnswerLiteralV2, validateKnowledgeAnswerLiteralDraftV1, validateKnowledgeAnswerDraftV7,
  KNOWLEDGE_ANSWER_DRAFT_LIMITS } from "./answerGroundingV5";

const authority = { availableHandles: ["K1"], forbiddenIdentityFragments: ["private-source-token"] };
const draft = (text: unknown, citationHints = ["K1"]) => ({ version: 1, claims: [{ text, citationHints }] });

describe("literal Knowledge claim text", () => {
  it.each(["__entry__", "The __slot__ field is present.", "Container<Item> contains one value.",
    "The exact token is `entry`.", "The marker is **pending**.", "The marker is ~~pending~~."])(
    "preserves punctuation as literal data: %s", (text) => {
      const accepted = validateKnowledgeAnswerLiteralDraftV1(draft(text), authority);
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind === "accepted") expect(accepted.value.claims[0]!.text).toBe(text);
      expect(validateKnowledgeAnswerDraftV7(draft(text), authority).kind).toBe("rejected");
    });

  it.each([
    ["Known value [K1].", "draft_claim_citation_invalid"],
    ["Known value\nAnother value.", "draft_claim_control_character"],
    ["Known\u0000value.", "draft_claim_control_character"],
    ["private-source-token contains the value.", "draft_claim_identity_invalid"],
    ["x".repeat(KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaimCodePoints + 1), "draft_claim_too_long"],
    [" leading space", "draft_claim_text_invalid"],
    [null, "draft_claim_text_invalid"]
  ])("retains text authority checks: %s", (text, reason) => {
    expect(validateKnowledgeAnswerLiteralDraftV1(draft(text), authority)).toEqual({ kind: "rejected", reason });
  });

  it("still rejects unknown or repeated citation hints", () => {
    expect(validateKnowledgeAnswerLiteralDraftV1(draft("__entry__", ["K2"]), authority))
      .toEqual({ kind: "rejected", reason: "draft_unknown_handle" });
    expect(validateKnowledgeAnswerLiteralDraftV1(draft("__entry__", ["K1", "K1"]), authority))
      .toEqual({ kind: "rejected", reason: "draft_duplicate_handle" });
  });

  it("neutralizes inline and multiline presentation while retaining the literal spelling", () => {
    expect(escapeKnowledgeAnswerLiteralV2("__entry__ <Item> &lt;literal&gt; $v$ ~~x~~"))
      .toBe("\\_\\_entry\\_\\_ &lt;Item&gt; &amp;lt;literal&amp;gt; \\$v\\$ \\~\\~x\\~\\~");
    expect(escapeKnowledgeAnswerLiteralV2("1. first\n# heading\n---\na | b\n[key](target)"))
      .toBe("1\\. first\n\\# heading\n\\-\\-\\-\na \\| b\n\\[key\\]\\(target\\)");
  });
});
