const allowMcpTools: import("../mcp/toolAccess").McpToolAccessFilter = async (_userId, tools) => [...tools];
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrozenSkillManifest } from "../skills/runManifest";
import { ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH, assistantRowsFromLegacyFields, type AssistantRows } from "../../contracts/assistants";
import { assistantRowContextLoader } from "@/tests/support/assistantRuns";
import type { ChatAssistantOverridesPatch } from "../../contracts/chats";
import { nextChatAssistantOverrides } from "../chats/assistantOverrides";
import { ANSWER_RULES_MAX_LENGTH, RESPONSE_REMINDER_MAX_LENGTH } from "../../contracts/instructionPresets";
import type { KnowledgeSelection } from "../../contracts/knowledge";
import { textMessageContent } from "../../domain/content";
import { VISIBLE_ANSWER_CONTRACT } from "../../domain/promptTemplates";
import { providerInstructionsWithPersonalContext } from "../providers/personalContext";
import { withResponseReminder } from "../providers/responseReminder";
import type { McpRunPlanResult } from "../mcp/runPlan";
import type { AssistantRunResolution } from "../assistants/runMaterialization";
import {
  KnowledgeRunAdmissionError,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import { KNOWLEDGE_SEARCH_TOOL_NAME } from "../knowledge/retrievalTypes";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import type { ProviderAdapter, ProviderModelCapabilities } from "../providers/types";
import { SESSION_STATUS_TOOL_NAME } from "../tools/sessionStatus";
import { READ_TOOL_CALL_NAME } from "./toolHistoryContract";
import { materializePreparedRunData, prepareRun, type RunPreparationDeps } from "./runPreparation";

const fakeAdapter = {
  buildRequestPreview: () => ({ provider: "fake" }),
  async run() {
    throw new Error("not_used");
  }
} as unknown as ProviderAdapter;

function repository() {
  return {
    loadWorkspaceFileFacts: async () => ({ hasFiles: false, hasEarlierExports: false }),
    loadAttachments: vi.fn(async () => []),
    loadConversationContextForExpectedLeaf: vi.fn(async () => []),
    loadConversationContextForLeaf: vi.fn(async () => []),
    loadAssistantRowContext: vi.fn(assistantRowContextLoader({
      defaultModelId: "fake-model",
      models: { "fake-model": "fake", "other-model": "fake" }
    })),
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

type AssistantFixture = Extract<AssistantRunResolution, { ok: true }>["assistant"];

/** Flat fields become fixed rows, as migrated definitions are; `rows` replaces them. */
function assistantResolution(
  overrides: Partial<Omit<AssistantFixture, "rows">> & { rows?: Partial<AssistantRows> } = {}
): AssistantRunResolution {
  const { rows, ...fields } = overrides;
  const flat: Omit<AssistantFixture, "rows"> = {
    assistantId: "assistant-1",
    knowledgeSelection: knowledgeSelection(),
    mcpServerIds: [],
    name: "Code Reviewer",
    provider: "fake",
    providerModelId: "fake-model",
    definitionVersion: 3,
    identity: { name: "Code Reviewer", avatar: { accents: [], backgroundShape: "circle", foregroundShape: "ring", kind: "generated", paletteId: "ember", recipeVersion: 1, rotations: [0, 0] } },
    runControls: { reasoningEffort: "high", temperature: 0.3 },
    searchPlan: { mode: "all_selected", optionIds: [] },
    skillIds: [],
    systemPrompt: "You review code carefully.",
    ...fields
  };
  return {
    assistant: {
      ...flat,
      rows: {
        ...assistantRowsFromLegacyFields({ ...flat, providerModelId: flat.providerModelId ?? "fake-model" }),
        ...rows
      }
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
    adapterKind: "openai_chat_completions_compatible" as const,
    capabilities,
    defaultParams: {}
  };
  return {
    answer: {
      credentialSource: "default",
      modelConfiguration,
      snapshot: {
        connection: {
          allowPrivateNetwork: false,
          apiRoot: "https://compatible.example.test/v1",
          authenticationMode: "bearer",
          responseTimeoutMs: 300_000
        },
        connectionDisplayName: "Fake",
        connectionId: input.providerConnectionId,
        credentialId: "credential-compatible",
        credentialVersionId: "credential-version-compatible",
        model: {
          adapterKind: "openai_chat_completions_compatible",
          answerSelectable: true,
          capabilities,
          defaultParams: {},
          modelClass: "answer",
          upstreamModelId: input.providerModelId
        },
        modelDisplayName: "Fake model",
        providerFamily: "openai_compatible",
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
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toBeUndefined();
      expect(result.prepared.normalizedRequest.toolMode).toBe("auto");
      expect(result.prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
        KNOWLEDGE_SEARCH_TOOL_NAME,
        SESSION_STATUS_TOOL_NAME,
        READ_TOOL_CALL_NAME
      ]);
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

  it("keeps selected Knowledge active when ordinary client tools are suppressed", async () => {
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
        knowledgePlan: knowledgeSelection(["base-1"]),
        toolMode: "auto"
      });
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toBeUndefined();
      expect(result.prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
        KNOWLEDGE_SEARCH_TOOL_NAME,
        SESSION_STATUS_TOOL_NAME,
        READ_TOOL_CALL_NAME
      ]);
    }
  });

  it("rejects selected Knowledge for a non-tool answer model", async () => {
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

    expect(result).toMatchObject({
      code: "knowledge_tool_calling_not_supported",
      ok: false,
      status: 400
    });
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
            id: "user-message-1",
            scheduledTaskPrompt: false
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
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toBeUndefined();
      expect(result.prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
        KNOWLEDGE_SEARCH_TOOL_NAME,
        SESSION_STATUS_TOOL_NAME,
        READ_TOOL_CALL_NAME
      ]);
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
  it.each(["", "Assistant reminder"])("uses only the Assistant reminder and never personal presets (%s)", async responseReminder => {
    const instructions = { resolveForRun: vi.fn() };
    const result = await prepareRun(deps({ instructions, assistants: { resolveForRun: async () => assistantResolution({ responseReminder }) } }),
      { body: { assistantId: "assistant-1", text: "Review this" }, source: sendSource(), userId: "user-1" });
    expect(instructions.resolveForRun).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.normalizedRequest.prompt.responseReminder).toBe(responseReminder);
      expect(result.prepared.normalizedRequest.prompt.personalInstructions).toBeUndefined();
    }
  });

  it("materializes the resolved definition server-side and skips defaults persistence", async () => {
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
      expect(request.prompt.system).toMatch(/^Today is .+, local time is .+ UTC\.\n\nYou review code carefully\.$/u);
      expect(request.prompt.developer).toBe(VISIBLE_ANSWER_CONTRACT);
      expect(request.prompt.baseline).toEqual({
        source: "assistant_chat",
        timeZone: "UTC",
        timeZoneSource: "utc_fallback"
      });
      expect(request.params).toMatchObject({
        reasoning: { effort: "high" },
        temperature: 0.3
      });
      expect(request.reasoningEffort).toBe("high");
      expect(result.prepared.assistant).toEqual({
        assistantId: "assistant-1",
        definitionVersion: 3,
        identity: { name: "Code Reviewer", avatar: { accents: [], backgroundShape: "circle", foregroundShape: "ring", kind: "generated", paletteId: "ember", recipeVersion: 1, rotations: [0, 0] } },
        rows: { controls: "assistant", knowledge: "assistant", model: "assistant", search: "assistant", skills: "assistant", tools: "assistant" }
      });
      expect(result.prepared.defaults).toBeNull();
    }
  });

  it("uses the current Assistant Knowledge list and admits it server-side", async () => {
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
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toBeUndefined();
      expect(result.prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
        KNOWLEDGE_SEARCH_TOOL_NAME,
        SESSION_STATUS_TOOL_NAME,
        READ_TOOL_CALL_NAME
      ]);
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
        definitionVersion: 3,
        identity: { name: "Code Reviewer", avatar: { accents: [], backgroundShape: "circle", foregroundShape: "ring", kind: "generated", paletteId: "ember", recipeVersion: 1, rotations: [0, 0] } },
        rows: { controls: "assistant", knowledge: "assistant", model: "assistant", search: "assistant", skills: "assistant", tools: "assistant" }
      });
      expect(result.prepared.knowledgeAdmissionPlan?.sources).toEqual([
        expect.objectContaining({
          authority: { knowledgeBaseIds: [], owner: true, projectId: null },
          directSelected: true,
          sourceId
        })
      ]);
      expect(result.prepared.normalizedRequest.knowledgeFocusedRequest).toBeUndefined();
      expect(result.prepared.normalizedRequest).not.toHaveProperty("knowledgePlanner");
      expect(result.prepared.normalizedRequest.toolMode).toBe("auto");
      expect(result.prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
        KNOWLEDGE_SEARCH_TOOL_NAME,
        SESSION_STATUS_TOOL_NAME,
        READ_TOOL_CALL_NAME
      ]);
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
        { alias: "skill-1", revisionId: "revision-skill-assistant", skillId: "skill-assistant" },
        { alias: "skill-2", revisionId: "revision-skill-shared", skillId: "skill-shared" },
        { alias: "skill-3", revisionId: "revision-skill-manual", skillId: "skill-manual" }
      ]);
      expect(decodeFrozenSkillManifest(result.prepared.normalizedRequest.skills)?.pinned.map((skill) => skill.skillId)).toEqual([
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
            skillIds: Array.from({ length: 32 }, (_, index) => `skill-${index + 1}`)
          })
        },
        skills: { resolveForRun: resolveSkills }
      }),
      {
        body: {
          assistantId: "assistant-1",
          skillIds: ["skill-32", "skill-33"],
          text: "Review this"
        },
        source: sendSource(),
        userId: "user-1"
      }
    );

    expect(result).toMatchObject({ code: "skills_count_exceeded", ok: false, status: 400, skillValidation: { actual: 33, limit: 32 } });
    expect(resolveSkills).not.toHaveBeenCalled();
  });

  it("refuses a value for a fixed row, even a malformed one", async () => {
    const resolveForRun = vi.fn(async () => assistantResolution());
    for (const override of [
      { modelId: "other" },
      { knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 } },
      { params: { temperature: 1 } },
      { controlDefaults: { temperature: "1" } },
      { provider: "openai" },
      { searchPlan: { mode: "all_selected", optionIds: [] } },
      { searchPlan: "malformed" },
      { mcp: { mode: "off" } },
      { skills: { mode: "off" } },
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
      expect(result).toMatchObject({ code: "assistant_overrides_not_allowed", ok: false, status: 400 });
    }
  });

  it("refuses the prompt and the Search preference before resolving the Assistant", async () => {
    const resolveForRun = vi.fn(async () => assistantResolution());
    for (const override of [
      { prompt: { system: "spoof" } },
      { searchPreferencePlan: { mode: "all_selected", optionIds: [] } },
      { searchPreferenceSource: "organization" }
    ]) {
      const result = await prepareRun(
        deps({ assistants: { resolveForRun } }),
        { body: { assistantId: "assistant-1", text: "Hi", ...override }, source: sendSource(), userId: "user-1" }
      );
      expect(result).toMatchObject({ code: "assistant_overrides_not_allowed", ok: false, status: 400 });
    }
    expect(resolveForRun).not.toHaveBeenCalled();
  });

  it("reports the Assistant's own unavailable Knowledge with the neutral conflict", async () => {
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
      code: "assistant_not_available",
      ok: false,
      status: 409
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
        mcp: { filterTools: allowMcpTools, prepare }
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
        mcp: { filterTools: allowMcpTools, prepare }
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

describe("bound chat Assistant rows", () => {
  type RowsInput = Partial<AssistantRows>;
  const adjustable = <Key extends keyof AssistantRows>(value: AssistantRows[Key]["value"]) =>
    ({ policy: "adjustable" as const, value }) as AssistantRows[Key];
  const fixed = <Key extends keyof AssistantRows>(value: AssistantRows[Key]["value"]) =>
    ({ policy: "fixed" as const, value }) as AssistantRows[Key];

  function resolver(rows: RowsInput = {}, fields: Parameters<typeof assistantResolution>[0] = {}) {
    return vi.fn(async (_userId: string, _assistantId: string) => assistantResolution({ ...fields, rows }));
  }

  function boundSource(chat: Record<string, unknown> = {}) {
    const source = sendSource();
    return { ...source, chat: { ...source.chat, assistantId: "assistant-1", ...chat } };
  }

  function regenerateSource(chat: Record<string, unknown> = {}) {
    return {
      kind: "regenerate" as const,
      source: {
        assistantMessage: { modelId: "fake-model", provider: "fake" },
        chat: { assistantId: "assistant-1", defaultModelId: "fake-model", defaultProvider: "fake", id: "chat-1",
          projectMemory: null, ...chat },
        userMessage: { content: textMessageContent("Stored question"), id: "user-message-1", scheduledTaskPrompt: false }
      }
    };
  }

  function loader(input: Partial<Parameters<typeof assistantRowContextLoader>[0]> = {}) {
    return vi.fn(assistantRowContextLoader({
      defaultModelId: "fake-model",
      models: { "fake-model": "fake", "other-model": "fake" },
      ...input
    }));
  }

  function rowDeps(
    resolveForRun: ReturnType<typeof resolver>,
    load: ReturnType<typeof loader> = loader(),
    overrides: Partial<RunPreparationDeps> = {}
  ) {
    return deps({
      assistants: { resolveForRun },
      repository: { ...repository(), loadAssistantRowContext: load } as unknown as RunPreparationDeps["repository"],
      ...overrides
    });
  }

  function admissionSpy() {
    return vi.fn(async (input: AdmissionInput) => fakeAdmissionPlan(input));
  }

  it("runs a bound chat with its Assistant when the request names none", async () => {
    const resolveForRun = resolver();
    const result = await prepareRun(rowDeps(resolveForRun), {
      body: { text: "Review this" }, source: boundSource(), userId: "user-1"
    });

    if (!result.ok) throw new Error(result.code);
    expect(resolveForRun).toHaveBeenCalledWith("user-1", "assistant-1");
    expect(result.prepared.assistant?.assistantId).toBe("assistant-1");
    expect(result.prepared.chatAssistant).toEqual({ assistantId: "assistant-1", bind: false, overridesPatch: {} });
    expect(result.prepared.defaults).toBeNull();
  });

  it("binds a chat without a binding to the Assistant the request names", async () => {
    for (const source of [sendSource(), { ...sendSource(), draftPersonalChat: true }]) {
      const result = await prepareRun(rowDeps(resolver()), {
        body: { assistantId: "assistant-1", skillIds: [], text: "Hi", workspace: { enabled: false } },
        source,
        userId: "user-1"
      });
      if (!result.ok) throw new Error(result.code);
      expect(result.prepared.chatAssistant).toEqual({ assistantId: "assistant-1", bind: true, overridesPatch: {} });
    }
  });

  it("accepts a request Assistant equal to the binding and refuses a different one", async () => {
    const resolveForRun = resolver();
    const same = await prepareRun(rowDeps(resolveForRun), {
      body: { assistantId: "assistant-1", text: "Hi" }, source: boundSource(), userId: "user-1"
    });
    expect(same.ok && same.prepared.chatAssistant?.bind).toBe(false);

    resolveForRun.mockClear();
    const other = await prepareRun(rowDeps(resolveForRun), {
      body: { assistantId: "assistant-2", text: "Hi" }, source: boundSource(), userId: "user-1"
    });
    expect(other).toMatchObject({ code: "assistant_binding_conflict", ok: false, status: 409 });
    expect(resolveForRun).not.toHaveBeenCalled();
  });

  it("refuses a chat whose Assistant was deleted or is unavailable, substituting nothing", async () => {
    const resolveForRun = resolver();
    for (const body of [{ text: "Hi" }, { assistantId: "assistant-2", text: "Hi" }]) {
      const result = await prepareRun(rowDeps(resolveForRun), {
        body, source: boundSource({ assistantId: null, assistantOverrides: { assistantDeleted: true } }), userId: "user-1"
      });
      expect(result).toMatchObject({ code: "assistant_not_available", ok: false, status: 409 });
    }
    expect(resolveForRun).not.toHaveBeenCalled();

    const unavailable = await prepareRun(rowDeps(vi.fn(async () => ({
      code: "assistant_not_available" as const, ok: false as const, status: 404 as const
    }))), { body: { text: "Hi" }, source: boundSource(), userId: "user-1" });
    expect(unavailable).toMatchObject({ code: "assistant_not_available", ok: false, status: 404 });
  });

  it("keeps a chat without a binding or a request Assistant an ordinary chat", async () => {
    const load = loader();
    const resolveForRun = resolver();
    const result = await prepareRun(rowDeps(resolveForRun, load), {
      body: ordinaryBody({ modelId: "fake-model", provider: "fake", text: "Hi" }),
      source: sendSource(),
      userId: "user-1"
    });

    if (!result.ok) throw new Error(result.code);
    expect(result.prepared.assistant).toBeUndefined();
    expect(result.prepared.chatAssistant).toBeUndefined();
    expect(result.prepared.defaults).not.toBeNull();
    expect(resolveForRun).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("tests the Agent guard against the chat's binding", async () => {
    const result = await prepareRun(rowDeps(resolver()), {
      body: { agentEnabled: true, text: "Hi", workspace: { enabled: true } }, source: boundSource(), userId: "user-1"
    });
    expect(result).toMatchObject({ code: "agent_personal_chat_required", ok: false, status: 400 });
  });

  it("turns Search off for an adjustable row and stores it for the chat", async () => {
    const load = admissionSpy();
    const result = await prepareRun(
      rowDeps(resolver({ search: adjustable<"search">({ mode: "all_selected", optionIds: ["web"] }) }), loader(),
        { providerAdmission: { load } }),
      { body: { searchPlan: { mode: "all_selected", optionIds: [] }, text: "Hi" }, source: boundSource(), userId: "user-1" }
    );

    if (!result.ok) throw new Error(result.code);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ searchPlan: { mode: "all_selected", optionIds: [] } }));
    expect(result.prepared.assistant?.rows?.search).toBe("chat");
    expect(result.prepared.chatAssistant).toEqual({
      assistantId: "assistant-1", bind: false, overridesPatch: { search: { mode: "off" } }
    });
  });

  it("uses the user's Chat defaults for inherit rows and their saved values for the model", async () => {
    const load = admissionSpy();
    const result = await prepareRun(
      rowDeps(
        resolver({
          controls: adjustable<"controls">({}),
          knowledge: adjustable<"knowledge">({ mode: "inherit" }),
          model: adjustable<"model">({ mode: "inherit" }),
          search: adjustable<"search">({ mode: "inherit" }),
          tools: adjustable<"tools">({ mode: "inherit" })
        }, { runControls: {} }),
        loader({
          defaultModelId: "other-model",
          defaults: { search: { mode: "all_selected", optionIds: ["web"] }, tools: { mode: "off" } },
          savedControls: { "other-model": { reasoningEffort: "low" } }
        }),
        { providerAdmission: { load } }
      ),
      { body: { text: "Hi" }, source: boundSource(), userId: "user-1" }
    );

    if (!result.ok) throw new Error(result.code);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      providerConnectionId: "fake",
      providerModelId: "other-model",
      searchPlan: { mode: "all_selected", optionIds: ["web"] }
    }));
    expect(result.prepared.normalizedRequest.params).toMatchObject({ reasoning: { effort: "low" } });
    expect(result.prepared.assistant?.rows).toEqual({
      controls: "default", knowledge: "default", model: "default", search: "default", skills: "assistant", tools: "default"
    });
  });

  it("applies the Assistant's controls only to the Assistant's own model", async () => {
    const rows = {
      controls: adjustable<"controls">({ temperature: 0.3 }),
      model: adjustable<"model">({ mode: "model", modelId: "fake-model" })
    };
    const savedControls = { "fake-model": { reasoningEffort: "medium" }, "other-model": { reasoningEffort: "low" } };
    const own = await prepareRun(rowDeps(resolver(rows), loader({ savedControls })), {
      body: { text: "Hi" }, source: boundSource(), userId: "user-1"
    });
    const other = await prepareRun(rowDeps(resolver(rows), loader({ savedControls })), {
      body: { modelId: "other-model", provider: "fake", text: "Hi" }, source: boundSource(), userId: "user-1"
    });

    if (!own.ok || !other.ok) throw new Error("expected prepared runs");
    expect(own.prepared.normalizedRequest.params).toMatchObject({ reasoning: { effort: "medium" }, temperature: 0.3 });
    expect(own.prepared.assistant?.rows?.controls).toBe("assistant");
    expect(other.prepared.normalizedRequest.modelId).toBe("other-model");
    expect(other.prepared.normalizedRequest.params).toMatchObject({ reasoning: { effort: "low" } });
    expect(other.prepared.normalizedRequest.params.temperature).not.toBe(0.3);
    expect(other.prepared.assistant?.rows).toMatchObject({ controls: "default", model: "chat" });
    expect(other.prepared.chatAssistant?.overridesPatch).toEqual({ model: { mode: "model", modelId: "other-model" } });
  });

  it("falls back for an unavailable adjustable value and refuses an unavailable fixed one", async () => {
    const load = admissionSpy();
    const unavailableModel = loader({ defaultModelId: "other-model", unavailable: ["fake-model"] });
    const fallback = await prepareRun(
      rowDeps(resolver({
        controls: adjustable<"controls">({}),
        model: adjustable<"model">({ mode: "model", modelId: "fake-model" })
      }, { runControls: {} }), unavailableModel, { providerAdmission: { load } }),
      { body: { text: "Hi" }, source: boundSource(), userId: "user-1" }
    );
    if (!fallback.ok) throw new Error(fallback.code);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ providerModelId: "other-model" }));
    expect(fallback.prepared.assistant?.rows?.model).toBe("fallback");

    const refused = await prepareRun(rowDeps(resolver(), unavailableModel), {
      body: { text: "Hi" }, source: boundSource(), userId: "user-1"
    });
    expect(refused).toMatchObject({ code: "assistant_not_available", ok: false, status: 409 });
  });

  it("refuses an unavailable Skill link neutrally whatever the policy", async () => {
    const result = await prepareRun(
      rowDeps(resolver({
        skills: adjustable<"skills">({ links: [{ delivery: "always", skillId: "skill-gone" }], mode: "auto" })
      }), loader({ unavailable: ["skill-gone"] })),
      { body: { text: "Hi" }, source: boundSource(), userId: "user-1" }
    );
    expect(result).toMatchObject({ code: "assistant_not_available", ok: false, status: 409 });
  });

  it("reports request values outside the runner's catalog as an ordinary chat does", async () => {
    const rows = {
      controls: adjustable<"controls">({}),
      knowledge: adjustable<"knowledge">({ mode: "none" }),
      model: adjustable<"model">({ mode: "model", modelId: "fake-model" }),
      search: adjustable<"search">({ mode: "off" }),
      tools: adjustable<"tools">({ mode: "off" })
    };
    const cases: [Record<string, unknown>, string, number][] = [
      [{ modelId: "missing-model", provider: "fake" }, "model_not_available", 403],
      [{ modelId: "fake-model", provider: "another-connection" }, "model_not_available", 403],
      [{ knowledgePlan: knowledgeSelection(["hidden-base"]) }, "knowledge_base_not_available", 404],
      [{ searchPlan: { mode: "all_selected", optionIds: ["hidden-web"] } }, "search_strategy_not_available", 403],
      [{ controlDefaults: { reasoningEffort: "impossible" } }, "invalid_run_params", 400],
      [{ params: { temperature: 1 } }, "invalid_run_params", 400],
      [{ searchPlan: "malformed" }, "search_plan_invalid", 400],
      [{ mcp: { mode: "sometimes" } }, "mcp_selection_invalid", 400]
    ];
    for (const [override, code, status] of cases) {
      const result = await prepareRun(
        rowDeps(resolver(rows, { runControls: {} }), loader({ unavailable: ["hidden-base", "hidden-web"] })),
        { body: { text: "Hi", ...override }, source: boundSource(), userId: "user-1" }
      );
      expect(result).toMatchObject({ code, ok: false, status });
    }
  });

  it("uses stored chat values of adjustable rows and clears those of fixed rows", async () => {
    const load = admissionSpy();
    const result = await prepareRun(
      rowDeps(resolver({ search: adjustable<"search">({ mode: "all_selected", optionIds: ["web"] }) }), loader(),
        { providerAdmission: { load } }),
      {
        body: { text: "Hi" },
        source: boundSource({ assistantOverrides: {
          model: { mode: "model", modelId: "other-model" },
          search: { mode: "off" }
        } }),
        userId: "user-1"
      }
    );

    if (!result.ok) throw new Error(result.code);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      providerModelId: "fake-model",
      searchPlan: { mode: "all_selected", optionIds: [] }
    }));
    expect(result.prepared.assistant?.rows).toMatchObject({ model: "assistant", search: "chat" });
    expect(result.prepared.chatAssistant?.overridesPatch).toEqual({ model: null });
  });

  it("drops stored controls when the request changes the model without new ones", async () => {
    const result = await prepareRun(
      rowDeps(resolver({
        controls: adjustable<"controls">({}),
        model: adjustable<"model">({ mode: "model", modelId: "fake-model" })
      }, { runControls: {} })),
      {
        body: { modelId: "fake-model", provider: "fake", text: "Hi" },
        source: boundSource({ assistantOverrides: {
          controls: { temperature: 0.9 },
          model: { mode: "model", modelId: "other-model" }
        } }),
        userId: "user-1"
      }
    );

    if (!result.ok) throw new Error(result.code);
    expect(result.prepared.normalizedRequest.params.temperature).not.toBe(0.9);
    expect(result.prepared.assistant?.rows?.controls).toBe("default");
    expect(result.prepared.chatAssistant?.overridesPatch).toEqual({ model: { mode: "model", modelId: "fake-model" } });
  });

  it("runs the Assistant's exact tools, a chat mode, or the user's own mode", async () => {
    const prepare = vi.fn(async (): Promise<McpRunPlanResult> => ({
      code: "mcp_not_ready",
      issues: [{ errorCode: "mcp_server_unavailable", name: "My Server", readiness: "unavailable" }],
      ok: false
    }));
    const exact = adjustable<"tools">({ mode: "exact", serverIds: ["server-1"] });
    const chatOff = await prepareRun(rowDeps(resolver({ tools: exact }), loader(), { mcp: { filterTools: allowMcpTools, prepare } }), {
      body: { text: "Hi" }, source: boundSource({ assistantOverrides: { tools: { mode: "off" } } }), userId: "user-1"
    });
    expect(chatOff.ok).toBe(true);
    expect(prepare).not.toHaveBeenCalled();

    const own = await prepareRun(
      rowDeps(resolver({ tools: fixed<"tools">({ mode: "exact", serverIds: ["server-1"] }) }), loader(),
        { mcp: { filterTools: allowMcpTools, prepare } }),
      { body: { text: "Hi" }, source: boundSource(), userId: "user-1" }
    );
    expect(prepare).toHaveBeenLastCalledWith("user-1", { allowedServerIds: ["server-1"] });
    expect(own).toMatchObject({ code: "assistant_tools_not_available", ok: false, status: 409 });

    const inherited = await prepareRun(
      rowDeps(resolver({ tools: adjustable<"tools">({ mode: "inherit" }) }), loader({ defaults: { tools: { mode: "load_all" } } }),
        { mcp: { filterTools: allowMcpTools, prepare } }),
      { body: { text: "Hi" }, source: boundSource(), userId: "user-1" }
    );
    expect(prepare).toHaveBeenLastCalledWith("user-1");
    expect(inherited).toMatchObject({ code: "mcp_not_ready", message: "MCP tools are not ready: My Server.", status: 409 });
  });

  // The current client in a bound chat (`runControlPayload`, Assistant branch):
  // only the keys of rows changed for this chat, manual Skills, the time zone
  // and Workspace, and no `assistantId` outside a new chat's first message.
  const boundChatPayload = {
    searchPlan: { mode: "all_selected", optionIds: [] },
    skillIds: ["skill-manual"],
    timeZone: "Europe/Berlin",
    workspace: { enabled: false }
  };
  // The full ordinary composer payload is never ignored nor turned into
  // overrides for every row.
  const ordinaryPayload = {
    controlDefaults: { maxOutputTokens: "8192", reasoningEffort: "high", temperature: "0.7" },
    modelId: "fake-model",
    params: { maxOutputTokens: 8192, reasoning: { effort: "high" }, temperature: 0.7 },
    provider: "fake",
    searchPlan: { mode: "all_selected", optionIds: [] },
    searchPreferencePlan: { mode: "all_selected", optionIds: [] },
    searchPreferenceSource: "personal",
    skillIds: ["skill-manual"],
    timeZone: "Europe/Berlin",
    workspace: { enabled: false }
  };
  const skillsResolver = () => ({
    resolveForRun: vi.fn(async (_userId: string, skillIds: readonly string[]) => ({
      ok: true as const,
      skills: skillIds.map((skillId) => ({ instructions: "Body", name: skillId, revisionId: `revision-${skillId}`, skillId }))
    }))
  });

  it.each([
    ["send", () => boundSource()],
    ["regenerate", () => regenerateSource()]
  ] as const)("admits the current client's bound-chat payload with the chat's binding (%s)", async (_kind, source) => {
    const resolveForRun = resolver({ search: adjustable<"search">({ mode: "all_selected", optionIds: ["web"] }) });
    const result = await prepareRun(rowDeps(resolveForRun, loader(), { skills: skillsResolver() }), {
      body: { ...boundChatPayload, ...(source().kind === "send" ? { text: "Hi" } : {}) },
      source: source(),
      userId: "user-1"
    });

    if (!result.ok) throw new Error(result.code);
    expect(resolveForRun).toHaveBeenCalledWith("user-1", "assistant-1");
    expect(result.prepared.assistant?.rows?.search).toBe("chat");
    expect(result.prepared.skillBindings?.map((binding) => binding.skillId)).toEqual(["skill-manual"]);
    expect(result.prepared.normalizedRequest.prompt.baseline?.timeZone).toBe("Europe/Berlin");
    expect(result.prepared.chatAssistant).toEqual({
      assistantId: "assistant-1", bind: false, overridesPatch: { search: { mode: "off" } }
    });
  });

  it.each([
    ["send", () => boundSource()],
    ["regenerate", () => regenerateSource()]
  ] as const)("refuses the full ordinary payload in a bound chat and changes nothing (%s)", async (_kind, source) => {
    const resolveForRun = resolver({
      controls: adjustable<"controls">({}),
      model: adjustable<"model">({ mode: "model", modelId: "fake-model" }),
      search: adjustable<"search">({ mode: "all_selected", optionIds: ["web"] })
    }, { runControls: {} });
    const load = loader();
    const result = await prepareRun(rowDeps(resolveForRun, load, { skills: skillsResolver() }), {
      body: { ...ordinaryPayload, ...(source().kind === "send" ? { text: "Hi" } : {}) },
      source: source(),
      userId: "user-1"
    });

    expect(result).toMatchObject({ code: "assistant_overrides_not_allowed", ok: false, status: 400 });
    expect(resolveForRun).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses a request Assistant that differs from the binding on regenerate", async () => {
    const conflict = await prepareRun(rowDeps(resolver()), {
      body: { assistantId: "assistant-2" }, source: regenerateSource(), userId: "user-1"
    });
    expect(conflict).toMatchObject({ code: "assistant_binding_conflict", ok: false, status: 409 });
  });

  it("accepts the composer's controls draft once it holds only fields the model supports", async () => {
    // `buildControlDraft()` (`SavedControlDraft`) always carries backgroundMode,
    // maxOutputTokens, reasoningEffort, streamMode and temperature, plus
    // reasoningMode when supported: numbers as strings, booleans as booleans.
    // The fake model has neither background nor stream controls, for which
    // the draft holds `false`.
    const rows = {
      controls: adjustable<"controls">({}),
      model: adjustable<"model">({ mode: "model", modelId: "fake-model" })
    };
    const fullDraft = { backgroundMode: false, maxOutputTokens: "4096", reasoningEffort: "low", streamMode: false, temperature: "0.4" };
    const { backgroundMode: _background, streamMode: _stream, ...supportedDraft } = fullDraft;
    const accepted = await prepareRun(rowDeps(resolver(rows, { runControls: {} })), {
      body: { controlDefaults: supportedDraft, text: "Hi" }, source: boundSource(), userId: "user-1"
    });

    if (!accepted.ok) throw new Error(accepted.code);
    expect(accepted.prepared.normalizedRequest.params).toMatchObject({
      maxOutputTokens: 4096, reasoning: { effort: "low" }, temperature: 0.4
    });
    expect(accepted.prepared.chatAssistant?.overridesPatch).toEqual({
      controls: { maxOutputTokens: 4096, reasoningEffort: "low", temperature: 0.4 }
    });

    // Every key is known; a value for a control the model lacks is refused
    // like an ordinary invalid param, never dropped silently.
    const refused = await prepareRun(rowDeps(resolver(rows, { runControls: {} })), {
      body: { controlDefaults: fullDraft, text: "Hi" }, source: boundSource(), userId: "user-1"
    });
    expect(refused).toMatchObject({ code: "invalid_run_params", ok: false, status: 400 });
  });

  it.each([
    ["the Model row became fixed", { model: fixed<"model">({ mode: "model", modelId: "fake-model" }) }, []],
    ["the stored model left the catalog", { model: adjustable<"model">({ mode: "model", modelId: "fake-model" }) }, ["other-model"]]
  ] as const)("runs without stored controls once their stored model is cleared: %s", async (_case, rows, unavailable) => {
    const stored = { controls: { temperature: 1.7 }, model: { mode: "model" as const, modelId: "other-model" } };
    const result = await prepareRun(
      rowDeps(resolver({ ...rows, controls: adjustable<"controls">({}) }, { runControls: {} }),
        loader({ unavailable: [...unavailable] })),
      { body: { text: "Hi" }, source: boundSource({ assistantOverrides: stored }), userId: "user-1" }
    );

    if (!result.ok) throw new Error(result.code);
    expect(result.prepared.normalizedRequest.modelId).toBe("fake-model");
    expect(result.prepared.normalizedRequest.params.temperature).not.toBe(1.7);
    expect(result.prepared.assistant?.rows?.controls).not.toBe("chat");
    const patch = result.prepared.chatAssistant!.overridesPatch as ChatAssistantOverridesPatch;
    expect(patch).toEqual({ model: null });
    // What the admission write stores agrees with what ran.
    expect(nextChatAssistantOverrides(stored, patch)).toEqual({});
  });

  it("copies the row provenance into the frozen preparation beside the request", async () => {
    const result = await prepareRun(rowDeps(resolver()), { body: { text: "Hi" }, source: boundSource(), userId: "user-1" });

    if (!result.ok) throw new Error(result.code);
    const materialized = materializePreparedRunData(result.prepared);
    expect(materialized.assistant?.rows).toEqual(result.prepared.assistant?.rows);
    expect(materialized.chatAssistant).toEqual(result.prepared.chatAssistant);
    expect(materialized.normalizedRequest).not.toHaveProperty("rows");
  });
});

describe("assistant prompt composition", () => {
  const BERLIN_BASELINE = "Today is June 7, 2026, local time is 02:34 PM GMT+2.";
  const preset = {
    answerRules: "Preset rules.",
    presetId: "preset-1",
    responseReminder: "Preset reminder.",
    revision: 1,
    selectionVersion: 1,
    systemInstructions: "Preset instructions."
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-07T12:34:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function assistantRun(
    assistant: Parameters<typeof assistantResolution>[0],
    body: Record<string, unknown> = { timeZone: "Europe/Berlin" }
  ) {
    const resolution = assistantResolution(assistant);
    const instructions = { resolveForRun: vi.fn(async () => preset) };
    const result = await prepareRun(
      deps({ instructions, assistants: { resolveForRun: async () => resolution } }),
      { body: { assistantId: "assistant-1", text: "Review this", ...body }, source: sendSource(), userId: "user-1" }
    );
    expect(instructions.resolveForRun).not.toHaveBeenCalled();
    return { resolution, result };
  }

  it("renders instructions, answer rules and reminder with the user's zone", async () => {
    const { resolution, result } = await assistantRun({
      answerRules: "Answer in bullet points as of {local_date}.",
      responseReminder: "Check the clock: {local_time}.",
      systemPrompt: "You review code written before {local_date}."
    });

    if (!result.ok) throw new Error(result.code);
    const system = `${BERLIN_BASELINE}\n\nYou review code written before June 7, 2026.`;
    expect(result.prepared.normalizedRequest.prompt).toMatchObject({
      baseline: { source: "assistant_chat", timeZone: "Europe/Berlin", timeZoneSource: "client" },
      developer: "Answer in bullet points as of June 7, 2026.",
      responseReminder: "Check the clock: 02:34 PM GMT+2.",
      system
    });
    expect(result.prepared.normalizedRequest.prompt.personalInstructions).toBeUndefined();

    const request = materializePreparedRunData(result.prepared).providerRequest;
    const composed = providerInstructionsWithPersonalContext(request);
    expect(composed?.startsWith(
      `${system}\n\nDeveloper instructions:\nAnswer in bullet points as of June 7, 2026.\n\n`
    )).toBe(true);
    expect(composed).not.toContain("Visible answer contract");
    expect(composed).not.toContain("helpful AI assistant");
    expect(composed).not.toContain("Preset");
    const input = withResponseReminder(request, [{ text: "Review this" }], text => ({ text }));
    expect(input).toEqual([{ text: "Review this" }, { text: "Check the clock: 02:34 PM GMT+2." }]);
    // The resolver's materialization, which Skills relevance re-hashes, keeps
    // the unrendered text.
    expect(resolution.ok && resolution.assistant.systemPrompt).toBe(
      "You review code written before {local_date}."
    );
  });

  it.each([null, undefined, "  "])("keeps the ordinary developer block without answer rules (%s)", async answerRules => {
    const { result } = await assistantRun({ answerRules }, {});
    const ordinary = await prepareRun(deps(), {
      body: ordinaryBody({ text: "Hello" }), source: sendSource(), userId: "user-1"
    });

    if (!result.ok || !ordinary.ok) throw new Error("expected prepared runs");
    expect(result.prepared.normalizedRequest.prompt).toMatchObject({
      baseline: { source: "assistant_chat", timeZone: "UTC", timeZoneSource: "utc_fallback" },
      developer: VISIBLE_ANSWER_CONTRACT,
      responseReminder: "",
      system: "Today is June 7, 2026, local time is 12:34 PM UTC.\n\nYou review code carefully."
    });
    expect(result.prepared.normalizedRequest.prompt.developer)
      .toBe(ordinary.prepared.normalizedRequest.prompt.developer);
  });

  it("sends only the date and time sentence for blank instructions", async () => {
    const { result } = await assistantRun({ systemPrompt: " \n " });

    if (!result.ok) throw new Error(result.code);
    expect(result.prepared.normalizedRequest.prompt.system).toBe(BERLIN_BASELINE);
  });

  it("keeps ordinary and preset chat prompts byte for byte", async () => {
    const ordinary = await prepareRun(deps(), {
      body: ordinaryBody({ text: "Hello", timeZone: "Europe/Berlin" }), source: sendSource(), userId: "user-1"
    });
    const presetRun = await prepareRun(deps({ instructions: { resolveForRun: async () => preset } }), {
      body: ordinaryBody({ text: "Hello", timeZone: "Europe/Berlin" }), source: sendSource(), userId: "user-1"
    });

    if (!ordinary.ok || !presetRun.ok) throw new Error("expected prepared runs");
    expect(ordinary.prepared.normalizedRequest.prompt).toMatchObject({
      baseline: { source: "standard_chat", timeZone: "Europe/Berlin", timeZoneSource: "client" },
      developer: VISIBLE_ANSWER_CONTRACT,
      responseReminder: "",
      system: `You are a helpful AI assistant. ${BERLIN_BASELINE}`
    });
    expect(presetRun.prepared.normalizedRequest.prompt).toMatchObject({
      baseline: { source: "standard_chat", timeZone: "Europe/Berlin", timeZoneSource: "client" },
      developer: null,
      personalInstructions: "Preset instructions.\n\nAnswer rules:\nPreset rules.",
      responseReminder: "Preset reminder.",
      system: `You are a helpful AI assistant. ${BERLIN_BASELINE}`
    });
  });

  it("accepts text at the limit and rejects text that exceeds it only after substitution", async () => {
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
    // "{local_date}" has 12 characters and renders as "September 23, 2026" (18).
    const expanding = (limit: number) => "{local_date}".repeat(Math.floor(limit / 12));

    expect((await assistantRun({ systemPrompt: "x".repeat(ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH) })).result.ok).toBe(true);
    for (const assistant of [
      { systemPrompt: expanding(ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH) },
      { answerRules: expanding(ANSWER_RULES_MAX_LENGTH) },
      { responseReminder: expanding(RESPONSE_REMINDER_MAX_LENGTH) }
    ]) {
      const run = vi.fn();
      const result = await prepareRun(
        deps({
          assistants: { resolveForRun: async () => assistantResolution(assistant) },
          providers: { fake: { ...fakeAdapter, run } as unknown as ProviderAdapter }
        }),
        { body: { assistantId: "assistant-1", text: "Hi" }, source: sendSource(), userId: "user-1" }
      );
      expect(result).toMatchObject({ code: "assistant_instructions_expansion_too_large", ok: false, status: 400 });
      expect(run).not.toHaveBeenCalled();
    }
  });
});
