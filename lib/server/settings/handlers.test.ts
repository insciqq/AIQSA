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
      "defaultControlValues",
      "defaultKnowledgePlan",
      "defaultMcpMode",
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
      sendWithEnter: false
    });
    expect(response.status).toBe(200);
    expect(captured).toEqual({
      defaultKnowledgePlan: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [], version: 1 },
      defaultMcpMode: "load_all",
      sendWithEnter: false
    });
    await expect(response.json()).resolves.toMatchObject({
      settings: {
        defaultKnowledgePlan: { baseIds: ["kb-1"], mode: "explicit" },
        defaultMcpMode: "load_all",
        sendWithEnter: false
      }
    });

    const cleared = await send({ defaultKnowledgePlan: null, defaultMcpMode: "auto", sendWithEnter: true });
    expect(cleared.status).toBe(200);
    expect(captured).toEqual({ defaultKnowledgePlan: null, defaultMcpMode: "auto", sendWithEnter: true });

    expect((await send({ defaultMcpMode: "always" })).status).toBe(400);
    expect((await send({ sendWithEnter: "yes" })).status).toBe(400);
    expect((await send({
      defaultKnowledgePlan: { baseIds: [], inheritedFrom: "project", mode: "inherited", sourceIds: [], version: 1 }
    })).status).toBe(400);
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
