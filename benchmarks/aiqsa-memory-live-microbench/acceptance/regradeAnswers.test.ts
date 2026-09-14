import { describe, expect, it } from "vitest";
import { uniqueStoredProbeAnswer } from "./regradeAnswers";

const content = (text: string) => ({ blocks: [{ type: "text", text }] });
const run = { id: "original-run", status: "complete", userMessage: { content: content("Which city?") },
  assistantMessage: { status: "complete", content: content("York") } };

describe("regrading original answers", () => {
  it("uses the exact original question and never substitutes another response", () => {
    expect(uniqueStoredProbeAnswer("Which city?", [run])).toEqual({ runId: "original-run", answer: "York" });
    expect(() => uniqueStoredProbeAnswer("Which train?", [run])).toThrow("probe_ambiguous");
    expect(() => uniqueStoredProbeAnswer("Which city?", [run, { ...run, id: "reroll" }])).toThrow("probe_ambiguous");
  });
  it("rejects unfinished or missing original answers", () => {
    expect(() => uniqueStoredProbeAnswer("Which city?", [{ ...run, status: "error" }])).toThrow("probe_ambiguous");
    expect(() => uniqueStoredProbeAnswer("Which city?", [{ ...run, assistantMessage: null }])).toThrow("probe_ambiguous");
    expect(() => uniqueStoredProbeAnswer("Which city?", [{ ...run, assistantMessage: { status: "complete", content: content("") } }])).toThrow("answer_missing");
  });
});
