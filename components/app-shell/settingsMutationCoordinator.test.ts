import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserSettingsWire } from "@/lib/contracts/settings";
import {
  applySettingsDefaultsReconciliation,
  createSettingsMutationCoordinator,
  sendSettingsDefaultsPatch,
  type SettingsDefaultsPatch
} from "./settingsMutationCoordinator";

function settings(overrides: Partial<UserSettingsWire> = {}): UserSettingsWire {
  return {
    defaultControlValues: {},
    defaultModelId: "gpt-5.5",
    organizationSearchPlan: { mode: "all_selected", optionIds: [] },
    defaultProvider: "openai",
    defaultSearchStrategyId: "search-disabled",
    searchPreferenceSource: "personal",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings mutation coordinator", () => {
  it("serializes requests, deep-coalesces pending keys, and overlays newer intent on an older response", async () => {
    const responses = [deferred<UserSettingsWire>(), deferred<UserSettingsWire>()];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const send = vi.fn(async (_patch: SettingsDefaultsPatch) => {
      const response = responses[send.mock.calls.length - 1];
      if (!response) {
        throw new Error("unexpected_settings_request");
      }

      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        return await response.promise;
      } finally {
        activeRequests -= 1;
      }
    });
    const reconciled: SettingsDefaultsPatch[] = [];
    const coordinator = createSettingsMutationCoordinator({
      callbacks: {
        onFailure: vi.fn(),
        onReconcile: (patch) => reconciled.push(patch),
        onRecovered: vi.fn()
      },
      send
    });

    const first = coordinator.enqueue({ showCitations: false });
    const second = coordinator.enqueue({
      controlValues: {
        "openai:gpt-5.5": {
          temperature: "0.2"
        }
      },
      showCitations: true
    });
    const third = coordinator.enqueue({
      controlValues: {
        "openai:gpt-5.5": {
          streamMode: true
        },
        "openrouter:model-b": {
          reasoningEffort: "high"
        }
      },
      showReasoningBlocks: true,
      showToolActivity: true,
    });

    expect(send).toHaveBeenCalledTimes(1);
    responses[0]?.resolve(settings({ showCitations: false }));

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(reconciled[0]).toMatchObject({
      controlValues: {
        "openai:gpt-5.5": {
          streamMode: true,
          temperature: "0.2"
        },
        "openrouter:model-b": {
          reasoningEffort: "high"
        }
      },
      showCitations: true,
      showReasoningBlocks: true,
      showToolActivity: true,
    });
    expect(send.mock.calls[1]?.[0]).toEqual({
      controlValues: {
        "openai:gpt-5.5": {
          streamMode: true,
          temperature: "0.2"
        },
        "openrouter:model-b": {
          reasoningEffort: "high"
        }
      },
      showCitations: true,
      showReasoningBlocks: true,
      showToolActivity: true,
    });

    responses[1]?.resolve(
      settings({
        defaultControlValues: {
          "openai:gpt-5.5": {
            streamMode: true,
            temperature: "0.2"
          },
          "openrouter:model-b": {
            reasoningEffort: "high"
          }
        },
        showCitations: true,
        showReasoningBlocks: true,
        showToolActivity: true,
      })
    );
    await Promise.all([first, second, third]);

    expect(maxActiveRequests).toBe(1);
  });

  it("retains a failed patch for an explicit retry", async () => {
    const retryCallbacks: Array<() => void> = [];
    const failureScopes: string[] = [];
    const recoveredScopes: string[] = [];
    const send = vi
      .fn<(patch: SettingsDefaultsPatch) => Promise<UserSettingsWire>>()
      .mockRejectedValueOnce(new Error("settings_update_failed_503"))
      .mockRejectedValueOnce(new Error("settings_update_failed_503"))
      .mockResolvedValueOnce(
        settings({
          defaultControlValues: {
            "openai:gpt-5.5": {
              streamMode: false
            }
          },
          showCitations: false,
          showReasoningBlocks: true
        })
      );
    const coordinator = createSettingsMutationCoordinator({
      callbacks: {
        onFailure: (_error, retry, noticeScope) => {
          failureScopes.push(noticeScope);
          retryCallbacks.push(retry);
        },
        onReconcile: vi.fn(),
        onRecovered: (noticeScope) => recoveredScopes.push(noticeScope)
      },
      send
    });

    const first = coordinator.enqueue({
      controlValues: {
        "openai:gpt-5.5": {
          streamMode: false
        }
      },
      showCitations: false
    });
    await vi.waitFor(() => expect(retryCallbacks).toHaveLength(1));
    await expect(first).resolves.toBe(false);

    const second = coordinator.enqueue(
      {
        showReasoningBlocks: true
      },
      {
        noticeScope: "settings"
      }
    );
    await vi.waitFor(() => expect(retryCallbacks).toHaveLength(2));
    await expect(second).resolves.toBe(false);
    expect(failureScopes).toEqual(["general", "general"]);

    retryCallbacks[1]?.();
    await vi.waitFor(() => expect(recoveredScopes).toEqual(["general"]));

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toEqual({
      controlValues: {
        "openai:gpt-5.5": {
          streamMode: false
        }
      },
      showCitations: false,
      showReasoningBlocks: true
    });
  });

  it("rejects a malformed successful response before reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          settings: {
            defaultControlValues: {}
          }
        })
      )
    );

    await expect(sendSettingsDefaultsPatch({ showCitations: false })).rejects.toThrow(
      "settings_malformed"
    );
  });

  it("sends and decodes the persisted tool activity preference", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ settings: settings({ showToolActivity: false }) })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendSettingsDefaultsPatch({ showToolActivity: false })).resolves.toMatchObject({
      showToolActivity: false
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({ showToolActivity: false });
  });

  it("uses dedicated explicit payloads for setting and clearing the personal model default", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        settings: settings(body.defaultProviderModelId === null
          ? {
              defaultModelId: "gpt-5.5",
              defaultProvider: "openai",
              hasPersonalModelDefault: false,
              modelPreferenceSource: "organization",
              organizationModelDefault: { modelId: "gpt-5.5", provider: "openai" },
              personalModelDefault: null
            }
          : {
              defaultModelId: "model-b",
              defaultProvider: "openrouter",
              hasPersonalModelDefault: true,
              modelPreferenceSource: "personal",
              organizationModelDefault: { modelId: "gpt-5.5", provider: "openai" },
              personalModelDefault: { modelId: "model-b", provider: "openrouter" }
            })
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendSettingsDefaultsPatch({
      personalModelDefault: { modelId: "model-b", provider: "openrouter" }
    });
    await sendSettingsDefaultsPatch({ personalModelDefault: null });

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { defaultModelId: "model-b", defaultProvider: "openrouter" },
      { defaultProviderModelId: null }
    ]);
  });

  it("replaces a server-confirmed model draft before preserving unrelated keys", () => {
    const result = applySettingsDefaultsReconciliation(
      {
        controlValues: {
          "openai:gpt-5.5": {
            staleField: true,
            temperature: "0.4"
          },
          "openrouter:model-b": {
            reasoningEffort: "high"
          }
        },
        modelId: "gpt-5.5",
        provider: "openai",
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      },
      {
        controlValues: {
          "openai:gpt-5.5": {
            temperature: "0.2"
          }
        }
      },
      new Set(["openai:gpt-5.5"])
    );

    expect(result.controlValues).toEqual({
      "openai:gpt-5.5": {
        temperature: "0.2"
      },
      "openrouter:model-b": {
        reasoningEffort: "high"
      }
    });
  });
});
