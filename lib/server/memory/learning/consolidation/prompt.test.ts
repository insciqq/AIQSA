import { describe, expect, it } from "vitest";
import {
  MEMORY_FACT_CONSOLIDATION_PROMPT_VERSION,
  MEMORY_FACT_VERIFICATION_PROMPT_VERSION
} from "./contract";
import {
  MEMORY_FACT_CONSOLIDATION_SYSTEM_PROMPT,
  MEMORY_FACT_VERIFICATION_SYSTEM_PROMPT
} from "./prompt";

describe("Memory fact consolidation prompt", () => {
  it("requires exact identifiers and a deterministic empty-related comparison", () => {
    expect(MEMORY_FACT_CONSOLIDATION_PROMPT_VERSION)
      .toBe("memory-fact-consolidation-prompt-v2");
    expect(MEMORY_FACT_CONSOLIDATION_SYSTEM_PROMPT)
      .toContain("Copy candidate.id to candidate_id");
    expect(MEMORY_FACT_CONSOLIDATION_SYSTEM_PROMPT)
      .toContain("When related_facts is empty, comparison must be DIFFERENT");
  });
});

describe("Memory fact verification prompt", () => {
  it("treats an exact direct-user subjective statement as sufficient support", () => {
    expect(MEMORY_FACT_VERIFICATION_PROMPT_VERSION)
      .toBe("memory-fact-verification-prompt-v2");
    expect(MEMORY_FACT_VERIFICATION_SYSTEM_PROMPT)
      .toContain("one exact direct-user statement is sufficient support");
    expect(MEMORY_FACT_VERIFICATION_SYSTEM_PROMPT)
      .toContain("scope, time, authority order");
  });
});
