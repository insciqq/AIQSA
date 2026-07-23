import { describe, expect, it } from "vitest";
import { defaultProviderModels, defaultSearchStrategies } from "../../domain/catalog";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import {
  createUpdateSettingsHandler,
  type SettingsHandlerData,
  type SettingsValidationModel,
  type UserSettingsRecord,
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
    promptPresets: [{ id: "prompt-1" }],
    searchStrategies: defaultSearchStrategies,
    settings: {
      defaultControlValues: {},
      defaultModelId: "gpt-5.5",
      defaultPromptPresetId: "prompt-1",
      defaultProvider: "openai",
      defaultSearchStrategyId: "openai-native-web-search",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
    }
  };
}

describe("settings handler", () => {
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
              searchStrategyId: "openai-native-web-search",
              streamMode: true,
              temperature: "0.3"
            }
          },
          defaultModelId: "gpt-5.5",
          defaultProvider: "openai",
          defaultSearchStrategyId: "openai-native-web-search",
          showCitations: false,
          showReasoningBlocks: true,
          showToolActivity: false
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
          searchStrategyId: "openai-native-web-search",
          streamMode: true,
          temperature: "0.3"
        }
      },
      defaultModelId: "gpt-5.5",
      defaultProvider: "openai",
      defaultSearchStrategyId: "openai-native-web-search",
      showCitations: false,
      showReasoningBlocks: true,
      showToolActivity: false
    });
    expect(
      (capturedUpdate as { defaultControlValues: Record<string, unknown> }).defaultControlValues
    ).not.toHaveProperty("fake:fake-qsa");
    expect(capturedValidationModels).toHaveLength(1);
    expect(capturedValidationModels[0]).toMatchObject({
      modelId: "gpt-5.5",
      provider: "openai",
      searchStrategyIds: ["search-disabled", "openai-native-web-search"]
    });
    const responseBody = (await response.json()) as { settings: UserSettingsRecord };
    expect(responseBody).toMatchObject({
      settings: {
        defaultSearchStrategyId: "openai-native-web-search",
        showCitations: false,
        showReasoningBlocks: true,
        showToolActivity: false
      }
    });
    expect(Object.keys(responseBody.settings)).toEqual([
      "defaultControlValues",
      "defaultModelId",
      "defaultPromptPresetId",
      "defaultProvider",
      "defaultSearchStrategyId",
      "showCitations",
      "showReasoningBlocks",
      "showToolActivity"
    ]);
  });

  it("rejects a non-boolean tool activity preference", async () => {
    const data = baseSettingsData();
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async () => updated(data.settings)
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({ showToolActivity: "yes" }),
        headers: { cookie: authCookie() },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "show_tool_activity_boolean_required"
    });
  });

  it("drops invalid per-model search drafts without dropping valid draft fields", async () => {
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
              searchStrategyId: "unsupported-search"
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
      ].searchStrategyId
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

  it("rejects a default search strategy that the selected model cannot use", async () => {
    const data = baseSettingsData();
    const PATCH = createUpdateSettingsHandler({
      resolveAuth: auth.resolveAuth,
      loadSettingsData: async () => data,
      updateSettings: async () => updated(data.settings)
    });

    const response = await PATCH(
      new Request("http://app.local/api/me/settings", {
        body: JSON.stringify({
          defaultModelId: "gpt-5.5",
          defaultProvider: "openai",
          defaultSearchStrategyId: "perplexity-tool-search"
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
          defaultSearchStrategyId: "openai-native-web-search"
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

  it("rejects unavailable prompt defaults before persisting settings", async () => {
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
          defaultPromptPresetId: "missing-prompt"
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
      error: "default_prompt_unavailable"
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
          defaultModelId: "claude-opus-4-8",
          defaultProvider: "anthropic"
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
