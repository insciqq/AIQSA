import { describe, expect, it } from "vitest";
import { decodeUpdateSettingsResponse, type UpdateSettingsResponse } from "./settings";

function validResponse(): UpdateSettingsResponse {
  return {
    settings: {
      defaultControlValues: {},
      defaultSearchPlan: { mode: "all_selected", optionIds: [] },
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
    }
  };
}

describe("settings wire contract", () => {
  it("preserves a null personal default when the effective model is the organization default", () => {
    expect(decodeUpdateSettingsResponse(validResponse())?.settings).toMatchObject({
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
    "defaultSearchPlan",
    "hasPersonalModelDefault",
    "modelPreferenceSource",
    "organizationModelDefault",
    "organizationSearchPlan",
    "personalModelDefault",
    "searchPreferenceSource"
  ])("rejects settings that omit a current required field: %s", (field) => {
    const response = validResponse() as unknown as {
      settings: Record<string, unknown>;
    };
    delete response.settings[field];

    expect(decodeUpdateSettingsResponse(response)).toBeNull();
  });
});
