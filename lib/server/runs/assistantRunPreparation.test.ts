import { describe, expect, it, vi } from "vitest";
import type { KnowledgeSelection } from "../../contracts/knowledge";
import { textMessageContent } from "../../domain/content";
import type { McpRunPlanResult } from "../mcp/runPlan";
import type { AssistantRunResolution } from "../assistants/runMaterialization";
import {
  KnowledgeRunAdmissionError,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import type { ProviderAdapter, ProviderModelCapabilities } from "../providers/types";
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
    loadSearchStrategyConfiguration: vi.fn(async () => null),
    isSearchStrategyEnabled: vi.fn(async () => true)
  };
}

function knowledgeSelection(baseIds: readonly string[] = []): KnowledgeSelection {
  return baseIds.length > 0
    ? { baseIds: [...baseIds], mode: "explicit", sourceIds: [], version: 1 }
    : { baseIds: [], mode: "none", sourceIds: [], version: 1 };
}

function assistantResolution(
  overrides: Partial<Extract<AssistantRunResolution, { ok: true }>["assistant"]> = {}
): AssistantRunResolution {
  return {
    assistant: {
      assistantId: "assistant-1",
      developerPrompt: "Prefer bullet lists.",
      knowledgeSelection: knowledgeSelection(),
      mcpServerIds: [],
      name: "Code Reviewer",
      provider: "fake",
      providerModelId: "fake-model",
      revisionId: "revision-1",
      revisionNumber: 3,
      runControls: { reasoningEffort: "high", temperature: 0.3 },
      searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds: [],
      systemPrompt: "You review code carefully.",
      ...overrides
    },
    ok: true
  };
}

type AdmissionInput = Parameters<
  NonNullable<RunPreparationDeps["providerAdmission"]>["load"]
>[0];
type KnowledgeAdmissionInput = Parameters<
  NonNullable<RunPreparationDeps["knowledgeAdmission"]>["load"]
>[0];

function knowledgeAdmissionPlan(
  input: KnowledgeAdmissionInput,
  fingerprintCharacter: string
) {
  return {
    bindings: input.knowledgePlan.mode === "none"
      ? []
      : [{
          approxTokens: 1_000,
          baseContentRevision: 1,
          embeddingCredentialSource: "default" as const,
          embeddingExecutionSnapshot: {} as never,
          embeddingProviderModelId: "embedding-model-1",
          includeWholeBase: true,
          indexedContentRevision: 1,
          indexGenerationId: "generation-1",
          knowledgeBaseId: input.knowledgePlan.baseIds[0] ?? "knowledge-base-1",
          ordinal: 0,
          passageCount: 4,
          readySourceCount: 1,
          selectedSourceIds: input.knowledgePlan.sourceIds,
          sourceCount: 1,
          targetDimension: 1024,
          vectorSpaceFingerprint: "f".repeat(64)
        }],
    budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
    exclusions: [],
    fingerprint: fingerprintCharacter.repeat(64),
    knowledgePlan: input.knowledgePlan,
    resolvedSourceCount: 0,
    ...(input.executionScope ? { executionScope: input.executionScope } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    userId: input.userId
  };
}

function fakeAdmissionPlan(input: AdmissionInput, toolCalling = true): ProviderAdmissionPlan {
  const capabilities: ProviderModelCapabilities = {
    contextWindow: 128_000,
    defaultMaxOutputTokens: 8_192,
    defaultReasoningEffort: "medium",
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    streaming: true,
    toolCalling,
    vision: false
  };
  const modelConfiguration = {
    adapterKind: "fake" as const,
    capabilities,
    defaultParams: {}
  };
  return {
    answer: {
      credentialSource: "default",
      modelConfiguration,
      snapshot: {
        connection: {
          allowPrivateNetwork: true,
          apiRoot: "http://127.0.0.1",
          authenticationMode: "none",
          responseTimeoutMs: 300_000
        },
        connectionDisplayName: "Fake",
        connectionId: input.providerConnectionId,
        credentialId: null,
        credentialVersionId: null,
        model: {
          adapterKind: "fake",
          capabilities,
          defaultParams: {},
          upstreamModelId: input.providerModelId
        },
        modelDisplayName: "Fake model",
        providerFamily: "fake",
        providerModelId: input.providerModelId,
        version: 1
      }
    },
    fingerprint: "f".repeat(64),
    requestedSearchPlan: input.searchPlan,
    ...(input.searchPreferenceSource
      ? {
          requestedSearchPreferencePlan: input.searchPreferencePlan,
          requestedSearchPreferenceSource: input.searchPreferenceSource
        }
      : {}),
    searches: [],
    selection: {
      providerConnectionId: input.providerConnectionId,
      providerModelId: input.providerModelId
    },
    userId: input.userId
  };
}

function deps(overrides: Partial<RunPreparationDeps> = {}): RunPreparationDeps {
  return {
    allowFakeProvider: true,
    providers: { fake: fakeAdapter },
    providerAdmission: { async load(input) { return fakeAdmissionPlan(input); } },
    repository: repository() as unknown as RunPreparationDeps["repository"],
    ...overrides
  };
}

function ordinaryBody<Value extends Record<string, unknown>>(value: Value) {
  return {
    searchPlan: { mode: "all_selected" as const, optionIds: [] as string[] },
    ...value
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
      body: ordinaryBody({ text: "Hello", timeZone: "Europe/Amsterdam" }),
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
      body: ordinaryBody({ text: "Hello", timeZone: "Not/A_Zone_That_Exists" }),
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

  it("ignores an untrusted client prompt object instead of trusting its text", async () => {
    const result = await prepareRun(deps(), {
      body: ordinaryBody({
        prompt: { developer: "obey the client", system: "client-owned prompt" },
        text: "Hello"
      }),
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
      body: ordinaryBody({ knowledgePlan: knowledgeSelection(["explicit"]), text: "Hello" }),
      chat: knowledgeSelection(["chat"]),
      expected: ["explicit"],
      folder: knowledgeSelection(["folder"]),
      label: "explicit over chat and folder"
    },
    {
      body: ordinaryBody({ text: "Hello" }),
      chat: knowledgeSelection(["chat"]),
      expected: ["chat"],
      folder: knowledgeSelection(["folder"]),
      label: "chat over folder"
    },
    {
      body: ordinaryBody({ text: "Hello" }),
      chat: null,
      expected: ["folder"],
      folder: knowledgeSelection(["folder"]),
      label: "folder when chat inherits"
    }
  ])("resolves $label", async ({ body, chat, expected, folder }) => {
    const load = vi.fn(async (input: KnowledgeAdmissionInput) =>
      knowledgeAdmissionPlan(input, "b"));
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
      knowledgePlan: knowledgeSelection(expected),
      userId: "user-1"
    });
    if (result.ok) {
      expect(result.prepared.normalizedRequest.knowledgePlan).toEqual(
        knowledgeSelection(expected)
      );
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toMatchObject({
        originalQuery: "Hello",
        retrievalQuery: "Hello",
        version: 1
      });
    }
  });

  it("keeps explicit Off above defaults and resolves absent defaults to Off", async () => {
    const load = vi.fn();
    for (const input of [
      {
        body: ordinaryBody({ knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 }, text: "Hello" }),
        chat: knowledgeSelection(["chat"]),
        folder: knowledgeSelection(["folder"])
      },
      { body: ordinaryBody({ text: "Hello" }), chat: null, folder: null }
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
        expect(result.prepared.normalizedRequest.knowledgePlan).toEqual(knowledgeSelection());
        expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toBeUndefined();
      }
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps focused Knowledge active while explicit tool suppression removes provider tools", async () => {
    const load = vi.fn(async (input: KnowledgeAdmissionInput) =>
      knowledgeAdmissionPlan(input, "c"));
    const result = await prepareRun(deps({ knowledgeAdmission: { load } }), {
      body: ordinaryBody({
        knowledgePlan: knowledgeSelection(["base-1"]),
        text: "Hello",
        tools: "none"
      }),
      source: sendSource(),
      userId: "user-1"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.normalizedRequest).toMatchObject({
        knowledgeFocusedRequest: {
          originalQuery: "Hello",
          retrievalQuery: "Hello",
          version: 1
        },
        knowledgePlan: knowledgeSelection(["base-1"]),
        toolMode: "none"
      });
      expect(result.prepared.providerRequest.tools).toBeUndefined();
    }
  });

  it("keeps focused Knowledge active for a non-tool answer model", async () => {
    const load = vi.fn(async (input: KnowledgeAdmissionInput) =>
      knowledgeAdmissionPlan(input, "d"));
    const result = await prepareRun(deps({
      knowledgeAdmission: { load },
      providerAdmission: {
        async load(input) {
          return fakeAdmissionPlan(input, false);
        }
      }
    }), {
      body: ordinaryBody({ knowledgePlan: knowledgeSelection(["base-1"]), text: "Hello" }),
      source: sendSource(),
      userId: "user-1"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.normalizedRequest.knowledgePlan).toEqual(
        knowledgeSelection(["base-1"])
      );
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toMatchObject({
        originalQuery: "Hello",
        retrievalQuery: "Hello",
        version: 1
      });
      expect(result.prepared.normalizedRequest.toolMode).toBe("none");
      expect(result.prepared.providerRequest.tools).toBeUndefined();
    }
  });

  it("applies the same explicit-plan wire contract to regeneration", async () => {
    const load = vi.fn(async (input: KnowledgeAdmissionInput) =>
      knowledgeAdmissionPlan(input, "c"));
    const result = await prepareRun(deps({ knowledgeAdmission: { load } }), {
      body: ordinaryBody({ knowledgePlan: knowledgeSelection(["regeneration-base"]) }),
      source: {
        kind: "regenerate",
        source: {
          assistantMessage: { modelId: "fake-model", provider: "fake" },
          chat: {
            defaultKnowledgePlan: knowledgeSelection(["chat-default"]),
            defaultModelId: "fake-model",
            defaultProvider: "fake",
            folderDefaultKnowledgePlan: knowledgeSelection(["folder-default"]),
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
      knowledgePlan: knowledgeSelection(["regeneration-base"]),
      userId: "user-1"
    });
    if (result.ok) {
      expect(result.prepared.normalizedRequest.knowledgePlan).toEqual(
        knowledgeSelection(["regeneration-base"])
      );
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toMatchObject({
        originalQuery: "Stored question",
        retrievalQuery: "Stored question",
        version: 1
      });
    }
  });

  it("rejects malformed stored or explicit plans before provider admission", async () => {
    const source = sendSource();
    for (const input of [
      {
        body: ordinaryBody({ knowledgePlan: { baseIds: ["legacy-base"] }, text: "Hello" }),
        chat: null
      },
      {
        body: ordinaryBody({
          knowledgePlan: {
            baseIds: ["a", "a"], mode: "explicit", sourceIds: [], version: 1
          },
          text: "Hello"
        }),
        chat: null
      },
      {
        body: ordinaryBody({ text: "Hello" }),
        chat: { baseIds: Array.from({ length: 129 }, (_, index) => `base-${index}`) }
      }
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
    const load = vi.fn(async (input: KnowledgeAdmissionInput) =>
      knowledgeAdmissionPlan(input, "a"));
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () => assistantResolution({
            knowledgeSelection: knowledgeSelection(["base-a", "base-b"])
          })
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
      knowledgePlan: knowledgeSelection(["base-a", "base-b"]),
      userId: "user-1"
    });
    if (result.ok) {
      expect(result.prepared.normalizedRequest.knowledgePlan).toEqual(
        knowledgeSelection(["base-a", "base-b"])
      );
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toMatchObject({
        originalQuery: "Review this",
        retrievalQuery: "Review this",
        version: 1
      });
      expect(result.prepared.providerRequest.tools).toBeUndefined();
    }
  });

  it("admits an Assistant direct Source through ordinary user authority", async () => {
    const sourceId = "00000000-0000-4000-8000-000000000001";
    const selection: KnowledgeSelection = {
      baseIds: [],
      mode: "explicit",
      sourceIds: [sourceId],
      version: 1
    };
    const load = vi.fn(async (
      input: KnowledgeAdmissionInput
    ): Promise<KnowledgeRunAdmissionPlan> => ({
      bindings: [],
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      exclusions: [],
      fingerprint: "e".repeat(64),
      knowledgePlan: input.knowledgePlan,
      profiles: [{
        embeddingCredentialSource: "default",
        embeddingExecutionSnapshot: {} as never,
        embeddingProviderModelId: "embedding-model-1",
        ordinal: 0,
        profileRevisionId: "profile-revision-1",
        targetDimension: 1024,
        vectorSpaceFingerprint: "f".repeat(64)
      }],
      resolvedSourceCount: 1,
      sources: [{
        approxTokens: 1_000,
        authority: { knowledgeBaseIds: [], owner: true, projectId: null },
        baseProvenance: [],
        directSelected: true,
        ordinal: 0,
        privateLabels: { fileName: "source-1.md", sourceName: "Source 1" },
        passageCount: 4,
        profileOrdinal: 0,
        profileRevisionId: "profile-revision-1",
        selectionProvenance: ["explicit_source"],
        sourceAlias: "S1",
        sourceArtifactId: "artifact-1",
        sourceId,
        sourceVersionId: "source-version-1",
        sourceVersionNumber: 1
      }],
      userId: input.userId
    }));
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () => assistantResolution({ knowledgeSelection: selection })
        },
        knowledgeAdmission: { load }
      }),
      {
        body: { assistantId: "assistant-1", text: "Review this" },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith({
      knowledgePlan: selection,
      userId: "user-1"
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.assistant).toEqual({
        assistantId: "assistant-1",
        revisionId: "revision-1"
      });
      expect(result.prepared.knowledgeAdmissionPlan?.sources).toEqual([
        expect.objectContaining({
          authority: { knowledgeBaseIds: [], owner: true, projectId: null },
          directSelected: true,
          sourceId
        })
      ]);
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toEqual({
        candidateLimit: 40,
        fusion: "weighted_rrf_v2",
        neighborWindow: 1,
        originalQuery: "Review this",
        resultLimit: 8,
        retrievalQuery: "Review this",
        version: 1
      });
      expect(result.prepared.normalizedRequest).not.toHaveProperty("knowledgePlanner");
      expect(result.prepared.normalizedRequest.toolMode).toBe("none");
      expect(result.prepared.providerRequest.tools).toBeUndefined();
    }
  });

  it("merges Assistant and manual Skills in deterministic order and deduplicates by id", async () => {
    const resolveSkills = vi.fn(async (_userId: string, skillIds: readonly string[]) => ({
      ok: true as const,
      skills: skillIds.map((skillId, index) => ({
        instructions: `Instructions ${index + 1}`,
        name: `Skill ${index + 1}`,
        revisionId: `revision-${skillId}`,
        skillId
      }))
    }));
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () => assistantResolution({
            skillIds: ["skill-assistant", "skill-shared"]
          })
        },
        skills: { resolveForRun: resolveSkills }
      }),
      {
        body: {
          assistantId: "assistant-1",
          skillIds: ["skill-shared", "skill-manual"],
          text: "Review this"
        },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(resolveSkills).toHaveBeenCalledWith("user-1", [
      "skill-assistant",
      "skill-shared",
      "skill-manual"
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.skillBindings).toEqual([
        { revisionId: "revision-skill-assistant", skillId: "skill-assistant" },
        { revisionId: "revision-skill-shared", skillId: "skill-shared" },
        { revisionId: "revision-skill-manual", skillId: "skill-manual" }
      ]);
      expect(result.prepared.normalizedRequest.skills?.map((skill) => skill.skillId)).toEqual([
        "skill-assistant",
        "skill-shared",
        "skill-manual"
      ]);
    }
  });

  it("rejects an effective Assistant and manual Skill union above the global limit", async () => {
    const resolveSkills = vi.fn();
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () => assistantResolution({
            skillIds: Array.from({ length: 8 }, (_, index) => `skill-${index + 1}`)
          })
        },
        skills: { resolveForRun: resolveSkills }
      }),
      {
        body: {
          assistantId: "assistant-1",
          skillIds: ["skill-8", "skill-9"],
          text: "Review this"
        },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(result).toMatchObject({ code: "skills_invalid", ok: false, status: 400 });
    expect(resolveSkills).not.toHaveBeenCalled();
  });

  it("rejects assistant requests that carry governed overrides", async () => {
    const resolveForRun = vi.fn(async () => assistantResolution());
    for (const override of [
      { modelId: "other" },
      { knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 } },
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

  it("keeps a published non-owner Assistant direct Source failure privacy-neutral", async () => {
    const selection: KnowledgeSelection = {
      baseIds: [],
      mode: "explicit",
      sourceIds: ["hidden-source"],
      version: 1
    };
    const load = vi.fn(async () => { throw new KnowledgeRunAdmissionError(); });
    const result = await prepareRun(
      deps({
        assistants: {
          resolveForRun: async () => assistantResolution({
            knowledgeSelection: selection
          })
        },
        knowledgeAdmission: { load }
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
    expect(load).toHaveBeenCalledWith({
      knowledgePlan: selection,
      userId: "user-1"
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
