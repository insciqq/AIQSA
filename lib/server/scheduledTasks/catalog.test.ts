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
const standard = { kind: "standard", toolsEnabled: false, workspaceEnabled: false } as const;

describe("scheduled task model admission", () => {
  it("admits only the exact catalog identity and lists its concrete Search options", () => {
    expect(resolveScheduledTaskModel(catalog, { ...standard, modelId: "model-a", provider: "connection-a", searchEnabled: true }))
      .toEqual({ ok: true, searchOptionIds: ["gemini", "web"] });
    expect(resolveScheduledTaskModel(catalog, { ...standard, modelId: "model-a", provider: "connection-c", searchEnabled: false }))
      .toEqual({ ok: false, code: "scheduled_task_model_unavailable" });
    expect(resolveScheduledTaskModel(null, { ...standard, modelId: "model-a", provider: "connection-a", searchEnabled: false }))
      .toEqual({ ok: false, code: "scheduled_task_model_unavailable" });
  });

  it("requires a concrete Search option only when Search is requested", () => {
    const plain = { ...standard, modelId: "model-a", provider: "connection-b" };
    expect(resolveScheduledTaskModel(catalog, { ...plain, searchEnabled: false })).toEqual({ ok: true, searchOptionIds: [] });
    expect(resolveScheduledTaskModel(catalog, { ...plain, searchEnabled: true }))
      .toEqual({ ok: false, code: "scheduled_task_search_unavailable" });
  });

  it("allows tools and Workspace only with a model that calls tools, as the composer does", () => {
    const tooling = { kind: "standard", modelId: "model-a", provider: "connection-a", searchEnabled: false } as const;
    expect(resolveScheduledTaskModel(catalog, { ...tooling, toolsEnabled: true, workspaceEnabled: true }))
      .toEqual({ ok: true, searchOptionIds: ["gemini", "web"] });
    const plain = { ...tooling, provider: "connection-b" };
    expect(resolveScheduledTaskModel(catalog, { ...plain, toolsEnabled: true, workspaceEnabled: false }))
      .toEqual({ ok: false, code: "scheduled_task_tools_unavailable" });
    expect(resolveScheduledTaskModel(catalog, { ...plain, toolsEnabled: false, workspaceEnabled: true }))
      .toEqual({ ok: false, code: "scheduled_task_workspace_unavailable" });
  });

  it("admits a monitoring task only with a model that can call its reporting tool", () => {
    const monitoring = { ...standard, kind: "monitoring", modelId: "model-a", searchEnabled: false } as const;
    expect(resolveScheduledTaskModel(catalog, { ...monitoring, provider: "connection-a" })).toEqual({ ok: true, searchOptionIds: ["gemini", "web"] });
    expect(resolveScheduledTaskModel(catalog, { ...monitoring, provider: "connection-b" }))
      .toEqual({ ok: false, code: "scheduled_task_model_cannot_report" });
    // The same model stays fine for a standard task.
    expect(resolveScheduledTaskModel(catalog, { ...monitoring, kind: "standard", provider: "connection-b" }).ok).toBe(true);
  });
});
