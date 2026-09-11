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
    answerSoundEnabled: true,
    answerSoundId: "rise",
    defaultControlValues: {},
    defaultKnowledgePlan: null,
    defaultMcpMode: "auto",
    defaultSearchPlan: { mode: "all_selected", optionIds: [] },
    hasPersonalModelDefault: true,
    modelPreferenceSource: "personal",
    organizationModelDefault: null,
    organizationSearchPlan: { mode: "all_selected", optionIds: [] },
    personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
    searchPreferenceSource: "personal",
    sendWithEnter: true,
    showCitations: true,
    showReasoningBlocks: false,
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
  it("retries a failed Workspace preference and reconciles the server's saved choice", async () => {
    const onReconcile = vi.fn(), onFailure = vi.fn(), onRecovered = vi.fn();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ settings: settings({ defaultWorkspaceEnabled: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const coordinator = createSettingsMutationCoordinator({ callbacks: { onFailure, onReconcile, onRecovered } });
    expect(await coordinator.enqueue({ workspaceEnabled: true })).toBe(false);
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), expect.any(Function), "general");
    coordinator.retry();
    await vi.waitFor(() => expect(onRecovered).toHaveBeenCalledWith("general"));
    expect(onReconcile).toHaveBeenLastCalledWith({ workspaceEnabled: true }, new Set());
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { defaultWorkspaceEnabled: true }, { defaultWorkspaceEnabled: true }
    ]);
  });

  it("retains mute and the selected sound over older unrelated responses and keeps failed edits for retry", async () => {
    const older = deferred<UserSettingsWire>();
    const onReconcile = vi.fn();
    const onFailure = vi.fn();
    const send = vi.fn<(patch: SettingsDefaultsPatch) => Promise<UserSettingsWire>>()
      .mockImplementationOnce(() => older.promise)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(settings({ answerSoundEnabled: false, answerSoundId: "bell" }));
    const coordinator = createSettingsMutationCoordinator({
      callbacks: { onFailure, onReconcile, onRecovered: vi.fn() }, send
    });
    const first = coordinator.enqueue({ showCitations: false });
    const muted = coordinator.enqueue({ answerSoundEnabled: false });
    const choice = coordinator.enqueue({ answerSoundId: "bell" }, { noticeScope: "settings" });
    older.resolve(settings({ showCitations: false }));
    await first;
    await expect(muted).resolves.toBe(false);
    await expect(choice).resolves.toBe(false);
    expect(onReconcile.mock.calls[0]?.[0]).toMatchObject({ answerSoundEnabled: false, answerSoundId: "bell" });
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), expect.any(Function), "settings");
    coordinator.retry();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]?.[0]).toEqual({ answerSoundEnabled: false, answerSoundId: "bell" });
  });

  it("fences stale account responses, failures, queued requests and old actions", async () => {
    let active = true;
    const response = deferred<UserSettingsWire>();
    const send = vi.fn(() => response.promise);
    const onReconcile = vi.fn();
    const onFailure = vi.fn();
    const coordinator = createSettingsMutationCoordinator({
      callbacks: { onFailure, onReconcile, onRecovered: vi.fn() }, isCurrent: () => active, send
    });
    const saving = coordinator.enqueue({ answerSoundEnabled: false });
    const pending = coordinator.enqueue({ answerSoundId: "bell" });
    active = false;
    response.resolve(settings({ answerSoundEnabled: false }));
    await expect(saving).resolves.toBe(false);
    await expect(pending).resolves.toBe(false);
    await expect(coordinator.enqueue({ answerSoundEnabled: true })).resolves.toBe(false);
    expect(onReconcile).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends only the requested sound field and does not overwrite its independent mute", async () => {
    const fetchMock = vi.fn(async () => Response.json({ settings: settings({ answerSoundId: "bell", answerSoundEnabled: false }) }));
    vi.stubGlobal("fetch", fetchMock);
    await sendSettingsDefaultsPatch({ answerSoundId: "bell" });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ answerSoundId: "bell" });
  });

  it.each([true, false])("replaces inherited reasoning when switching to organization default: %s", async (inherit) => {
    const model = { modelId: "gpt-5.5", provider: "openai" };
    const onReconcile = vi.fn();
    const coordinator = createSettingsMutationCoordinator({
      callbacks: { onFailure: vi.fn(), onReconcile, onRecovered: vi.fn() },
      send: async () => settings({
        defaultControlValues: inherit ? { "openai:gpt-5.5": { reasoningEffort: "high" } } : {},
        hasPersonalModelDefault: !inherit,
        modelPreferenceSource: inherit ? "organization" : "personal",
        organizationModelDefault: model,
        personalModelDefault: inherit ? null : model
      })
    });
    expect(await coordinator.enqueue({ personalModelDefault: inherit ? null : model })).toBe(true);
    expect(onReconcile).toHaveBeenCalledWith(expect.objectContaining({
      controlValues: { "openai:gpt-5.5": inherit ? { reasoningEffort: "high" } : {} },
      modelPreferenceSource: inherit ? "organization" : "personal"
    }), new Set(["openai:gpt-5.5"]));
  });

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

  it("uses dedicated explicit payloads for setting and clearing the personal model default", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        settings: settings(body.defaultProviderModelId === null
          ? {
              hasPersonalModelDefault: false,
              modelPreferenceSource: "organization",
              organizationModelDefault: { modelId: "gpt-5.5", provider: "openai" },
              personalModelDefault: null
            }
          : {
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
    await sendSettingsDefaultsPatch({ knowledgePlan: null, mcpMode: "off", sendWithEnter: false });
    await sendSettingsDefaultsPatch({
      knowledgePlan: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [], version: 1 }
    });

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { defaultProviderModelId: "model-b" },
      { defaultProviderModelId: null },
      { defaultKnowledgePlan: null, defaultMcpMode: "off", sendWithEnter: false },
      { defaultKnowledgePlan: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [], version: 1 } }
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
        hasPersonalModelDefault: true,
        modelId: "gpt-5.5",
        modelPreferenceSource: "personal",
        organizationModelDefault: null,
        organizationSearchPlan: { mode: "all_selected", optionIds: [] },
        personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
        provider: "openai",
        searchPlan: { mode: "all_selected", optionIds: [] },
        searchPreferenceSource: "personal",
        showCitations: true,
        showReasoningBlocks: false,
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
