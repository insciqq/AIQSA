import { describe, expect, it } from "vitest";
import { researchAnswerText, researchPartialClaimNote } from "./notes";

describe("a source's narrower support in the answer", () => {
  it("names the claim and what the source establishes, without a technical verdict label", () => {
    const note = researchPartialClaimNote({ claim: "The review concerns Model X1.", label: "Model X1 — Owner reviews", reason: "An owner reports sagging, but names no model." });
    expect(note).toBe("For Model X1 — Owner reviews, the source supports less than the claim “The review concerns Model X1”: An owner reports sagging, but names no model. The conclusion is limited to what the source establishes.");
    expect(researchAnswerText("Report.", [note, note])).toBe(`Report.\n\n---\n\n*${note}*`);
    expect(note).not.toMatch(/partly|not checked|not verified|not_verified/u);
  });

  it("renders model-written limitations as plain text, including when the matrix label or reason is absent", () => {
    const note = researchPartialClaimNote({ claim: "**Exact model**", label: "[Row](https://example.test)", reason: "![Image](https://example.test/image)\n<script>bad</script> _words_" });
    expect(note).not.toMatch(/[\n*_`[\]<>|]/u);
    expect(researchPartialClaimNote({ claim: "An exact model.", label: null, reason: "" })).toBe("The source supports less than the claim “An exact model”. The conclusion is limited to what the source establishes.");
  });
});
