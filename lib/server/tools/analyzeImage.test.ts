import { describe, expect, it } from "vitest";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import { analyzeConversationImageTool, analyzeImageTool, analyzeImageTools, visionAnalysisGuidance, visionAnalysisTimeoutMs } from "./analyzeImage";

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
  it("addresses conversation images by image_id with the Workspace bounds and no paths", () => {
    const chat = analyzeConversationImageTool();
    const workspace = analyzeImageTool({ version: 1, available: false, code: "vision_model_absent" });
    expect(chat).toMatchObject({ name: "analyze_image", capability: "vision", strict: false });
    const items = (schema: Record<string, unknown>) =>
      ((schema.properties as Record<string, { items: Record<string, unknown> }>).images.items);
    expect(items(chat.inputSchema)).toMatchObject({ required: ["image_id"], properties: { image_id: { maxLength: 128 } } });
    expect(Object.keys(items(chat.inputSchema).properties as object)).toEqual(["image_id", "crop", "resize"]);
    // Crop, resize and question bounds are shared exactly; only the identity differs.
    const { image_id: _id, ...chatBounds } = items(chat.inputSchema).properties as Record<string, unknown>;
    const { path: _path, ...workspaceBounds } = items(workspace.inputSchema).properties as Record<string, unknown>;
    expect(chatBounds).toEqual(workspaceBounds);
    expect((chat.inputSchema.properties as Record<string, unknown>).question)
      .toEqual((workspace.inputSchema.properties as Record<string, unknown>).question);
    expect(chat.description).toContain("image_id");
    expect(chat.description).not.toContain("/workspace/");
  });
  it("admits the Workspace form with a Workspace and the chat form otherwise", () => {
    const plan = { version: 1, available: true } as unknown as AvailableVisionAnalysisPlan;
    expect(analyzeImageTools({})).toEqual([]);
    expect(analyzeImageTools({ visionAnalysis: plan }).map((tool) => tool.capability)).toEqual(["vision"]);
    expect(analyzeImageTools({ visionAnalysis: plan, workspace: { enabled: true } }).map((tool) => tool.capability)).toEqual(["workspace"]);
  });
  it("waits by the effective reasoning effort, keeping the base bound for low and unknown efforts", () => {
    const timeout = (reasoningEffort: string | null,
      model: { defaultParams?: Record<string, unknown>; defaultReasoningEffort?: string; reasoning?: boolean } = {}) =>
      visionAnalysisTimeoutMs({ reasoningEffort, snapshot: { model: { defaultParams: model.defaultParams ?? {},
        capabilities: { defaultReasoningEffort: model.defaultReasoningEffort, reasoning: model.reasoning } } } } as unknown as AvailableVisionAnalysisPlan);
    expect(["none", "minimal", "low"].map(effort => timeout(effort))).toEqual([60_000, 60_000, 60_000]);
    expect(timeout("medium")).toBe(120_000);
    expect(["high", "xhigh", "max"].map(effort => timeout(effort))).toEqual([180_000, 180_000, 180_000]);
    // Unknown names, including inherited object keys, never stretch the bound.
    expect(["turbo", "constructor", "__proto__"].map(effort => timeout(effort))).toEqual([60_000, 60_000, 60_000]);
    // Unset: the frozen effort wins over defaults; otherwise configured params, then the declared model default.
    expect(timeout("low", { defaultReasoningEffort: "high" })).toBe(60_000);
    // No effort anywhere: the provider's own default applies, unless the model does not reason.
    expect(timeout(null)).toBe(120_000);
    expect(timeout(null, { reasoning: false })).toBe(60_000);
    expect(timeout(null, { defaultReasoningEffort: "medium" })).toBe(120_000);
    expect(timeout(null, { defaultParams: { reasoning: { effort: "high" } }, defaultReasoningEffort: "low" })).toBe(180_000);
    expect(timeout(null, { defaultParams: { outputConfig: { effort: "xhigh" } } })).toBe(180_000);
    expect(timeout(null, { defaultParams: { reasoning: { enabled: true } }, defaultReasoningEffort: "medium" })).toBe(120_000);
  });
});
