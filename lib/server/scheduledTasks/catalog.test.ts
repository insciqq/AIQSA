import { describe, expect, it } from "vitest";
import { resolveScheduledTaskModel, type ScheduledTaskCatalog } from "./catalog";

const catalog: ScheduledTaskCatalog = {
  models: [
    { modelId: "model-a", provider: "connection-a", searchStrategyIds: ["off", "gemini", "web"] },
    { modelId: "model-a", provider: "connection-b", searchStrategyIds: ["off"] }
  ],
  searchStrategies: [
    { kind: "none", strategyId: "off" }, { kind: "web_search", strategyId: "web" }, { kind: "gemini_google_search", strategyId: "gemini" }
  ]
};

describe("scheduled task model admission", () => {
  it("admits only the exact catalog identity and lists its concrete Search options", () => {
    expect(resolveScheduledTaskModel(catalog, { modelId: "model-a", provider: "connection-a", searchEnabled: true }))
      .toEqual({ ok: true, searchOptionIds: ["gemini", "web"] });
    expect(resolveScheduledTaskModel(catalog, { modelId: "model-a", provider: "connection-c", searchEnabled: false }))
      .toEqual({ ok: false, code: "scheduled_task_model_unavailable" });
    expect(resolveScheduledTaskModel(null, { modelId: "model-a", provider: "connection-a", searchEnabled: false }))
      .toEqual({ ok: false, code: "scheduled_task_model_unavailable" });
  });

  it("requires a concrete Search option only when Search is requested", () => {
    const plain = { modelId: "model-a", provider: "connection-b" };
    expect(resolveScheduledTaskModel(catalog, { ...plain, searchEnabled: false })).toEqual({ ok: true, searchOptionIds: [] });
    expect(resolveScheduledTaskModel(catalog, { ...plain, searchEnabled: true }))
      .toEqual({ ok: false, code: "scheduled_task_search_unavailable" });
  });
});
