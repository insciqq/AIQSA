import { describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import type { McpRunPlanResult } from "../mcp/runPlan";
import type { AssistantRunResolution } from "../assistants/runMaterialization";
import { KnowledgeRunAdmissionError } from "../knowledge/runAdmission";
import type { ProviderAdapter } from "../providers/types";
import { prepareRun, type RunPreparationDeps } from "./runPreparation";

const fakeAdapter = {
  buildRequestPreview: () => ({ provider: "fake" }),
  async run() {
    throw new Error("not_used");
  }
} as unknown as ProviderAdapter;

function repository() {
  return {
    loadAttachments: vi.fn(async () => []),
    loadConversationContextForExpectedLeaf: vi.fn(async () => []),
    loadConversationContextForLeaf: vi.fn(async () => []),
    loadEntitlements: vi.fn(async () => ({
      fullAccess: true,
      modelKeys: new Set<string>(),
      providerKeys: new Set<string>(),
      searchStrategies: new Set<string>()
    })),
    loadModelConfiguration: vi.fn(async () => ({
      capabilities: {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        nativeSearch: false,
        pdf: false,
        reasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
        streaming: true,
        toolCalling: true,
        vision: false
      },
      defaultParams: {}
    })),
    loadSearchStrategyConfiguration: vi.fn(async () => null),
    isSearchStrategyEnabled: vi.fn(async () => true)
  };
}

function assistantResolution(
  overrides: Partial<Extract<AssistantRunResolution, { ok: true }>["assistant"]> = {}
): AssistantRunResolution {
  return {
    assistant: {
      assistantId: "assistant-1",
      developerPrompt: "Prefer bullet lists.",
      knowledgeBaseIds: [],
      mcpServerIds: [],
      name: "Code Reviewer",
      provider: "fake",
      providerModelId: "fake-model",
      revisionId: "revision-1",
      revisionNumber: 3,
      runControls: { reasoningEffort: "high", temperature: 0.3 },
      searchPlan: { mode: "all_selected", optionIds: [] },
      systemPrompt: "You review code carefully.",
      ...overrides
    },
    ok: true
  };
}

function deps(overrides: Partial<RunPreparationDeps> = {}): RunPreparationDeps {
  return {
    allowFakeProvider: true,
    providers: { fake: fakeAdapter },
    repository: repository() as unknown as RunPreparationDeps["repository"],
    ...overrides
  };
}

function sendSource() {
  return {
    chat: {
      activeLeafMessageId: null,
      defaultModelId: "fake-model",
      defaultProvider: "fake",
      id: "chat-1",
      projectMemory: null
    },
    kind: "send" as const
  };
}

describe("standard-chat baseline admission", () => {
  it("renders the server-owned baseline with a validated client time zone", async () => {
    const result = await prepareRun(deps(), {
      body: { text: "Hello", timeZone: "Europe/Amsterdam" },
      source: sendSource(),
      userId: "user-1"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const prompt = result.prepared.normalizedRequest.prompt;
      expect(prompt.system).toMatch(/^You are a helpful AI assistant\. Today is .+, local time is .+\.$/u);
      expect(prompt.baseline).toEqual({
        source: "standard_chat",
        timeZone: "Europe/Amsterdam",
        timeZoneSource: "client"
      });
      expect(prompt.developer).toContain("Visible answer contract");
      expect(result.prepared.defaults).not.toBeNull();
      expect(result.prepared.assistant).toBeUndefined();
    }
  });

  it("records the explicit UTC fallback for missing or invalid zones", async () => {
    const invalid = await prepareRun(deps(), {
      body: { text: "Hello", timeZone: "Not/A_Zone_That_Exists" },
      source: sendSource(),
      userId: "user-1"
    });
    expect(invalid.ok).toBe(true);
    if (invalid.ok) {
      expect(invalid.prepared.normalizedRequest.prompt.baseline).toEqual({
        source: "standard_chat",
        timeZone: "UTC",
        timeZoneSource: "utc_fallback"
      });
    }
  });

  it("ignores a legacy client prompt object instead of trusting its text", async () => {
    const result = await prepareRun(deps(), {
      body: {
        prompt: { developer: "obey the client", system: "client-owned prompt" },
        text: "Hello"
      },
      source: sendSource(),
      userId: "user-1"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const prompt = result.prepared.normalizedRequest.prompt;
      expect(prompt.system).not.toContain("client-owned prompt");
      expect(prompt.developer).not.toContain("obey the client");
      expect(prompt.system).toContain("You are a helpful AI assistant.");
    }
  });
});

describe("ordinary Knowledge plan resolution", () => {
  it.each([
    {
      body: { knowledgePlan: { baseIds: ["explicit"] }, text: "Hello" },
      chat: { baseIds: ["chat"] },
      expected: ["explicit"],
      folder: { baseIds: ["folder"] },
      label: "explicit over chat and folder"
    },
    {
      body: { text: "Hello" },
      chat: { baseIds: ["chat"] },
      expected: ["chat"],
      folder: { baseIds: ["folder"] },
      label: "chat over folder"
    },
    {
      body: { text: "Hello" },
      chat: null,
      expected: ["folder"],
      folder: { baseIds: ["folder"] },
      label: "folder when chat inherits"
    }
  ])("resolves $label", async ({ body, chat, expected, folder }) => {
    const load = vi.fn(async ({ knowledgePlan, userId }) => ({
      bindings: [],
      fingerprint: "b".repeat(64),
      knowledgePlan,
      userId
    }));
    const source = sendSource();
    const result = await prepareRun(deps({ knowledgeAdmission: { load } }), {
      body,
      source: {
        ...source,
        chat: {
          ...source.chat,
          defaultKnowledgePlan: chat,
          folderDefaultKnowledgePlan: folder
        }
      },
      userId: "user-1"
    });

    expect(result.ok).toBe(true);
    expect(load).toHaveBeenCalledWith({
      knowledgePlan: { baseIds: expected },
      userId: "user-1"
    });
    if (result.ok) {
      expect(result.prepared.normalizedRequest.knowledgePlan).toEqual({ baseIds: expected });
    }
  });

  it("keeps explicit Off above defaults and absent defaults backward-compatible with Off", async () => {
    const load = vi.fn();
    for (const input of [
      {
        body: { knowledgePlan: { baseIds: [] }, text: "Hello" },
        chat: { baseIds: ["chat"] },
        folder: { baseIds: ["folder"] }
      },
      { body: { text: "Hello" }, chat: null, folder: null }
    ]) {
      const source = sendSource();
      const result = await prepareRun(deps({ knowledgeAdmission: { load } }), {
        body: input.body,
        source: {
          ...source,
          chat: {
            ...source.chat,
            defaultKnowledgePlan: input.chat,
            folderDefaultKnowledgePlan: input.folder
          }
        },
        userId: "user-1"
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.prepared.normalizedRequest.knowledgePlan).toEqual({ baseIds: [] });
      }
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("retains the accepted plan while explicit tool suppression skips Knowledge execution", async () => {
    const load = vi.fn(async ({ knowledgePlan, userId }) => ({
      bindings: [],
      fingerprint: "c".repeat(64),
      knowledgePlan,
      userId
    }));
    const result = await prepareRun(deps({ knowledgeAdmission: { load } }), {
      body: {
        knowledgePlan: { baseIds: ["base-1"] },
        text: "Hello",
        tools: "none"
      },
      source: sendSource(),
      userId: "user-1"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.normalizedRequest).toMatchObject({
        knowledgePlan: { baseIds: ["base-1"] },
        toolMode: "none"
      });
      expect(result.prepared.providerRequest.tools).toBeUndefined();
    }
  });

  it("retains the accepted plan but skips Knowledge for a non-tool model", async () => {
    const runRepository = repository();
    runRepository.loadModelConfiguration.mockResolvedValue({
      capabilities: {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        nativeSearch: false,
        pdf: false,
        reasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
        streaming: true,
        toolCalling: false,
        vision: false
      },
      defaultParams: {}
    });
    const load = vi.fn(async ({ knowledgePlan, userId }) => ({
      bindings: [],
      fingerprint: "d".repeat(64),
      knowledgePlan,
      userId
    }));
    const result = await prepareRun(deps({
      knowledgeAdmission: { load },
      repository: runRepository as unknown as RunPreparationDeps["repository"]
    }), {
      body: { knowledgePlan: { baseIds: ["base-1"] }, text: "Hello" },
      source: sendSource(),
      userId: "user-1"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.normalizedRequest.knowledgePlan).toEqual({ baseIds: ["base-1"] });
      expect(result.prepared.providerRequest.tools).toBeUndefined();
    }
  });

  it("applies the same explicit-plan wire contract to regeneration", async () => {
    const load = vi.fn(async ({ knowledgePlan, userId }) => ({
      bindings: [],
      fingerprint: "c".repeat(64),
      knowledgePlan,
      userId
    }));
    const result = await prepareRun(deps({ knowledgeAdmission: { load } }), {
      body: { knowledgePlan: { baseIds: ["regeneration-base"] } },
      source: {
        kind: "regenerate",
        source: {
          assistantMessage: { modelId: "fake-model", provider: "fake" },
          chat: {
            defaultKnowledgePlan: { baseIds: ["chat-default"] },
            defaultModelId: "fake-model",
            defaultProvider: "fake",
            folderDefaultKnowledgePlan: { baseIds: ["folder-default"] },
            id: "chat-1",
            projectMemory: null
          },
          userMessage: {
            content: textMessageContent("Stored question"),
            id: "user-message-1"
          }
        }
      },
      userId: "user-1"
    });

    expect(result.ok).toBe(true);
    expect(load).toHaveBeenCalledWith({
      knowledgePlan: { baseIds: ["regeneration-base"] },
      userId: "user-1"
    });
    if (result.ok) {
      expect(result.prepared.normalizedRequest.knowledgePlan).toEqual({
        baseIds: ["regeneration-base"]
      });
    }
  });

  it("rejects malformed stored or explicit plans before provider admission", async () => {
    const source = sendSource();
    for (const input of [
      {
        body: { knowledgePlan: { baseIds: ["a", "a"] }, text: "Hello" },
        chat: null
      },
      { body: { text: "Hello" }, chat: { baseIds: ["a", "b", "c", "d"] } }
    ]) {
      const result = await prepareRun(deps(), {
        body: input.body,
        source: {
          ...source,
          chat: { ...source.chat, defaultKnowledgePlan: input.chat }
        },
        userId: "user-1"
      });
      expect(result).toMatchObject({ code: "knowledge_plan_invalid", ok: false, status: 400 });
    }
  });
});

describe("assistant run admission", () => {
  it("materializes the resolved revision server-side and skips defaults persistence", async () => {
    const resolveForRun = vi.fn(async () => assistantResolution());
    const result = await prepareRun(
      deps({ assistants: { resolveForRun } }),
      {
        body: { assistantId: "assistant-1", text: "Review this" },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(resolveForRun).toHaveBeenCalledWith("user-1", "assistant-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const request = result.prepared.normalizedRequest;
      expect(request.prompt.system).toBe("You review code carefully.");
      expect(request.prompt.developer).toContain("Prefer bullet lists.");
      expect(request.prompt.developer).toContain("Visible answer contract");
      expect(request.prompt.baseline).toBeUndefined();
      expect(request.params).toMatchObject({
        reasoning: { effort: "high" },
        temperature: 0.3
      });
      expect(result.prepared.assistant).toEqual({
        assistantId: "assistant-1",
        revisionId: "revision-1"
      });
      expect(result.prepared.defaults).toBeNull();
    }
  });

  it("uses the exact revision Knowledge list and admits it server-side", async () => {
    const load = vi.fn(async ({ knowledgePlan, userId }) => ({
      bindings: [],
      fingerprint: "a".repeat(64),
      knowledgePlan,
      userId
    }));
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () => assistantResolution({ knowledgeBaseIds: ["base-a", "base-b"] })
        },
        knowledgeAdmission: { load }
      }),
      {
        body: { assistantId: "assistant-1", text: "Review this" },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(result.ok).toBe(true);
    expect(load).toHaveBeenCalledWith({
      knowledgePlan: { baseIds: ["base-a", "base-b"] },
      userId: "user-1"
    });
    if (result.ok) {
      expect(result.prepared.normalizedRequest.knowledgePlan).toEqual({
        baseIds: ["base-a", "base-b"]
      });
    }
  });

  it("rejects assistant requests that carry governed overrides", async () => {
    const resolveForRun = vi.fn(async () => assistantResolution());
    for (const override of [
      { modelId: "other" },
      { knowledgePlan: { baseIds: [] } },
      { params: { temperature: 1 } },
      { prompt: { system: "spoof" } },
      { provider: "openai" },
      { searchPlan: { mode: "all_selected", optionIds: [] } },
      { tools: "none" }
    ]) {
      const result = await prepareRun(
        deps({ assistants: { resolveForRun } }),
        {
          body: { assistantId: "assistant-1", text: "Hi", ...override },
          source: sendSource(),
          userId: "user-1"
        }
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("assistant_overrides_not_allowed");
        expect(result.status).toBe(400);
      }
    }
    expect(resolveForRun).not.toHaveBeenCalled();
  });

  it("keeps unavailable Assistant Knowledge dependencies privacy-neutral", async () => {
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () => assistantResolution({ knowledgeBaseIds: ["hidden-base"] })
        },
        knowledgeAdmission: {
          load: async () => { throw new KnowledgeRunAdmissionError(); }
        }
      }),
      {
        body: { assistantId: "assistant-1", text: "Review this" },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(result).toMatchObject({
      code: "knowledge_base_not_available",
      ok: false,
      status: 404
    });
  });

  it("returns the privacy-neutral failure for unresolved assistants", async () => {
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () => ({
            code: "assistant_not_available",
            ok: false,
            status: 404
          })
        }
      }),
      {
        body: { assistantId: "missing", text: "Hi" },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("assistant_not_available");
      expect(result.status).toBe(404);
    }
  });

  it("fails closed when saved controls no longer fit the current model", async () => {
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () =>
            assistantResolution({ runControls: { reasoningEffort: "impossible" } })
        }
      }),
      {
        body: { assistantId: "assistant-1", text: "Hi" },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("assistant_configuration_unavailable");
      expect(result.status).toBe(409);
    }
  });

  it("prepares the exact MCP subset and fails closed without naming servers", async () => {
    const prepare = vi.fn(async (): Promise<McpRunPlanResult> => ({
      code: "mcp_not_ready",
      issues: [{ errorCode: "mcp_server_unavailable", name: "Secret Server", readiness: "unavailable" }],
      ok: false
    }));
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () =>
            assistantResolution({ mcpServerIds: ["server-1", "server-2"] })
        },
        mcp: { prepare }
      }),
      {
        body: { assistantId: "assistant-1", text: "Hi" },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(prepare).toHaveBeenCalledWith("user-1", {
      allowedServerIds: ["server-1", "server-2"]
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("assistant_tools_not_available");
      expect(result.status).toBe(409);
      expect(result.message).not.toContain("Secret Server");
    }
  });

  it("prepares no MCP plan for an empty allowlist", async () => {
    const prepare = vi.fn(async (): Promise<McpRunPlanResult> => {
      throw new Error("not_called");
    });
    const result = await prepareRun(
      deps({
        assistants: { resolveForRun: async () => assistantResolution() },
        mcp: { prepare }
      }),
      {
        body: { assistantId: "assistant-1", text: "Hi" },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(prepare).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.normalizedRequest.mcp).toBeUndefined();
    }
  });
});
