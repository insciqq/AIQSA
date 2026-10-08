import { describe, expect, it } from "vitest";
import { defaultProviderModels, defaultSearchStrategies } from "../../domain/catalog";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import {
  createUpdateSettingsHandler,
  type SettingsHandlerData,
  type SettingsValidationModel,
  type UserSettingsRecord,
  type UserSettingsUpdate,
  type UserSettingsUpdateResult
} from "./handlers";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({
  user: {
    id: config.bootstrapUserId
  }
});

function authCookie() {
  return auth.cookie;
}

function updated(settings: UserSettingsRecord): UserSettingsUpdateResult {
  return {
    kind: "updated",
    settings
  };
}

function baseSettingsData(): SettingsHandlerData {
  return {
    entitlements: {
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set(["openai-native-web-search"])
    },
    models: defaultProviderModels,
    searchStrategies: defaultSearchStrategies,
    settings: {
      defaultControlValues: {},
      defaultProviderModelId: "gpt-5.5",
      defaultSearchPlan: {
        mode: "all_selected",
        optionIds: ["openai-native-web-search"]
      },
      showCitations: true,
      showReasoningBlocks: false,
    }
  };
}

describe("settings handler", () => {
  it("reports a saved default Assistant as unavailable without naming it until availability is checked", async () => {
    const data = baseSettingsData();
    data.settings.defaultAssistantId = "assistant-hidden";
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => updated({ ...data.settings, ...update })
    });
    const response = await PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify({ sendWithEnter: false }), headers: { cookie: authCookie(), "content-type": "application/json" }, method: "PATCH"
    }));
    const body = await response.json();
    expect(body.settings).toMatchObject({ defaultAssistantId: null, defaultAssistantUnavailable: true });
    expect(JSON.stringify(body)).not.toContain("assistant-hidden");
  });

  it("saves, clears and reports the default Assistant like a chat binding", async () => {
    const data = baseSettingsData();
    const calls: UserSettingsUpdate[] = [];
    let persistence: (update: UserSettingsUpdate) => UserSettingsUpdateResult = (update) => updated({
      ...data.settings,
      ...update,
      ...(update.defaultAssistantId !== undefined ? { defaultAssistantAvailable: update.defaultAssistantId !== null } : {})
    });
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => {
        calls.push(update);
        return persistence(update);
      }
    });
    const patch = (body: unknown) => PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify(body), headers: { cookie: authCookie(), "content-type": "application/json" }, method: "PATCH"
    }));

    const saved = await patch({ defaultAssistantId: "assistant-1" });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({ defaultAssistantId: "assistant-1", defaultAssistantUnavailable: false });
    const cleared = await patch({ defaultAssistantId: null });
    expect((await cleared.json()).settings).toMatchObject({ defaultAssistantId: null, defaultAssistantUnavailable: false });
    expect(calls).toEqual([{ defaultAssistantId: "assistant-1" }, { defaultAssistantId: null }]);

    // Malformed ids answer like an Assistant the user cannot use, before persistence.
    calls.length = 0;
    const malformed = await Promise.all([patch({ defaultAssistantId: "" }), patch({ defaultAssistantId: 7 }),
      patch({ defaultAssistantId: "two words" })]);
    expect(malformed.map((response) => response.status)).toEqual([404, 404, 404]);
    await expect(Promise.all(malformed.map((response) => response.json()))).resolves.toEqual(
      Array(3).fill({ error: "assistant_not_available" })
    );
    expect(calls).toEqual([]);

    persistence = () => ({ kind: "assistant_not_available" });
    const refused = await patch({ defaultAssistantId: "assistant-foreign" });
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toEqual({ error: "assistant_not_available" });

    // An untouched default keeps the availability read with the settings data.
    data.settings.defaultAssistantId = "assistant-1";
    data.settings.defaultAssistantAvailable = true;
    persistence = (update) => updated({ ...data.settings, defaultAssistantAvailable: undefined, ...update });
    const untouched = await patch({ sendWithEnter: false });
    expect((await untouched.json()).settings).toMatchObject({ defaultAssistantId: "assistant-1", defaultAssistantUnavailable: false });
    data.settings.defaultAssistantAvailable = false;
    const revoked = await patch({ sendWithEnter: true });
    const revokedBody = await revoked.json();
    expect(revokedBody.settings).toMatchObject({ defaultAssistantId: null, defaultAssistantUnavailable: true });
    expect(JSON.stringify(revokedBody)).not.toContain("assistant-1");
  });

  it.each([true, false, null, "true", 1])("validates the personal Workspace default: %j", async (value) => {
    const data = baseSettingsData();
    const calls: Array<{ userId: string; update: UserSettingsUpdate }> = [];
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (userId, update) => {
        calls.push({ userId, update });
        return updated({ ...data.settings, ...update });
      }
    });
    const response = await PATCH(new Request("http://app.local/api/me/settings", {
      method: "PATCH", headers: { cookie: authCookie(), "content-type": "application/json" },
      body: JSON.stringify({ defaultWorkspaceEnabled: value })
    }));
    if (typeof value === "boolean") {
      expect(response.status).toBe(200);
      expect(calls).toEqual([{ userId: config.bootstrapUserId, update: { defaultWorkspaceEnabled: value } }]);
      expect((await response.json()).settings.defaultWorkspaceEnabled).toBe(value);
    } else {
      expect(response.status).toBe(400);
      expect(calls).toEqual([]);
    }
  });

  it.each([
    [{ browserNotificationsEnabled: false }, 200],
    [{ browserNotificationsEnabled: true }, 200],
    [{ browserNotificationsEnabled: "off" }, 400],
    [{ browserNotificationsEnabled: null }, 400]
  ])("validates the browser notification toggle: %j", async (update, status) => {
    const data = baseSettingsData();
    const calls: UserSettingsUpdate[] = [];
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, patch) => {
        calls.push(patch);
        return updated({ ...data.settings, ...patch });
      }
    });
    const response = await PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify(update), headers: { cookie: authCookie(), "content-type": "application/json" }, method: "PATCH"
    }));
    expect(response.status).toBe(status);
    if (status === 200) {
      expect(calls).toEqual([update]);
      expect((await response.json()).settings.browserNotificationsEnabled).toBe(update.browserNotificationsEnabled);
    } else expect(calls).toHaveLength(0);
  });

  it.each([
    [{ answerSoundEnabled: false, answerSoundId: "bell" }, 200],
    [{ answerSoundEnabled: true }, 200],
    [{ answerSoundId: "double-tap" }, 200],
    [{ answerSoundId: "upload.wav" }, 400],
    [{ answerSoundId: null }, 400],
    [{ answerSoundEnabled: "off" }, 400],
    [{ answerSoundEnabled: false, userId: "another-user" }, 400]
  ])("validates sound preferences and uses only authenticated ownership: %j", async (update, status) => {
    const data = baseSettingsData();
    data.settings.answerSoundId = "drop";
    data.settings.answerSoundEnabled = false;
    const calls: Array<{ userId: string; update: UserSettingsUpdate }> = [];
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (userId, patch) => {
        calls.push({ userId, update: patch });
        return updated({ ...data.settings, ...patch });
      }
    });
    const response = await PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify(update), headers: { cookie: authCookie(), "content-type": "application/json" }, method: "PATCH"
    }));
    expect(response.status).toBe(status);
    if (status === 200) {
      expect(calls).toEqual([{ userId: config.bootstrapUserId, update }]);
      expect((await response.json()).settings).toMatchObject({
        answerSoundEnabled: false, answerSoundId: "drop", ...update
      });
    } else expect(calls).toHaveLength(0);
  });

  it.each([
    { personalModel: null, personalEffort: null, expected: "high" },
    { personalModel: null, personalEffort: "low", expected: "low" },
    { personalModel: "gpt-5.5", personalEffort: null, expected: undefined }
  ])("reconciles reasoning when changing the model default without persisting inheritance: %j", async ({
    personalModel, personalEffort, expected
  }) => {
    const data = baseSettingsData();
    data.modelPolicy = { defaultProviderModelId: "gpt-5.5", reasoningEffort: "high" };
    data.settings.defaultControlValues = personalEffort
      ? { "openai:gpt-5.5": { reasoningEffort: personalEffort } } : {};
    let capturedUpdate: UserSettingsUpdate | undefined;
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => {
        capturedUpdate = update;
        return updated({ ...data.settings, ...update });
      }
    });
    const response = await PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify({ defaultProviderModelId: personalModel }),
      headers: { cookie: authCookie(), "content-type": "application/json" },
      method: "PATCH"
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings.defaultControlValues["openai:gpt-5.5"]?.reasoningEffort).toBe(expected);
    expect(capturedUpdate).toEqual({ defaultProviderModelId: personalModel });
  });

  it("updates user defaults and sanitizes per-model control drafts", async () => {
    let capturedUpdate: unknown = null;
    let capturedValidationModels: SettingsValidationModel[] = [];
    const data = baseSettingsData();
    data.settings.defaultControlValues = {
      "fake:fake-qsa": {
        temperature: "0.7"
      }
    };
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update, validationModels) => {
        capturedUpdate = update;
        capturedValidationModels = validationModels;
        return updated({
          ...data.settings,
          ...update
        } as UserSettingsRecord);
      }
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({
          defaultControlValues: {
            "openai:gpt-5.5": {
              backgroundMode: false,
              maxOutputTokens: "999999",
              reasoningEffort: "xhigh",
              streamMode: true,
              temperature: "0.3"
            }
          },
          defaultProviderModelId: "gpt-5.5",
          defaultSearchPlan: {
            mode: "all_selected",
            optionIds: ["openai-native-web-search"]
          },
          showCitations: false,
          showReasoningBlocks: true,
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(200);
    expect(capturedUpdate).toMatchObject({
      defaultControlValues: {
        "openai:gpt-5.5": {
          backgroundMode: false,
          maxOutputTokens: "128000",
          reasoningEffort: "xhigh",
          streamMode: true,
          temperature: "0.3"
        }
      },
      defaultProviderModelId: "gpt-5.5",
      defaultSearchPlan: {
        mode: "all_selected",
        optionIds: ["openai-native-web-search"]
      },
      showCitations: false,
      showReasoningBlocks: true,
    });
    expect(
      (capturedUpdate as { defaultControlValues: Record<string, unknown> }).defaultControlValues
    ).not.toHaveProperty("fake:fake-qsa");
    expect(capturedUpdate).not.toHaveProperty("defaultModelId");
    expect(capturedUpdate).not.toHaveProperty("defaultProvider");
    expect(capturedValidationModels).toHaveLength(1);
    expect(capturedValidationModels[0]).toMatchObject({
      modelId: "gpt-5.5",
      provider: "openai",
      searchStrategyIds: ["search-disabled", "openai-native-web-search"]
    });
    const responseBody = (await response.json()) as { settings: UserSettingsRecord };
    expect(responseBody).toMatchObject({
      settings: {
        defaultSearchPlan: {
          mode: "all_selected",
          optionIds: ["openai-native-web-search"]
        },
        showCitations: false,
        showReasoningBlocks: true,
      }
    });
    expect(Object.keys(responseBody.settings)).toEqual([
      "answerSoundEnabled",
      "answerSoundId",
      "browserNotificationsEnabled",
      "defaultAnswerReview",
      "defaultAssistantId",
      "defaultAssistantUnavailable",
      "defaultControlValues",
      "defaultKnowledgePlan",
      "defaultMcpMode",
      "defaultSkillsMode",
      "defaultWorkspaceEnabled",
      "hasPersonalModelDefault",
      "modelPreferenceSource",
      "organizationModelDefault",
      "personalModelDefault",
      "defaultSearchPlan",
      "organizationSearchPlan",
      "searchPreferenceSource",
      "sendWithEnter",
      "showCitations",
      "showReasoningBlocks",
    ]);
  });

  it("persists the chat defaults and the Send with Enter preference with bounded values", async () => {
    const data = baseSettingsData();
    let captured: UserSettingsUpdate | null = null;
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => {
        captured = update;
        return updated({ ...data.settings, ...update } as UserSettingsRecord);
      }
    });
    const send = (body: unknown) => PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify(body),
      headers: { cookie: authCookie() },
      method: "PATCH"
    }));

    const response = await send({
      defaultKnowledgePlan: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [], version: 1 },
      defaultMcpMode: "load_all",
      defaultSkillsMode: "off",
      sendWithEnter: false
    });
    expect(response.status).toBe(200);
    expect(captured).toEqual({
      defaultKnowledgePlan: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [], version: 1 },
      defaultMcpMode: "load_all",
      defaultSkillsMode: "off",
      sendWithEnter: false
    });
    await expect(response.json()).resolves.toMatchObject({
      settings: {
        defaultKnowledgePlan: { baseIds: ["kb-1"], mode: "explicit" },
        defaultMcpMode: "load_all",
        defaultSkillsMode: "off",
        sendWithEnter: false
      }
    });

    const cleared = await send({ defaultKnowledgePlan: null, defaultMcpMode: "auto", sendWithEnter: true });
    expect(cleared.status).toBe(200);
    expect(captured).toEqual({ defaultKnowledgePlan: null, defaultMcpMode: "auto", sendWithEnter: true });

    expect((await send({ defaultMcpMode: "always" })).status).toBe(400);
    expect((await send({ defaultSkillsMode: "always" })).status).toBe(400);
    expect((await send({ sendWithEnter: "yes" })).status).toBe(400);
    expect((await send({
      defaultKnowledgePlan: { baseIds: [], inheritedFrom: "project", mode: "inherited", sourceIds: [], version: 1 }
    })).status).toBe(400);
  });

  it("persists the automatic review new chats start with, from the user's own tool-calling models only", async () => {
    const data = baseSettingsData();
    // Catalog identities as installations mint them (no dots); the fixture's templates carry upstream names.
    const template = data.models.find((model) => model.modelId === "gpt-5.5")!;
    data.models = [...data.models, { ...template, modelId: "model-review" }];
    data.entitlements = { ...data.entitlements, modelKeys: new Set([...data.entitlements.modelKeys, "openai:model-review"]) };
    let captured: UserSettingsUpdate | null = null;
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => {
        captured = update;
        return updated({ ...data.settings, ...update } as UserSettingsRecord);
      }
    });
    const send = (body: unknown) => PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify(body),
      headers: { cookie: authCookie() },
      method: "PATCH"
    }));
    const config = { enabled: true, maxRounds: 2, reviewers: [{ modelId: "model-review", provider: "openai" }] };
    const saved = await send({ defaultAnswerReview: config });
    expect(saved.status).toBe(200);
    expect(captured).toEqual({ defaultAnswerReview: config });
    await expect(saved.json()).resolves.toMatchObject({ settings: { defaultAnswerReview: config } });

    for (const invalid of [
      { enabled: true, maxRounds: 2, reviewers: [{ modelId: "gpt-hidden", provider: "openai" }] },
      { enabled: true, maxRounds: 2, reviewers: [] },
      { enabled: true, maxRounds: 9, reviewers: [{ modelId: "model-review", provider: "openai" }] },
      null
    ]) {
      const refused = await send({ defaultAnswerReview: invalid });
      expect(refused.status, JSON.stringify(invalid)).toBe(400);
      expect(await refused.json()).toEqual({ error: "default_answer_review_invalid" });
    }
  });

  it("reports automatic review off for new chats until a default is saved", async () => {
    const data = baseSettingsData();
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => updated({ ...data.settings, ...update } as UserSettingsRecord)
    });
    const response = await PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify({ sendWithEnter: true }), headers: { cookie: authCookie() }, method: "PATCH"
    }));
    await expect(response.json()).resolves.toMatchObject({ settings: { defaultAnswerReview: { enabled: false, maxRounds: 3,
      reviewers: [] } } });
  });

  it("drops unsupported per-model draft fields without dropping valid fields", async () => {
    let capturedUpdate: unknown = null;
    const data = baseSettingsData();
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => {
        capturedUpdate = update;
        return updated({
          ...data.settings,
          ...update
        } as UserSettingsRecord);
      }
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({
          defaultControlValues: {
            "openai:gpt-5.5": {
              reasoningEffort: "high",
              unsupportedField: "ignored"
            }
          }
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(200);
    expect(capturedUpdate).toMatchObject({
      defaultControlValues: {
        "openai:gpt-5.5": {
          reasoningEffort: "high"
        }
      }
    });
    expect(
      (capturedUpdate as { defaultControlValues: Record<string, Record<string, unknown>> }).defaultControlValues[
        "openai:gpt-5.5"
      ].unsupportedField
    ).toBeUndefined();
  });

  it("persists Pro mode only for a model that advertises it", async () => {
    let capturedUpdate: unknown = null;
    const data = baseSettingsData();
    data.entitlements.modelKeys.add("openai:gpt-5.6-sol");
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => {
        capturedUpdate = update;
        return updated({ ...data.settings, ...update } as UserSettingsRecord);
      }
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({
          defaultControlValues: {
            "openai:gpt-5.5": { reasoningEffort: "medium", reasoningMode: "pro" },
            "openai:gpt-5.6-sol": { reasoningEffort: "max", reasoningMode: "pro" }
          }
        }),
        headers: { cookie: authCookie() },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(200);
    expect(capturedUpdate).toMatchObject({
      defaultControlValues: {
        "openai:gpt-5.5": { reasoningEffort: "medium" },
        "openai:gpt-5.6-sol": { reasoningEffort: "max", reasoningMode: "pro" }
      }
    });
    expect(
      (capturedUpdate as { defaultControlValues: Record<string, Record<string, unknown>> })
        .defaultControlValues["openai:gpt-5.5"]
    ).not.toHaveProperty("reasoningMode");
  });

  it("keeps a global Search preference even when the selected model cannot use it", async () => {
    const data = baseSettingsData();
    data.entitlements.searchStrategies.add("perplexity-tool-search");
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async () => updated(data.settings)
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({
          defaultProviderModelId: "gpt-5.5",
          defaultSearchPlan: {
            mode: "all_selected",
            optionIds: ["perplexity-tool-search"]
          }
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(200);
  });

  it("reports a search selection invalidated while waiting to persist", async () => {
    const data = baseSettingsData();
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async () => ({
        error: "default_search_unavailable",
        kind: "invalid"
      })
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({
          defaultSearchPlan: {
            mode: "all_selected",
            optionIds: ["openai-native-web-search"]
          }
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "default_search_unavailable"
    });
  });

  it("persists null as organization inheritance while keeping explicit Off distinct", async () => {
    const data = {
      ...baseSettingsData(),
      searchPolicy: {
        defaultPlan: {
          mode: "all_selected" as const,
          optionIds: ["openai-native-web-search"]
        }
      }
    };
    let captured: UserSettingsUpdate | null = null;
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => {
        captured = update;
        return updated({ ...data.settings, defaultSearchPlan: null });
      }
    });

    const inherited = await PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify({ defaultSearchPlan: null }),
      headers: { cookie: authCookie() },
      method: "PATCH"
    }));

    expect(inherited.status).toBe(200);
    expect(captured).toMatchObject({ defaultSearchPlan: null });
    await expect(inherited.json()).resolves.toMatchObject({
      settings: {
        defaultSearchPlan: {
          mode: "all_selected",
          optionIds: ["openai-native-web-search"]
        },
        searchPreferenceSource: "organization"
      }
    });
  });

  it("clears a personal model override and projects the entitled organization default", async () => {
    const data = baseSettingsData();
    data.entitlements.modelKeys.add("openai:gpt-5.6-sol");
    data.modelPolicy = { defaultProviderModelId: "gpt-5.5" };
    data.settings.defaultProviderModelId = "gpt-5.6-sol";
    let captured: UserSettingsUpdate | null = null;
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) => {
        captured = update;
        return updated({
          ...data.settings,
          defaultProviderModelId: null
        });
      }
    });

    const response = await PATCH(new Request("http://app.local/api/me/settings", {
      body: JSON.stringify({ defaultProviderModelId: null }),
      headers: { cookie: authCookie() },
      method: "PATCH"
    }));

    expect(response.status).toBe(200);
    expect(captured).toEqual({ defaultProviderModelId: null });
    await expect(response.json()).resolves.toMatchObject({
      settings: {
        hasPersonalModelDefault: false,
        modelPreferenceSource: "organization",
        organizationModelDefault: { modelId: "gpt-5.5", provider: "openai" },
        personalModelDefault: null
      }
    });
  });

  it("keeps a legitimate empty default empty while updating an unrelated preference", async () => {
    const data = baseSettingsData();
    data.settings.defaultProviderModelId = null;
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async (_userId, update) =>
        updated({
          ...data.settings,
          ...update
        })
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({ showCitations: false }),
        headers: { cookie: authCookie() },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settings: {
        hasPersonalModelDefault: false,
        modelPreferenceSource: "none",
        personalModelDefault: null,
        showCitations: false
      }
    });
  });

  it("rejects an update containing only an unsupported field", async () => {
    let persisted = false;
    const data = baseSettingsData();
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async () => {
        persisted = true;
        return updated(data.settings);
      }
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({
          unsupportedPreference: "ignored"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(400);
    expect(persisted).toBe(false);
    await expect(response.json()).resolves.toEqual({
      error: "settings_update_required"
    });
  });

  it("rejects a default model outside the current user's entitlements", async () => {
    const data = baseSettingsData();
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async () => updated(data.settings)
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({
          defaultProviderModelId: "claude-opus-4-8"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "default_model_unavailable"
    });
  });

  it("reports missing settings before validating an update", async () => {
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => null,
      updateSettings: async () => ({ kind: "not_found" })
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({ showCitations: false }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "settings_not_found" });
  });

  it("reports settings that disappear during persistence", async () => {
    const data = baseSettingsData();
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async () => ({ kind: "not_found" })
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({ showCitations: false }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "settings_not_found" });
  });

  it("rejects anonymous settings updates", async () => {
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => null,
      updateSettings: async () => ({ kind: "not_found" })
    });
    const response = await PATCH(new Request("http://app.local/api/me/settings", { method: "PATCH" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
