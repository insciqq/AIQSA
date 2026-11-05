import { describe, expect, it } from "vitest";
import { researchAnswerText, researchPartialClaimsNote } from "./notes";

describe("a source's narrower support in the answer", () => {
  it("names the facts by the server's labels, never the claim's or the checker's words, and without a technical verdict label", () => {
    const note = researchPartialClaimsNote(["Model X1 — Owner reviews", "Model X1 — Owner reviews"], 5);
    expect(note).toBe("The sources establish only part of what this report says about these facts, so rely only on what they state: Model X1 — Owner reviews.");
    expect(researchAnswerText("Report.", [note!, note!])).toBe(`Report.\n\n---\n\n*${note}*`);
    expect(note).not.toMatch(/partly|not checked|not verified|not_verified/u);
  });

  it("is one line however many facts, and says so when some have no label", () => {
    expect(researchPartialClaimsNote([], 5)).toBeNull();
    expect(researchPartialClaimsNote([null], 5)).toBe("The sources establish only part of some facts behind the options this report recommends, so rely only on what they state.");
    expect(researchPartialClaimsNote(["A — x", "B — y", null], 1)).toBe("The sources establish only part of what this report says about these facts, so rely only on what they state: A — x; and others.");
  });
});
