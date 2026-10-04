import type { Catalog } from "@/lib/contracts/catalog";
import type { ScheduledTask } from "@/lib/contracts/scheduledTasks";

/** Synthetic tasks and catalog for scheduled-task component and unit tests. */
export function scheduledTaskFixture(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "Weekday news brief",
    prompt: "Summarize the news.",
    schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    timeZone: "Europe/London",
    modelId: "model-a",
    provider: "provider-a",
    searchEnabled: false,
    emailNotify: false,
    toolsEnabled: false,
    workspaceEnabled: false,
    chatMode: "same",
    status: "active",
    pauseReason: null,
    nextRunAt: "2026-10-06T08:00:00.000Z",
    lastRun: null,
    running: false,
    chatId: null,
    unseenResult: false,
    revision: 1,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides
  };
}

export function scheduledTaskCatalogFixture(): Catalog {
  const capabilities = {
    background: false, documentInputMode: "none" as const, imageInput: false, nativeWebSearch: false,
    openRouterPerplexitySearch: false, reasoning: false, streaming: true, toolCalling: true
  };
  return {
    defaults: {
      controlValues: {}, hasPersonalModelDefault: false, modelId: "model-a", modelPreferenceSource: "none",
      organizationModelDefault: null, personalModelDefault: null, organizationSearchPlan: { mode: "off" } as never,
      provider: "provider-a", searchPlan: { mode: "off" } as never, searchPreferenceSource: "organization",
      showCitations: true, showReasoningBlocks: false
    },
    models: [
      { capabilities, contextWindow: null, defaultParams: {}, displayName: "Model A", modelId: "model-a",
        parameterControls: {} as never, provider: "provider-a", searchStrategyIds: ["web"] },
      { capabilities, contextWindow: null, defaultParams: {}, displayName: "Model B", modelId: "model-b",
        parameterControls: {} as never, provider: "provider-a", searchStrategyIds: [] }
    ],
    providers: [{ id: "provider-a", models: ["model-a", "model-b"], name: "Provider A" }],
    searchStrategies: [{ displayName: "Web", kind: "web_search", strategyId: "web" }]
  };
}
