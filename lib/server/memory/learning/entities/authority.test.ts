import { describe, expect, it } from "vitest";
import { memoryAdmissibleEntityAliasPredicate } from "./authority";

describe("memoryAdmissibleEntityAliasPredicate", () => {
  it("finds each support's own version before running the costly authority on it", () => {
    const text = memoryAdmissibleEntityAliasPredicate("user-1").text;
    // Evidence support: the fenced lookup names its row by id first.
    expect(text).toMatch(/support\."id" = alias_support\."evidenceId"[\s\S]*?OFFSET 0\s*\) AS admitted/u);
    expect(text).toMatch(/\) AS admitted[\s\S]*?WHERE[\s\S]*?aiqsa_memory_fact_dependencies_valid[\s\S]*?OFFSET 0/u);
    // Fact-version support: the same fence.
    expect(text).toMatch(/version\."id" = alias_support\."factVersionId"[\s\S]*?OFFSET 0\s*\) AS version\s*WHERE/u);
    expect(text.match(/OFFSET 0/gu)).toHaveLength(4);
  });
});
