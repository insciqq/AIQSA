import { describe, expect, it } from "vitest";
import { knowledgeCoverageRequestAnchorIndexV1, resolveKnowledgeCoverageRequestAnchorIdsV1 } from "./coverageScopeRequestAnchorIdsV1";
import { knowledgeCoverageRequestAnchorIndexV2 } from "./coverageScopeRequestAnchorIdsV2";
import { validateKnowledgeCoverageScopeV7, KNOWLEDGE_EMPTY_SCOPE_OVERFLOW_V1 } from "./coverageScopeV7";

describe("control-free Scope request anchors", () => {
  it("makes every offered multiline anchor valid under the unchanged Scope validator", () => {
    const request = Array.from({ length: 12 }, (_, index) => `Explain item${index + 1} and preserve its exact dated value.`).join("\n\t");
    const old = knowledgeCoverageRequestAnchorIndexV1(request);
    expect(old.items.some(({ text }) => /\p{Cc}/u.test(text))).toBe(true);
    const index = knowledgeCoverageRequestAnchorIndexV2(request);
    expect(index.version).toBe(2);
    expect(index.items).toHaveLength(12);
    for (const anchor of index.items) {
      expect(request).toContain(anchor.text);
      expect(anchor.text).not.toMatch(/\p{Cc}/u);
      const output = resolveKnowledgeCoverageRequestAnchorIdsV1({ version: 7,
        evidenceUnits: [{ handle: "K1", findings: [] }], jointFindings: [],
        unsupportedDimensions: [{ description: "Explain the requested value.", requestAnchor: anchor.id }],
        overflow: KNOWLEDGE_EMPTY_SCOPE_OVERFLOW_V1
      }, request, index);
      expect(validateKnowledgeCoverageScopeV7(output, { request,
        evidence: [{ handle: "K1", exactExcerpt: "An unrelated note." }] }).kind).toBe("accepted");
    }
    expect(knowledgeCoverageRequestAnchorIndexV1(request)).toEqual(old);
  });

  it.each([
    "界".repeat(1_101),
    Array.from({ length: 150 }, (_, index) => `item${index + 1}`).join("\r\n"),
    "Start\u0000middle\tend",
    Array.from({ length: 400 }, () => "bounded word").join(" ")
  ])("bounds exact Unicode spans without offering control characters", (request) => {
    const index = knowledgeCoverageRequestAnchorIndexV2(request);
    expect(index.items.length).toBeGreaterThan(0);
    expect(index.items.length).toBeLessThanOrEqual(64);
    expect(new Set(index.items.map(({ text }) => text)).size).toBe(index.items.length);
    for (const [ordinal, item] of index.items.entries()) {
      expect(item.id).toBe(`Q${ordinal + 1}`);
      expect([...item.text].length).toBeLessThanOrEqual(500);
      expect(item.text).not.toMatch(/\p{Cc}/u);
      expect(request).toContain(item.text);
    }
    expect(request.endsWith(index.items.at(-1)!.text)).toBe(true);
    expect(resolveKnowledgeCoverageRequestAnchorIdsV1({ requestAnchor: "Q999" }, request, index))
      .toEqual({ requestAnchor: "Q999" });
  });
});
