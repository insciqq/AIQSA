import { describe, expect, it } from "vitest";
import type { AssistantRowPolicy, AssistantRows } from "../../contracts/assistants";
import type { CatalogWireModel } from "../../contracts/catalog";
import type { ChatAssistantOverridesPatch } from "../../contracts/chats";
import type { SearchStrategyCatalogEntry } from "../../domain/catalog";
import { assistantRowsFromStoredColumns } from "../assistants/storedContent";
import {
  chatAssistantOverridesIssue,
  nextChatAssistantOverrides,
  overridesNeedCatalog,
  projectKnowledgeOverrideAvailable,
  projectOverridesNeedAuthority,
  type ChatAssistantOverrideCatalog
} from "./assistantOverrides";

function model(modelId: string, temperatureSupported: boolean): CatalogWireModel {
  return {
    capabilities: {
      background: false,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: false,
      streaming: true,
      text: true,
      toolCalling: true
    },
    contextWindow: 128_000,
    defaultParams: {},
    displayName: modelId,
    modelId,
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 4_096, maxValue: 8_192 },
      reasoningEffort: { defaultValue: "medium", options: [], supported: false },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: temperatureSupported }
    },
    provider: "connection-1",
    providerFamily: "openai_compatible",
    searchOptionCompatibility: {},
    searchStrategyIds: [],
    upstreamModelId: `upstream-${modelId}`
  };
}

function strategy(strategyId: string): SearchStrategyCatalogEntry {
  return { description: "", displayName: strategyId, kind: "web_search", routes: [], strategyId };
}

const catalog: ChatAssistantOverrideCatalog = {
  defaultModelId: "user-default",
  models: [model("assistant-model", true), model("chat-model", false), model("user-default", true)],
  searchStrategies: [strategy("web-a"), strategy("web-b")]
};

function rows(
  policy: AssistantRowPolicy,
  providerModelId: string | null = "assistant-model"
): AssistantRows {
  const decoded = assistantRowsFromStoredColumns({
    controlsPolicy: "adjustable",
    knowledgePolicy: policy,
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpMode: "off",
    mcpServerIds: [],
    modelPolicy: policy,
    providerModelId,
    runControls: {},
    searchPlan: { mode: "off" },
    searchPolicy: policy,
    skillLinks: [],
    skillsMode: "auto",
    skillsPolicy: policy,
    toolsPolicy: policy
  });
  if (!decoded) throw new Error("fixture rows invalid");
  return decoded;
}

function issue(patch: ChatAssistantOverridesPatch, input: {
  catalog?: ChatAssistantOverrideCatalog | null;
  current?: Parameters<typeof nextChatAssistantOverrides>[0];
  rows?: AssistantRows;
} = {}) {
  return chatAssistantOverridesIssue({
    catalog: input.catalog === undefined ? catalog : input.catalog,
    next: nextChatAssistantOverrides(input.current ?? {}, patch),
    patch,
    rows: input.rows ?? rows("adjustable")
  });
}

describe("chat Assistant overrides", () => {
  it("keeps controls only with the model they were set for", () => {
    const current = { controls: { temperature: 0.2 }, model: { mode: "model" as const, modelId: "chat-model" } };

    expect(nextChatAssistantOverrides(current, { model: { mode: "model", modelId: "user-default" } }))
      .toEqual({ model: { mode: "model", modelId: "user-default" } });
    expect(nextChatAssistantOverrides(current, { model: null })).toEqual({});
    expect(nextChatAssistantOverrides(current, {
      controls: { temperature: 1.5 },
      model: { mode: "model", modelId: "user-default" }
    })).toEqual({ controls: { temperature: 1.5 }, model: { mode: "model", modelId: "user-default" } });
    expect(nextChatAssistantOverrides(current, { controls: null, model: null })).toEqual({});
    // Rows other than the model leave stored controls alone.
    expect(nextChatAssistantOverrides(current, { search: { mode: "off" } }))
      .toEqual({ ...current, search: { mode: "off" } });
    expect(nextChatAssistantOverrides(current, { controls: { temperature: 0.4 } }))
      .toEqual({ ...current, controls: { temperature: 0.4 } });
  });

  it("refuses a value for a fixed row but lets a stale value be cleared", () => {
    for (const patch of [
      { model: { mode: "model", modelId: "chat-model" } },
      { search: { mode: "off" } },
      { tools: { mode: "load_all" } },
      { knowledge: { mode: "none" } },
      { skills: { mode: "off" } }
    ] satisfies ChatAssistantOverridesPatch[]) {
      expect(issue(patch, { rows: rows("fixed") })).toBe("assistant_overrides_not_allowed");
    }
    expect(issue({ model: null, search: null, tools: null }, { rows: rows("fixed") })).toBeNull();
    expect(issue({ tools: { mode: "load_all" }, skills: { mode: "off" } })).toBeNull();
  });

  it("checks model and Search values against the requester's catalog", () => {
    expect(issue({ model: { mode: "model", modelId: "chat-model" } })).toBeNull();
    expect(issue({ model: { mode: "model", modelId: "not-entitled" } })).toBe("assistant_overrides_invalid");
    expect(issue({ search: { mode: "off" } })).toBeNull();
    expect(issue({ search: { mode: "model_choice", optionIds: ["web-a", "web-b"] } })).toBeNull();
    expect(issue({ search: { mode: "all_selected", optionIds: ["web-unknown"] } })).toBe("assistant_overrides_invalid");
    // Without a readable catalog nothing that depends on it is accepted.
    expect(issue({ model: { mode: "model", modelId: "chat-model" } }, { catalog: null }))
      .toBe("assistant_overrides_invalid");
    expect(issue({ tools: { mode: "off" } }, { catalog: null })).toBeNull();
  });

  it("checks parameters against the model the next message uses", () => {
    const temperature = { controls: { temperature: 0.5 } };
    // The Assistant's own model supports temperature.
    expect(issue(temperature)).toBeNull();
    // A model chosen for the chat, in this patch or earlier, decides instead.
    expect(issue({ ...temperature, model: { mode: "model", modelId: "chat-model" } }))
      .toBe("assistant_overrides_invalid");
    expect(issue(temperature, { current: { model: { mode: "model", modelId: "chat-model" } } }))
      .toBe("assistant_overrides_invalid");
    // An inherited or unusable Assistant model falls back to the requester's default.
    expect(issue(temperature, { rows: rows("adjustable", null) })).toBeNull();
    expect(issue(temperature, { rows: rows("adjustable", "hidden-model") })).toBeNull();
    expect(issue(temperature, {
      catalog: { ...catalog, defaultModelId: null },
      rows: rows("adjustable", null)
    })).toBe("assistant_overrides_invalid");
    expect(issue({ controls: { maxOutputTokens: 9_000 } })).toBe("assistant_overrides_invalid");
    expect(issue({ controls: { backgroundMode: true } })).toBe("assistant_overrides_invalid");
  });

  it("loads the catalog only for rows whose values it decides", () => {
    expect(overridesNeedCatalog({ tools: { mode: "off" }, knowledge: { mode: "none" }, skills: { mode: "auto" } }))
      .toBe(false);
    expect(overridesNeedCatalog({ model: null, controls: null, search: null })).toBe(false);
    expect(overridesNeedCatalog({ search: { mode: "off" } })).toBe(true);
    expect(overridesNeedCatalog({ controls: {} })).toBe(true);
  });

  it("checks Knowledge values in a Project chat against the Project's own Knowledge", () => {
    const available = {
      knowledgeBaseIds: new Set(["project-base"]),
      knowledgeSourceIds: new Set(["project-document"])
    };
    expect(projectKnowledgeOverrideAvailable(available, { mode: "none" })).toBe(true);
    expect(projectKnowledgeOverrideAvailable(available, {
      baseIds: ["project-base"], mode: "explicit", sourceIds: ["project-document"]
    })).toBe(true);
    expect(projectKnowledgeOverrideAvailable(available, {
      baseIds: ["personal-base"], mode: "explicit", sourceIds: []
    })).toBe(false);
    expect(projectKnowledgeOverrideAvailable(available, {
      baseIds: [], mode: "explicit", sourceIds: ["personal-document"]
    })).toBe(false);
    expect(projectKnowledgeOverrideAvailable(available, { mode: "all_my_knowledge" })).toBe(false);

    expect(projectOverridesNeedAuthority({ tools: { mode: "off" }, knowledge: null })).toBe(false);
    expect(projectOverridesNeedAuthority({ knowledge: { mode: "none" } })).toBe(true);
    expect(projectOverridesNeedAuthority({ model: { mode: "model", modelId: "project-model" } })).toBe(true);
  });
});
