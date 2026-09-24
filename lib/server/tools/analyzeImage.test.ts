import { describe, expect, it } from "vitest";
import { analyzeImageTool, visionAnalysisGuidance } from "./analyzeImage";

describe("System Vision tool contract", () => {
  it("advertises bounded ordered comparisons and exact missing capability", () => {
    const tool = analyzeImageTool({ version: 1, available: false, code: "vision_model_absent" });
    expect(tool.name).toBe("analyze_image"); expect(tool.capability).toBe("workspace");
    expect(tool.inputSchema).toMatchObject({ properties: { images: { minItems: 1, maxItems: 8 }, question: { maxLength: 4000 } } });
    expect(tool.description).toContain("unassigned"); expect(tool.description).toContain("ordered exactly");
  });
  it("uses direct-first only when an actual direct path is admitted", () => {
    const plan = { version: 1, available: false, code: "vision_model_absent" } as const;
    expect(visionAnalysisGuidance(plan, false)).toContain("Direct image viewing is unavailable");
    expect(visionAnalysisGuidance(plan, true)).toContain("direct image viewer first");
    expect(visionAnalysisGuidance(plan, true)).toContain("do not automatically send every image to two models");
  });
});
