import { describe, expect, it } from "vitest";
import { decodeUpdateSettingsResponse, type UpdateSettingsResponse } from "./settings";

function validResponse(): UpdateSettingsResponse {
  return {
    settings: {
      defaultControlValues: {},
      defaultModelId: "deployment-test",
      defaultProvider: "connection-test",
      defaultSearchPlan: { mode: "all_selected", optionIds: [] },
      defaultSearchStrategyId: "search-disabled",
      hasPersonalModelDefault: false,
      modelPreferenceSource: "organization",
      organizationModelDefault: {
        modelId: "deployment-test",
        provider: "connection-test"
      },
      organizationSearchPlan: { mode: "all_selected", optionIds: [] },
      personalModelDefault: null,
      searchPreferenceSource: "organization",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true
    }
  };
}

describe("settings wire contract", () => {
  it("preserves a null personal default when the effective model is the organization default", () => {
    expect(decodeUpdateSettingsResponse(validResponse())?.settings).toMatchObject({
      defaultModelId: "deployment-test",
      defaultProvider: "connection-test",
      hasPersonalModelDefault: false,
      modelPreferenceSource: "organization",
      organizationModelDefault: {
        modelId: "deployment-test",
        provider: "connection-test"
      },
      personalModelDefault: null
    });
  });

  it.each([
    "hasPersonalModelDefault",
    "modelPreferenceSource",
    "organizationModelDefault",
    "personalModelDefault"
  ])("rejects settings that omit current model-default provenance: %s", (field) => {
    const response = validResponse() as unknown as {
      settings: Record<string, unknown>;
    };
    delete response.settings[field];

    expect(decodeUpdateSettingsResponse(response)).toBeNull();
  });
});
