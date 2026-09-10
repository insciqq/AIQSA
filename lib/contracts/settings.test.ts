import { describe, expect, it } from "vitest";
import { decodeUpdateSettingsResponse, type UpdateSettingsResponse } from "./settings";
import { ANSWER_SOUNDS } from "./answerSound";

function validResponse(): UpdateSettingsResponse {
  return {
    settings: {
      answerSoundEnabled: true,
      answerSoundId: "rise",
      defaultControlValues: {},
      defaultKnowledgePlan: null,
      defaultMcpMode: "auto",
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
      sendWithEnter: true,
      showCitations: true,
      showReasoningBlocks: false,
    }
  };
}

describe("settings wire contract", () => {
  it("decodes saved sound preferences and rejects invalid field values", () => {
    const response = validResponse();
    response.settings.answerSoundEnabled = false;
    response.settings.answerSoundId = "double-tap";
    expect(decodeUpdateSettingsResponse(response)?.settings).toMatchObject({
      answerSoundEnabled: false, answerSoundId: "double-tap"
    });
    for (const invalid of ["unknown", "", null, 12]) {
      expect(decodeUpdateSettingsResponse({ settings: { ...response.settings, answerSoundId: invalid } })).toBeNull();
    }
    expect(decodeUpdateSettingsResponse({ settings: { ...response.settings, answerSoundEnabled: "false" } })).toBeNull();
  });

  it.each(ANSWER_SOUNDS)("accepts the saved $label selection", ({ value }) => {
    const response = validResponse();
    response.settings.answerSoundId = value;
    expect(decodeUpdateSettingsResponse(response)?.settings.answerSoundId).toBe(value);
  });

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

  it("falls back to the installation chat defaults when the fields are absent", () => {
    const response = validResponse() as unknown as { settings: Record<string, unknown> };
    delete response.settings.defaultKnowledgePlan;
    delete response.settings.defaultMcpMode;
    delete response.settings.sendWithEnter;
    expect(decodeUpdateSettingsResponse(response)?.settings).toMatchObject({
      defaultKnowledgePlan: null,
      defaultMcpMode: "auto",
      sendWithEnter: true
    });
  });

  it("decodes present chat defaults strictly", () => {
    const withPlan = validResponse() as unknown as { settings: Record<string, unknown> };
    withPlan.settings.defaultKnowledgePlan = { baseIds: ["kb-1"], mode: "explicit", sourceIds: [], version: 1 };
    withPlan.settings.defaultMcpMode = "off";
    withPlan.settings.sendWithEnter = false;
    expect(decodeUpdateSettingsResponse(withPlan)?.settings).toMatchObject({
      defaultKnowledgePlan: { baseIds: ["kb-1"], mode: "explicit" },
      defaultMcpMode: "off",
      sendWithEnter: false
    });
    for (const [field, value] of [
      ["defaultMcpMode", "sometimes"],
      ["sendWithEnter", "true"],
      ["defaultKnowledgePlan", { baseIds: "kb-1" }]
    ] as const) {
      const invalid = validResponse() as unknown as { settings: Record<string, unknown> };
      invalid.settings[field] = value;
      expect(decodeUpdateSettingsResponse(invalid)).toBeNull();
    }
  });
});
