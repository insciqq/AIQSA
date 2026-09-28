import { describe, expect, it, vi } from "vitest";
import type { AssistantRows } from "../../contracts/assistants";
import type { ProjectDefaultsWire } from "../../contracts/projects";
import { textMessageContent } from "../../domain/content";
import { projectAssistantRowDefaults, type AssistantRowContext } from "../assistants/rowContext";
import type { AssistantRunResolution } from "../assistants/runMaterialization";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import type { ProviderAdapter, ProviderModelCapabilities } from "../providers/types";
import type { ProjectRunAdmission } from "./runRepositoryContract";
import { prepareRun, type RunPreparationDeps, type RunPreparationInput } from "./runPreparation";

/*
 * Project chats run Assistants through the same row chain as personal chats,
 * with the Project's defaults and resources as the chain context.
 */

const fakeAdapter = {
  buildRequestPreview: () => ({ provider: "fake" }),
  async run() {
    throw new Error("not_used");
  }
} as unknown as ProviderAdapter;

const capabilities: ProviderModelCapabilities = {
  contextWindow: 128_000,
  defaultMaxOutputTokens: 8_192,
  nativePdfInput: false,
  nativeSearch: false,
  pdf: false,
  reasoning: false,
  streaming: true,
  toolCalling: true,
  vision: false
};

type AdmissionInput = Parameters<NonNullable<RunPreparationDeps["providerAdmission"]>["load"]>[0];

function admissionPlan(input: AdmissionInput): ProviderAdmissionPlan {
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
        connectionDisplayName: "Shared",
        connectionId: input.providerConnectionId,
        credentialId: "credential-shared",
        credentialVersionId: "credential-version-shared",
        model: {
          adapterKind: "openai_chat_completions_compatible",
          answerSelectable: true,
          capabilities,
          defaultParams: {},
          modelClass: "answer",
          upstreamModelId: input.providerModelId
        },
        modelDisplayName: "Shared model",
        providerFamily: "openai_compatible",
        providerModelId: input.providerModelId,
        version: 1
      }
    },
    fingerprint: "f".repeat(64),
    requestedSearchPlan: input.searchPlan,
    searches: [],
    selection: {
      providerConnectionId: input.providerConnectionId,
      providerModelId: input.providerModelId
    },
    userId: input.userId
  };
}

const projectDefaults: ProjectDefaultsWire = {
  assistantId: "assistant-1",
  controlValues: { maxOutputTokens: "2048" },
  knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
  mcpMode: "off",
  providerModelId: "project-model",
  searchPlan: { mode: "all_selected", optionIds: [] }
};

function project(overrides: Partial<ProjectRunAdmission> = {}): ProjectRunAdmission {
  return {
    accessRevision: 1,
    assistantBindings: [{ assistantId: "assistant-1" }, { assistantId: "assistant-2" }],
    defaults: projectDefaults,
    instructions: "",
    instructionsRevision: 1,
    knowledgeBaseIds: ["project-base"],
    mcpServerIds: ["project-mcp"],
    memoryEnabled: false,
    memoryItems: [],
    memoryRevision: 1,
    modelIds: ["project-model", "project-other-model"],
    policy: { externalToolsEnabled: true },
    policyRevision: 1,
    projectId: "project-1",
    role: "CONTRIBUTOR",
    searchOptionIds: ["project-search"],
    skillIds: [],
    ...overrides
  };
}

/** The Project's chain context: only what the Project provides, never the member's own. */
function projectContext(defaults: ProjectDefaultsWire = projectDefaults): AssistantRowContext {
  return {
    available: {
      allMyKnowledge: false,
      knowledgeBaseIds: new Set(["project-base"]),
      knowledgeSourceIds: new Set(),
      mcpServerIds: new Set(["project-mcp"]),
      modelIds: new Set(["project-model", "project-other-model"]),
      searchOptionIds: new Set(["project-search"]),
      skillIds: new Set()
    },
    defaults: projectAssistantRowDefaults(defaults),
    modelConnections: new Map([["project-model", "shared"], ["project-other-model", "shared"]])
  };
}

/** A new Assistant's rows: everything adjustable and inheriting. */
function adjustableRows(overrides: Partial<AssistantRows> = {}): AssistantRows {
  return {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "adjustable", value: { mode: "inherit" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } },
    ...overrides
  };
}

function resolution(assistantId: string, rows: AssistantRows = adjustableRows()): AssistantRunResolution {
  return {
    assistant: {
      assistantId,
      definitionVersion: 2,
      identity: {
        avatar: { accents: [], backgroundShape: "circle", foregroundShape: "ring", kind: "generated",
          paletteId: "ember", recipeVersion: 1, rotations: [0, 0] },
        name: "Project helper"
      },
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      name: "Project helper",
      provider: null,
      providerModelId: null,
      rows,
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds: [],
      systemPrompt: "Help the team."
    },
    ok: true
  };
}

function harness(options: Readonly<{
  context?: AssistantRowContext | null;
  resolve?: (projectId: string, assistantId: string) => Promise<AssistantRunResolution>;
}> = {}) {
  const resolveForProject = vi.fn(options.resolve ?? (async (_projectId: string, assistantId: string) =>
    resolution(assistantId)));
  const resolveForRun = vi.fn(async () => resolution("personal"));
  const loadAssistantRowContext = vi.fn(async () => {
    throw new Error("a Project chat never reads the member's personal context");
  });
  const loadProjectAssistantRowContext = vi.fn(async () =>
    options.context === undefined ? projectContext() : options.context);
  const load = vi.fn(async (input: AdmissionInput) => admissionPlan(input));
  const prepareProject = vi.fn(async () => ({
    code: "mcp_not_ready" as const,
    issues: [{ errorCode: "runtime_unavailable", name: "Team tools", readiness: "unavailable" as const }],
    ok: false as const
  }));
  const deps: RunPreparationDeps = {
    allowFakeProvider: true,
    assistants: { resolveForProject, resolveForRun },
    mcp: { filterTools: async (_userId, tools) => [...tools], prepare: vi.fn(), prepareProject },
    providerAdmission: { load },
    providers: { openai_compatible: fakeAdapter },
    repository: {
      loadAssistantRowContext,
      loadAttachments: vi.fn(async () => []),
      loadConversationContextForExpectedLeaf: vi.fn(async () => []),
      loadConversationContextForLeaf: vi.fn(async () => []),
      loadProjectAssistantRowContext
    } as unknown as RunPreparationDeps["repository"]
  };
  return { deps, load, loadAssistantRowContext, loadProjectAssistantRowContext, prepareProject, resolveForProject, resolveForRun };
}

function projectSend(
  body: Record<string, unknown>,
  chat: Readonly<{ assistantId?: string | null; draft?: boolean }> = {}
): RunPreparationInput {
  return {
    body: { content: textMessageContent("Plan the release"), ...body },
    source: {
      chat: {
        activeLeafMessageId: null,
        ...(chat.assistantId !== undefined ? { assistantId: chat.assistantId } : {}),
        defaultModelId: "project-model",
        defaultProvider: "shared",
        id: "chat-1",
        project: project(),
        projectMemory: null
      },
      ...(chat.draft ? { draftProjectChat: true } : {}),
      kind: "send"
    },
    userId: "member-1"
  };
}

async function prepared(deps: RunPreparationDeps, input: RunPreparationInput) {
  const result = await prepareRun(deps, input);
  if (!result.ok) throw new Error(`${result.code}:${result.status}`);
  return result.prepared;
}

describe("Project Assistant admission", () => {
  it("starts a new Project chat bound to the Project's default Assistant, resolved from the Project alone", async () => {
    const h = harness();
    const run = await prepared(h.deps, projectSend({}, { draft: true }));

    expect(h.resolveForProject).toHaveBeenCalledWith("project-1", "assistant-1");
    expect(h.loadProjectAssistantRowContext).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(h.loadAssistantRowContext).not.toHaveBeenCalled();
    expect(h.resolveForRun).not.toHaveBeenCalled();
    expect(run.chatAssistant).toEqual({ assistantId: "assistant-1", bind: true, overridesPatch: {} });
    // Inherit means the Project's defaults: its model and its saved controls.
    expect(run.assistant?.rows).toEqual({
      controls: "default",
      knowledge: "default",
      model: "default",
      search: "default",
      skills: "assistant",
      tools: "default"
    });
    expect(run.normalizedRequest.params.maxOutputTokens).toBe(2048);
    expect(h.load).toHaveBeenLastCalledWith(expect.objectContaining({
      executionScope: "project",
      providerConnectionId: "shared",
      providerModelId: "project-model"
    }));
    expect(run.defaults).toBeNull();
  });

  it("skips an archived, deleted or unbound default and admits the new chat without an Assistant", async () => {
    const unavailable = harness({
      resolve: async () => ({ code: "assistant_not_available", ok: false, status: 404 })
    });
    const withoutDefault = await prepared(unavailable.deps, projectSend({}, { draft: true }));
    expect(withoutDefault.assistant).toBeUndefined();
    expect(withoutDefault.chatAssistant).toBeUndefined();

    // A fixed dependency the Project no longer provides skips it the same way.
    const missingFixed = harness({
      resolve: async (_projectId, assistantId) => resolution(assistantId, adjustableRows({
        model: { policy: "fixed", value: { mode: "model", modelId: "personal-model" } }
      }))
    });
    const skipped = await prepared(missingFixed.deps, projectSend({}, { draft: true }));
    expect(skipped.assistant).toBeUndefined();
    expect(skipped.chatAssistant).toBeUndefined();
  });

  it("keeps an explicitly named unusable Assistant a failed run", async () => {
    const h = harness({
      resolve: async () => ({ code: "assistant_not_available", ok: false, status: 404 })
    });
    await expect(prepareRun(h.deps, projectSend({ assistantId: "assistant-2" }, { draft: true })))
      .resolves.toMatchObject({ code: "assistant_not_available", ok: false, status: 404 });
  });

  it("lets the first message say none or name another Assistant bound to the Project", async () => {
    const none = harness();
    const ordinary = await prepared(none.deps, projectSend({ assistantId: null }, { draft: true }));
    expect(none.resolveForProject).not.toHaveBeenCalled();
    expect(ordinary.assistant).toBeUndefined();

    const other = harness();
    const run = await prepared(other.deps, projectSend({ assistantId: "assistant-2" }, { draft: true }));
    expect(other.resolveForProject).toHaveBeenCalledWith("project-1", "assistant-2");
    expect(run.chatAssistant).toMatchObject({ assistantId: "assistant-2", bind: true });
  });

  it("keeps existing Project chats without a binding running without an Assistant", async () => {
    const h = harness();
    const run = await prepared(h.deps, projectSend({ modelId: "project-model", provider: "shared" }));

    expect(h.resolveForProject).not.toHaveBeenCalled();
    expect(run.assistant).toBeUndefined();
    expect(run.chatAssistant).toBeUndefined();
  });

  it("runs an adjustable row the Project lacks with the Project's default", async () => {
    const h = harness({
      resolve: async (_projectId, assistantId) => resolution(assistantId, adjustableRows({
        model: { policy: "adjustable", value: { mode: "model", modelId: "personal-model" } }
      }))
    });
    const run = await prepared(h.deps, projectSend({}, { assistantId: "assistant-1" }));

    expect(run.assistant?.rows?.model).toBe("fallback");
    expect(run.chatAssistant).toEqual({ assistantId: "assistant-1", bind: false, overridesPatch: {} });
    expect(h.load).toHaveBeenLastCalledWith(expect.objectContaining({ providerModelId: "project-model" }));
  });

  it("refuses the member's personal resources as chat values with the codes of an ordinary Project chat", async () => {
    const cases: Array<[Record<string, unknown>, string, number]> = [
      [{ modelId: "personal-model", provider: "personal" }, "provider_not_available", 403],
      [{ knowledgePlan: { baseIds: ["personal-base"], mode: "explicit", sourceIds: [], version: 1 } },
        "knowledge_base_not_available", 404],
      [{ knowledgePlan: { baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: 1 } },
        "knowledge_base_not_available", 404],
      [{ searchPlan: { mode: "all_selected", optionIds: ["personal-search"] } }, "search_plan_invalid", 404],
      [{ modelId: "project-other-model", provider: "personal" }, "provider_not_available", 403]
    ];
    for (const [body, code, status] of cases) {
      const h = harness();
      await expect(prepareRun(h.deps, projectSend(body, { assistantId: "assistant-1" })))
        .resolves.toMatchObject({ code, ok: false, status });
    }
  });

  it("refuses a Tools value naming servers: chat Tools are modes over the Project's own servers", async () => {
    // A value cannot name an MCP server at all, so no personal server can be requested.
    const h = harness();
    await expect(prepareRun(h.deps, projectSend({ mcp: { mode: "load_all", serverIds: ["project-mcp"] } },
      { assistantId: "assistant-1" }))).resolves.toMatchObject({ code: "mcp_selection_invalid", ok: false, status: 400 });
    expect(h.prepareProject).not.toHaveBeenCalled();
  });

  it("stores accepted chat values of a Project chat and runs Tools over the Project's servers", async () => {
    const h = harness();
    await expect(prepareRun(h.deps, projectSend({ mcp: { mode: "load_all" } }, { assistantId: "assistant-1" })))
      .resolves.toMatchObject({ code: "mcp_not_ready", ok: false, status: 409 });
    expect(h.prepareProject).toHaveBeenCalledWith("member-1", ["project-mcp"]);

    const off = harness();
    const run = await prepared(off.deps, projectSend({
      mcp: { mode: "off" },
      modelId: "project-other-model",
      provider: "shared"
    }, { assistantId: "assistant-1" }));
    expect(off.prepareProject).not.toHaveBeenCalled();
    expect(run.chatAssistant?.overridesPatch).toEqual({
      model: { mode: "model", modelId: "project-other-model" },
      tools: { mode: "off" }
    });
    expect(run.assistant?.rows).toMatchObject({ model: "chat", tools: "chat" });
  });

  it("gives an Assistant's exact Tools the neutral failure and applies its fixed rows", async () => {
    const h = harness({
      resolve: async (_projectId, assistantId) => resolution(assistantId, adjustableRows({
        tools: { policy: "fixed", value: { mode: "exact", serverIds: ["project-mcp"] } }
      }))
    });
    await expect(prepareRun(h.deps, projectSend({}, { assistantId: "assistant-1" })))
      .resolves.toMatchObject({ code: "assistant_tools_not_available", ok: false, status: 409 });
    expect(h.prepareProject).toHaveBeenCalledWith("member-1", ["project-mcp"]);

    await expect(prepareRun(h.deps, projectSend({ mcp: { mode: "off" } }, { assistantId: "assistant-1" })))
      .resolves.toMatchObject({ code: "assistant_overrides_not_allowed", ok: false, status: 400 });
  });

  it("fails closed on the ordinary composer payload and on another Assistant in a bound Project chat", async () => {
    const h = harness();
    await expect(prepareRun(h.deps, projectSend({ prompt: { system: "x" } }, { assistantId: "assistant-1" })))
      .resolves.toMatchObject({ code: "assistant_overrides_not_allowed", ok: false, status: 400 });
    await expect(prepareRun(h.deps, projectSend({ assistantId: "assistant-2" }, { assistantId: "assistant-1" })))
      .resolves.toMatchObject({ code: "assistant_binding_conflict", ok: false, status: 409 });
  });

  it("refuses a Project chat whose Project context cannot be loaded", async () => {
    const h = harness({ context: null });
    await expect(prepareRun(h.deps, projectSend({}, { assistantId: "assistant-1" })))
      .resolves.toMatchObject({ code: "assistant_not_available", ok: false, status: 404 });
  });

  /**
   * The ordinary composer payload of a Project chat, as the shipped client
   * sends it (`runControlPayload`, no Assistant, Project scope).
   */
  const ordinaryProjectPayload = {
    controlDefaults: { maxOutputTokens: "2048" },
    modelId: "project-model",
    params: { maxOutputTokens: 2048 },
    provider: "shared",
    searchPlan: { mode: "all_selected", optionIds: [] },
    timeZone: "Europe/Berlin",
    workspace: { enabled: false }
  };

  it.each([
    ["with a fixed row the payload touches", adjustableRows({
      model: { policy: "fixed", value: { mode: "model", modelId: "project-model" } }
    })],
    ["with every row adjustable", adjustableRows()]
  ])("runs the ordinary composer payload of a new Project chat without the default (%s)", async (_name, rows) => {
    const h = harness({ resolve: async (_projectId, assistantId) => resolution(assistantId, rows) });
    const run = await prepared(h.deps, projectSend(ordinaryProjectPayload, { draft: true }));

    expect(h.resolveForProject).not.toHaveBeenCalled();
    expect(h.loadProjectAssistantRowContext).not.toHaveBeenCalled();
    expect(run.assistant).toBeUndefined();
    expect(run.chatAssistant).toBeUndefined();
    expect(run.normalizedRequest.prompt.baseline?.source).toBe("standard_chat");
    expect(run.normalizedRequest.prompt.system).not.toContain("Help the team.");
  });

  it.each([
    ["its exact Tools are not ready", adjustableRows({
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["project-mcp"] } }
    })],
    ["a control of it does not fit its model", adjustableRows({
      controls: { policy: "fixed", value: { reasoningEffort: "high" } },
      model: { policy: "fixed", value: { mode: "model", modelId: "project-model" } }
    })]
  ])("skips an implicit default as a whole when %s", async (_name, rows) => {
    const h = harness({ resolve: async (_projectId, assistantId) => resolution(assistantId, rows) });
    const run = await prepared(h.deps, projectSend({}, { draft: true }));

    expect(h.resolveForProject).toHaveBeenCalledTimes(1);
    expect(run.assistant).toBeUndefined();
    expect(run.chatAssistant).toBeUndefined();
    expect(run.normalizedRequest.prompt.system).not.toContain("Help the team.");
    // The ordinary run uses the Project's MCP mode (Off), not the Assistant's exact list.
    expect(run.mcpBindings).toBeUndefined();
  });

  it("keeps an explicitly named Assistant's failures", async () => {
    const notReady = harness({
      resolve: async (_projectId, assistantId) => resolution(assistantId, adjustableRows({
        tools: { policy: "fixed", value: { mode: "exact", serverIds: ["project-mcp"] } }
      }))
    });
    await expect(prepareRun(notReady.deps, projectSend({ assistantId: "assistant-1" }, { draft: true })))
      .resolves.toMatchObject({ code: "assistant_tools_not_available", ok: false, status: 409 });

    const control = harness({
      resolve: async (_projectId, assistantId) => resolution(assistantId, adjustableRows({
        controls: { policy: "fixed", value: { reasoningEffort: "high" } },
        model: { policy: "fixed", value: { mode: "model", modelId: "project-model" } }
      }))
    });
    await expect(prepareRun(control.deps, projectSend({ assistantId: "assistant-1" }, { draft: true })))
      .resolves.toMatchObject({ code: "assistant_configuration_unavailable", ok: false, status: 409 });

    const fixedModel = harness({
      resolve: async (_projectId, assistantId) => resolution(assistantId, adjustableRows({
        model: { policy: "fixed", value: { mode: "model", modelId: "project-model" } }
      }))
    });
    await expect(prepareRun(fixedModel.deps, projectSend({ ...ordinaryProjectPayload, assistantId: "assistant-1" },
      { draft: true }))).resolves.toMatchObject({ code: "assistant_overrides_not_allowed", ok: false, status: 400 });
  });
});
