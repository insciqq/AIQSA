import { describe, expect, it } from "vitest";
import { resolveScheduledTaskModel, type ScheduledTaskCatalog } from "./catalog";

const catalog: ScheduledTaskCatalog = {
  models: [
    { capabilities: { toolCalling: true }, modelId: "model-a", provider: "connection-a", searchStrategyIds: ["off", "gemini", "web"] },
    { capabilities: { toolCalling: false }, modelId: "model-a", provider: "connection-b", searchStrategyIds: ["off"] }
  ],
  searchStrategies: [
    { kind: "none", strategyId: "off" }, { kind: "web_search", strategyId: "web" }, { kind: "gemini_google_search", strategyId: "gemini" }
  ]
};

const off = { toolsEnabled: false, workspaceEnabled: false } as const;

describe("scheduled task model admission", () => {
  it("admits only the exact catalog identity and lists its concrete Search options", () => {
    expect(resolveScheduledTaskModel(catalog, { ...off, modelId: "model-a", provider: "connection-a", searchEnabled: true }))
      .toEqual({ ok: true, searchOptionIds: ["gemini", "web"] });
    expect(resolveScheduledTaskModel(catalog, { ...off, modelId: "model-a", provider: "connection-c", searchEnabled: false }))
      .toEqual({ ok: false, code: "scheduled_task_model_unavailable" });
    expect(resolveScheduledTaskModel(null, { ...off, modelId: "model-a", provider: "connection-a", searchEnabled: false }))
      .toEqual({ ok: false, code: "scheduled_task_model_unavailable" });
  });

  it("requires a concrete Search option only when Search is requested", () => {
    const plain = { ...off, modelId: "model-a", provider: "connection-b" };
    expect(resolveScheduledTaskModel(catalog, { ...plain, searchEnabled: false })).toEqual({ ok: true, searchOptionIds: [] });
    expect(resolveScheduledTaskModel(catalog, { ...plain, searchEnabled: true }))
      .toEqual({ ok: false, code: "scheduled_task_search_unavailable" });
  });

  it("allows tools and Workspace only with a model that calls tools, as the composer does", () => {
    const tooling = { modelId: "model-a", provider: "connection-a", searchEnabled: false };
    expect(resolveScheduledTaskModel(catalog, { ...tooling, toolsEnabled: true, workspaceEnabled: true }))
      .toEqual({ ok: true, searchOptionIds: ["gemini", "web"] });
    const plain = { ...tooling, provider: "connection-b" };
    expect(resolveScheduledTaskModel(catalog, { ...plain, toolsEnabled: true, workspaceEnabled: false }))
      .toEqual({ ok: false, code: "scheduled_task_tools_unavailable" });
    expect(resolveScheduledTaskModel(catalog, { ...plain, toolsEnabled: false, workspaceEnabled: true }))
      .toEqual({ ok: false, code: "scheduled_task_workspace_unavailable" });
  });
});
