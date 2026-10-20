import { describe, expect, it } from "vitest";
import {
  REASONING_HEADING_MAX_CHARACTERS,
  boundReasoningHeading,
  createReasoningHeadingTracker,
  decodeReasoningHeading,
  reasoningHeadingEvent,
  reasoningParagraphHeading
} from "./reasoningHeading";

function feed(tracker: ReturnType<typeof createReasoningHeadingTracker>, deltas: readonly string[]): (string | null)[] {
  return deltas.map((delta) => tracker.append(delta));
}

describe("reasoning headings", () => {
  it("bounds a heading to one plain line without invisible formatting", () => {
    expect(boundReasoningHeading("  Checking\n\tthe   diagonals  ")).toBe("Checking the diagonals");
    expect(boundReasoningHeading("Safe\u202e txet\u200b label\u0007")).toBe("Safe txet label");
    expect(boundReasoningHeading(" \n ")).toBeNull();
    expect(boundReasoningHeading(42)).toBeNull();
    const long = boundReasoningHeading(`${"a".repeat(78)}😀 tail`);
    expect(long).toBe(`${"a".repeat(78)}…`);
    expect(long!.length).toBeLessThanOrEqual(REASONING_HEADING_MAX_CHARACTERS);
    expect(boundReasoningHeading("x".repeat(200))).toHaveLength(REASONING_HEADING_MAX_CHARACTERS);
  });

  it("takes a summary part's bold title, else the first sentence or line", () => {
    expect(reasoningParagraphHeading("**Setting up queen enumeration**")).toEqual({
      complete: true, heading: "Setting up queen enumeration"
    });
    expect(reasoningParagraphHeading("**Проверяю подсчёт диагоналей**\n\nСчитаю пары.")).toEqual({
      complete: true, heading: "Проверяю подсчёт диагоналей"
    });
    expect(reasoningParagraphHeading("**Setting up")).toEqual({ complete: false, heading: null });
    expect(reasoningParagraphHeading("**Setting up", true)).toEqual({ complete: true, heading: "Setting up" });
    expect(reasoningParagraphHeading("The user wants **eight** queens. Let me count")).toEqual({
      complete: true, heading: "The user wants eight queens"
    });
    expect(reasoningParagraphHeading("Is version 2.5 enough? Maybe")).toEqual({
      complete: true, heading: "Is version 2.5 enough?"
    });
    expect(reasoningParagraphHeading("## Plan\nFirst list the rows")).toEqual({ complete: true, heading: "Plan" });
    expect(reasoningParagraphHeading("先检查对角线。然后")).toEqual({ complete: true, heading: "先检查对角线。" });
    expect(reasoningParagraphHeading("Considering the board")).toEqual({ complete: false, heading: null });
    expect(reasoningParagraphHeading("Considering the board.", true)).toEqual({ complete: true, heading: "Considering the board" });
    const running = reasoningParagraphHeading(`Considering ${"every row ".repeat(12)}`);
    expect(running.complete).toBe(true);
    expect(running.heading).toMatch(/^Considering every row .*…$/u);
    expect(reasoningParagraphHeading("   ", true)).toEqual({ complete: true, heading: null });
  });

  it("reports one heading per summary part, even when its title arrives in pieces", () => {
    const parts = createReasoningHeadingTracker({ paragraphs: false });
    expect(feed(parts, ["**Setting up queen enumeration**"])).toEqual(["Setting up queen enumeration"]);
    expect(parts.finish()).toBeNull();
    expect(feed(parts, ["**Checking", " diagonals**", "\n\nCounting each pair. Then rows."]))
      .toEqual([null, "Checking diagonals", null]);
    expect(parts.finish()).toBeNull();
    // A part that never closes its title is named by its whole text when it ends.
    expect(feed(parts, ["Short note"])).toEqual([null]);
    expect(parts.finish()).toBe("Short note");
    // The same title again is not reported twice in a row.
    expect(feed(parts, ["Short note."])).toEqual([null]);
    expect(parts.finish()).toBeNull();
  });

  it("reports each thinking paragraph's opening once, across split paragraph breaks", () => {
    const thinking = createReasoningHeadingTracker({ paragraphs: true });
    expect(feed(thinking, [
      "The user wants the count of",
      " solutions. I should enumerate.\n",
      "\nNext I need to verify",
      " the diagonals",
      ".\n\nFinally",
      " compare with the known value"
    ])).toEqual([
      null,
      "The user wants the count of solutions",
      null,
      null,
      "Next I need to verify the diagonals",
      null
    ]);
    expect(thinking.finish()).toBe("Finally compare with the known value");
    // Several paragraphs settled by one delta report only the latest.
    expect(thinking.append("One.\n\nTwo.\n\nThree is still")).toBe("Two");
    expect(thinking.finish()).toBe("Three is still");
  });

  it("keeps only the opening of a long paragraph and still finds the next one", () => {
    const thinking = createReasoningHeadingTracker({ paragraphs: true });
    const headings = feed(thinking, [...Array.from({ length: 200 }, () => "very long reasoning "), "\n\nShort next step. More"]);
    expect(headings.filter(Boolean)).toEqual([`${"very long reasoning ".repeat(4).slice(0, 79).trimEnd()}…`, "Short next step"]);
  });

  it("carries a bounded heading on the live stream as a lifecycle summary only", () => {
    const event = reasoningHeadingEvent("Checking diagonals");
    expect(event).toEqual({ data: { artifactType: "summary", payload: {
      heading: "Checking diagonals", stage: "reasoning", status: "running"
    } }, type: "artifact" });
    expect(decodeReasoningHeading(event.type === "artifact" ? event.data.payload : null)).toBe("Checking diagonals");
    expect(decodeReasoningHeading({ heading: `  ${"y".repeat(120)}\n`, stage: "reasoning", status: "running" }))
      .toHaveLength(REASONING_HEADING_MAX_CHARACTERS);
    for (const payload of [null, [], { heading: "x", stage: "model", status: "running" },
      { heading: "x", stage: "reasoning" }, { heading: 7, stage: "reasoning", status: "running" },
      { heading: " ", stage: "reasoning", status: "running" }]) {
      expect(decodeReasoningHeading(payload)).toBeNull();
    }
  });
});
