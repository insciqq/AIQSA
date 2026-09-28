import { describe, expect, it } from "vitest";
import { assistantKnowledgeWithoutResource } from "./deletionProcessor";

describe("Assistant Knowledge scrub", () => {
  const explicit = { baseIds: ["base-1", "base-2"], mode: "explicit", sourceIds: ["source-1"], version: 1 };

  it("removes only a named resource and keeps the rest", () => {
    expect(assistantKnowledgeWithoutResource(explicit, "base-1", "base")).toEqual({
      baseIds: ["base-2"], mode: "explicit", sourceIds: ["source-1"], version: 1
    });
    expect(assistantKnowledgeWithoutResource(
      { baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1 }, "source-1", "source"
    )).toEqual({ baseIds: [], mode: "none", sourceIds: [], version: 1 });
  });

  it("leaves inherit, None and selections without the resource untouched", () => {
    for (const value of [
      { mode: "inherit" },
      { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      explicit,
      // Stored JSON returns keys in its own order; it is not a reason to rewrite.
      { mode: "explicit", baseIds: ["base-2"], version: 1, sourceIds: [] }
    ]) {
      expect(assistantKnowledgeWithoutResource(value, "base-3", "base")).toBeNull();
    }
    expect(assistantKnowledgeWithoutResource({ mode: "inherit" }, "source-1", "source")).toBeNull();
  });
});
