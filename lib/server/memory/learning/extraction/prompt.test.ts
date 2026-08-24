import { describe, expect, it } from "vitest";
import { memorySha256 } from "../../persistence/lexical";
import { MEMORY_FACT_EXTRACTION_PROMPT_VERSION } from "./contract";
import {
  MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT,
  MEMORY_FACT_EXTRACTION_TOOL_NAME,
  memoryFactExtractionTool
} from "./prompt";

describe("Memory vNext extraction prompt contract", () => {
  it("locks the complete forced-strict schema and policy snapshot", () => {
    expect(MEMORY_FACT_EXTRACTION_PROMPT_VERSION)
      .toBe("memory-fact-extraction-prompt-v11");
    expect(memoryFactExtractionTool).toMatchObject({
      name: "submit_memory_fact_observations_v4",
      strict: true
    });
    expect(MEMORY_FACT_EXTRACTION_TOOL_NAME)
      .toBe("submit_memory_fact_observations_v4");
    expect(memorySha256({
      prompt: MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT,
      tool: memoryFactExtractionTool
    })).toBe("4d9864acea2d0ebae4bf9dbc386b88ca4e9f68a5f592bb039b2064fecea30d2e");
  });

  it("states the direct-user, ownership, dependency, TTL and no-rationale rules", () => {
    for (const rule of [
      "target_message is the only evidence",
      "directly stated stable name",
      "Positive self-name anchor",
      "Explicit stable first-person preferences",
      "Positive response-preference anchor",
      "Preserve a user-defined format or style name",
      "Assistant, tool, web, file, Knowledge",
      "work, borrowed or shared device is never owned",
      "supplied opaque ref in dependency_refs",
      "Pronouns are never aliases",
      "expires_at may be proposed only",
      "no prose or hidden rationale"
    ]) {
      expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).toContain(rule);
    }
  });
});
