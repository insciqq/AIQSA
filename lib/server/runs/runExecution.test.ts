import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import {
  GROUNDED_LIVE_ONLY_PLACEHOLDER,
  groundedLiveOnlyProviderPreview
} from "../../domain/grounding";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import type { ResolvedEntitlements } from "../auth/entitlements";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderRunRequest,
  ProviderRunResult,
  ProviderSearchAdapter,
  ProviderSearchRequest
} from "../providers/types";
import {
  activeRunControllerRegistry,
  activeRunControllersForTest,
  createRunExecutionResponse,
  type RunExecutionInput,
  type RunExecutionRepository
} from "./runExecution";
import type { MaterializedPreparedRunData } from "./runPreparation";
import type { RunChatUpdateRecord, RunRepository } from "./runRepositoryContract";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";

type CompleteRunInput = Parameters<RunRepository["completeRun"]>[0];
type CreateSearchRunInput = Parameters<RunRepository["createSearchRun"]>[0];
type RecordRunUsageEventsInput = Parameters<RunRepository["recordRunUsageEvents"]>[0];
type FailedRun = {
  assistantMessageId: string;
  error: { code: string; message: string };
  runId: string;
};
type GroundedMark = Parameters<RunRepository["markAssistantMessageGroundedLiveOnly"]>[0];

type RepositoryOptions = Readonly<{
  chatUpdate?: RunChatUpdateRecord | null;
  completionWins?: boolean;
  entitlements?: ResolvedEntitlements;
  failureWins?: boolean;
  modelAvailable?: boolean;
  searchStrategyEnabled?: boolean;
  responseIdPublication?: "cancelled" | "published" | "terminal";
}>;

function usage(inputTokens = 2, outputTokens = 3, reasoningTokens = 1): ModelRunUsage {
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function providerResult(overrides: Partial<ProviderRunResult> = {}): ProviderRunResult {
  return {
    finalProviderResponsePreview: { response: "safe" },
    finalText: "Final answer",
    usage: usage(),
    ...overrides
  };
}

function preparedData(input: Readonly<{
  chatId?: string;
  contextTruncation?: ContextTruncationSummary | null;
  mcp?: McpRunPlanSnapshot;
  modelId?: string;
  provider?: string;
  searchStrategy?: string | null;
}> = {}): MaterializedPreparedRunData {
  const provider = input.provider ?? "fake";
  const modelId = input.modelId ?? "fake-qsa";
  const searchStrategy = input.searchStrategy ?? "search-disabled";
  const chatId = input.chatId ?? "chat-1";
  const content = textMessageContent("Current question");
  const searchPolicy =
    searchStrategy === "perplexity-tool-search"
      ? {
          controls: {
            maxOutputTokens: {
              defaultValue: 8192,
              maxValue: 8192
            },
            temperature: {
              defaultValue: 1,
              maxValue: 2,
              minValue: 0,
              supported: true
            }
          },
          defaultParams: {
            maxOutputTokens: 1024,
            provider: {
              allowFallbacks: true,
              dataCollection: "deny",
              order: ["perplexity"],
              only: [],
              requireParameters: false,
              sort: "throughput",
              zdr: false
            },
            reasoning: {
              enabled: false,
              exclude: true
            },
            stream: false,
            temperature: 0
          },
          modelId: "perplexity/sonar-pro-search",
          provider: "openrouter" as const,
          strategyId: "perplexity-tool-search" as const
        }
      : undefined;
  const normalizedRequest: NormalizedRunRequest = {
    attachmentIds: [],
    chatId,
    content,
    context: {
      messages: [
        {
          content,
          id: "current-user-message",
          role: "user"
        }
      ],
      mode: "branch_path"
    },
    modelCapabilities: {
      backgroundStreaming: true,
      contextWindow: 32_768,
      defaultMaxOutputTokens: 512,
      nativeBackground: true,
      nativePdfInput: false,
      nativeSearch: false,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    ...(input.mcp ? { mcp: input.mcp } : {}),
    modelId,
    params: {},
    prompt: {
      developer: "Answer directly.",
      presetId: null,
      system: null
    },
    provider,
    ...(searchPolicy ? { searchPolicy } : {}),
    searchStrategy
  };

  return {
    contextTruncation: input.contextTruncation ?? null,
    defaults: {
      controlDefaults: { searchStrategyId: searchStrategy },
      modelId,
      promptPresetId: null,
      provider,
      searchStrategy,
      userId: "user-1"
    },
    expectedActiveLeafId: "prior-user-message",
    normalizedRequest,
    providerRequest: {
      ...normalizedRequest,
      attachments: []
    },
    providerRequestPreview: {},
    sourceKind: "send"
  };
}

function createAdapter(
  stream: ProviderAdapter["stream"],
  previewRequests: ProviderRunRequest[] = []
): ProviderAdapter {
  return {
    buildRequestPreview(request) {
      previewRequests.push(request);
      return {
        modelId: request.modelId,
        providerToolMessageCount: request.providerToolMessages?.length ?? 0,
        toolChoice: request.toolChoice ?? null
      };
    },
    stream
  };
}

function chatUpdate(): RunChatUpdateRecord {
  return {
    chat: {
      activeLeafMessageId: "assistant-1",
      createdAt: new Date("2026-07-12T10:00:00.000Z"),
      defaultModelId: "fake-qsa",
      defaultPromptPresetId: null,
      defaultProvider: "fake",
      folderId: null,
      id: "chat-1",
      messageCount: 2,
      pinned: false,
      title: "Question",
      updatedAt: new Date("2026-07-12T10:01:00.000Z"),
      usageStats: null
    },
    messages: [
      {
        content: textMessageContent("Current question"),
        createdAt: new Date("2026-07-12T10:00:00.000Z"),
        id: "user-message-1",
        modelId: null,
        parentMessageId: null,
        provider: null,
        role: "user",
        status: "complete"
      },
      {
        content: textMessageContent("Final answer"),
        createdAt: new Date("2026-07-12T10:00:01.000Z"),
        id: "assistant-1",
        modelId: "fake-qsa",
        modelRunId: "run-1",
        parentMessageId: "user-message-1",
        provider: "fake",
        role: "assistant",
        runUsage: { totalTokens: 5 },
        status: "complete"
      }
    ]
  };
}

function createRepository(options: RepositoryOptions = {}) {
  const assistantTexts: string[] = [];
  const completeRuns: CompleteRunInput[] = [];
  const failedRuns: FailedRun[] = [];
  const groundedMarks: GroundedMark[] = [];
  const persistedEvents: { event: ModelRunSseEvent; runId: string; sequence: number }[] = [];
  const providerResponseIds: string[] = [];
  const providerRequestPreviews: Record<string, unknown>[] = [];
  const recordedRunUsageEvents: RecordRunUsageEventsInput[] = [];
  const searchRuns: CreateSearchRunInput[] = [];
  const toolCalls = new Map<string, PersistedToolLoopCall>();
  let durableProviderResponsePreview: Record<string, unknown> | null = null;
  let toolCallSequence = 0;
  let chatUpdateLoads = 0;
  const repository: RunExecutionRepository = {
    async advanceToolLoopCallBatch() {
      return "advanced";
    },
    async appendAssistantText(_assistantMessageId, text) {
      assistantTexts.push(text);
    },
    async appendRunEvent(runId, sequence, event) {
      persistedEvents.push({ event, runId, sequence });
    },
    async beginToolLoopProviderRound() {
      return "started";
    },
    async cancelPendingToolLoopCalls() {
      let cancelled = 0;
      for (const [id, call] of toolCalls) {
        if (call.state !== "pending") continue;
        toolCalls.set(id, { ...call, completedAt: new Date().toISOString(), state: "cancelled" });
        cancelled += 1;
      }
      return cancelled;
    },
    async claimToolLoopCall({ callId }) {
      const call = toolCalls.get(callId);
      if (!call) return { kind: "not_found" };
      if (call.state === "running") return { call, kind: "ambiguous" };
      if (call.state === "cancelled") return { call, kind: "cancelled" };
      if (call.state === "complete" || call.state === "error") return { call, kind: "settled" };
      const claimed = { ...call, startedAt: new Date().toISOString(), state: "running" as const };
      toolCalls.set(callId, claimed);
      return { call: claimed, kind: "claimed" };
    },
    async completeRun(input) {
      completeRuns.push(input);
      if (options.completionWins === false) {
        return false;
      }
      durableProviderResponsePreview = input.finalProviderResponsePreview;

      for (const event of [
        ...(input.eventsBeforeTerminal ?? []),
        { data: input.usage, type: "usage" as const },
        {
          data: { runId: input.runId, status: "complete" as const },
          type: "done" as const
        }
      ]) {
        persistedEvents.push({ event, runId: input.runId, sequence: persistedEvents.length });
      }
      return true;
    },
    async createSearchRun(input) {
      searchRuns.push(input);
    },
    async failRun(runId, assistantMessageId, error) {
      if (options.failureWins === false) {
        return false;
      }
      failedRuns.push({ assistantMessageId, error, runId });
      persistedEvents.push({
        event: { data: error, type: "error" },
        runId,
        sequence: persistedEvents.length
      });
      return true;
    },
    async getChatUpdateForRun() {
      chatUpdateLoads += 1;
      return options.chatUpdate ?? null;
    },
    async isSearchStrategyEnabled() {
      return options.searchStrategyEnabled ?? true;
    },
    async loadEntitlements() {
      return (
        options.entitlements ?? {
          modelKeys: new Set<string>(),
          providerKeys: new Set(["fake", "openai", "openrouter"]),
          searchStrategies: new Set(["openai-native-web-search", "perplexity-tool-search"])
        }
      );
    },
    async loadModelConfiguration() {
      if (options.modelAvailable === false) {
        return null;
      }

      return {
        capabilities: {
          contextWindow: 32_768,
          defaultMaxOutputTokens: 512,
          nativePdfInput: false,
          nativeSearch: false,
          pdf: true,
          reasoning: true,
          streaming: true,
          vision: true
        },
        defaultParams: {}
      };
    },
    async loadModelPricing() {
      return null;
    },
    async markAssistantMessageGroundedLiveOnly(input) {
      groundedMarks.push(input);
      durableProviderResponsePreview = groundedLiveOnlyProviderPreview();
      assistantTexts.splice(0);
      for (let index = persistedEvents.length - 1; index >= 0; index -= 1) {
        const event = persistedEvents[index]?.event;
        if (event?.type === "artifact" || event?.type === "token") {
          persistedEvents.splice(index, 1);
        }
      }
      return true;
    },
    async nextRunEventSequence() {
      return persistedEvents.length;
    },
    async persistToolLoopCallBatch(input) {
      const calls = input.calls.map((call) => {
        const existing = [...toolCalls.values()].find((entry) =>
          entry.roundIndex === input.roundIndex && entry.providerCallId === call.providerCallId
        );
        if (existing) return existing;
        const id = `persisted-tool-call-${++toolCallSequence}`;
        const persisted: PersistedToolLoopCall = {
          arguments: call.arguments,
          completedAt: null,
          id,
          mcpBinding: call.runtimeGenerationFingerprint ? {
            id: `binding-${id}`,
            runtimeGenerationFingerprint: call.runtimeGenerationFingerprint,
            runtimeGenerationId: `generation-${call.runtimeGenerationFingerprint}`
          } : null,
          ordinal: call.ordinal,
          providerCallId: call.providerCallId,
          result: null,
          roundIndex: input.roundIndex,
          startedAt: null,
          state: "pending",
          toolName: call.toolName
        };
        toolCalls.set(id, persisted);
        return persisted;
      });
      return { calls, kind: "persisted" };
    },
    async recordRunUsageEvents(input) {
      recordedRunUsageEvents.push(input);
      return true;
    },
    async resetToolLoopAssistantDraft({ roundIndex, runId, sequence }) {
      persistedEvents.push({
        event: { data: { round: roundIndex }, type: "message_reset" },
        runId,
        sequence
      });
      return true;
    },
    async settleToolLoopCall({ callId, result, state }) {
      const call = toolCalls.get(callId);
      if (!call) return "not_found";
      if (call.state === "complete" || call.state === "error") return "reused";
      if (call.state !== "running") return "conflict";
      toolCalls.set(callId, {
        ...call,
        completedAt: new Date().toISOString(),
        result,
        state
      });
      return "settled";
    },
    async updateRunProviderRequestPreview(_runId, preview) {
      providerRequestPreviews.push(preview);
    },
    async updateRunProviderResponseId(_runId, providerResponseId) {
      providerResponseIds.push(providerResponseId);
      return options.responseIdPublication ?? "published";
    }
  };

  return {
    assistantTexts,
    completeRuns,
    get durableProviderResponsePreview() {
      return durableProviderResponsePreview;
    },
    failedRuns,
    groundedMarks,
    get chatUpdateLoads() {
      return chatUpdateLoads;
    },
    persistedEvents,
    providerRequestPreviews,
    providerResponseIds,
    recordedRunUsageEvents,
    repository,
    searchRuns
  };
}

function executionInput(input: Readonly<{
  adapter: ProviderAdapter;
  mcpRuntime?: RunExecutionInput["mcpRuntime"];
  prepared?: MaterializedPreparedRunData;
  repository: RunExecutionRepository;
  runId?: string;
  searchAdapter?: ProviderSearchAdapter;
}>): RunExecutionInput {
  return {
    adapter: input.adapter,
    created: {
      assistantMessageId: "assistant-1",
      runId: input.runId ?? "run-1",
      userMessageId: "user-message-1"
    },
    prepared: input.prepared ?? preparedData(),
    repository: input.repository,
    ...(input.mcpRuntime ? { mcpRuntime: input.mcpRuntime } : {}),
    ...(input.searchAdapter ? { searchAdapter: input.searchAdapter } : {}),
    userId: "user-1"
  };
}

function parseSse(text: string): ModelRunSseEvent[] {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const type = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);
      if (!type || !data) {
        throw new Error(`Invalid SSE chunk: ${chunk}`);
      }

      return {
        data: JSON.parse(data) as unknown,
        type
      } as ModelRunSseEvent;
    });
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

describe("run execution", () => {
  beforeEach(() => {
    activeRunControllersForTest().clear();
  });

  afterEach(() => {
    activeRunControllersForTest().clear();
  });

  it("rechecks search enablement immediately before dispatch and fails without calling the provider", async () => {
    const repository = createRepository({ searchStrategyEnabled: false });
    let providerCalls = 0;
    const adapter = createAdapter(async function* () {
      providerCalls += 1;
      return providerResult();
    });
    const response = createRunExecutionResponse(
      executionInput({
        adapter,
        prepared: preparedData({
          provider: "openai",
          searchStrategy: "openai-native-web-search"
        }),
        repository: repository.repository
      })
    );

    const events = parseSse(await response.text());

    expect(providerCalls).toBe(0);
    expect(repository.completeRuns).toHaveLength(0);
    expect(repository.failedRuns).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "search_strategy_not_available",
          message: "The selected search strategy is no longer available"
        },
        runId: "run-1"
      }
    ]);
    expect(events.at(-1)).toEqual({
      data: {
        code: "search_strategy_not_available",
        message: "The selected search strategy is no longer available"
      },
      type: "error"
    });
  });

  it.each([
    {
      expectedCode: "model_not_available",
      expectedMessage: "The selected model is no longer available",
      options: {
        entitlements: {
          modelKeys: new Set<string>(),
          providerKeys: new Set<string>(),
          searchStrategies: new Set<string>()
        }
      },
      prepared: preparedData()
    },
    {
      expectedCode: "model_not_available",
      expectedMessage: "The selected model is no longer available",
      options: { modelAvailable: false },
      prepared: preparedData()
    },
    {
      expectedCode: "search_strategy_not_available",
      expectedMessage: "The selected search strategy is no longer available",
      options: {
        entitlements: {
          modelKeys: new Set<string>(),
          providerKeys: new Set(["openai"]),
          searchStrategies: new Set<string>()
        }
      },
      prepared: preparedData({
        provider: "openai",
        searchStrategy: "openai-native-web-search"
      })
    }
  ])(
    "fails with $expectedCode when dispatch access changed after preparation",
    async ({ expectedCode, expectedMessage, options, prepared }) => {
      const repository = createRepository(options);
      let providerCalls = 0;
      const adapter = createAdapter(async function* () {
        providerCalls += 1;
        return providerResult();
      });
      const response = createRunExecutionResponse(
        executionInput({
          adapter,
          prepared,
          repository: repository.repository
        })
      );

      const events = parseSse(await response.text());

      expect(providerCalls).toBe(0);
      expect(repository.completeRuns).toHaveLength(0);
      expect(repository.failedRuns).toEqual([
        {
          assistantMessageId: "assistant-1",
          error: {
            code: expectedCode,
            message: expectedMessage
          },
          runId: "run-1"
        }
      ]);
      expect(events.at(-1)).toEqual({
        data: {
          code: expectedCode,
          message: expectedMessage
        },
        type: "error"
      });
    }
  );

  it("dispatches entitled runs in different chats without a user-wide execution gate", async () => {
    const repository = createRepository();
    const bothStarted = deferred<void>();
    let providerStarts = 0;
    const adapter = createAdapter(async function* () {
      providerStarts += 1;
      if (providerStarts === 2) {
        bothStarted.resolve();
      }
      await bothStarted.promise;
      return providerResult();
    });
    const responses = [
      createRunExecutionResponse(
        executionInput({
          adapter,
          prepared: preparedData({ chatId: "chat-a" }),
          repository: repository.repository,
          runId: "run-a"
        })
      ),
      createRunExecutionResponse(
        executionInput({
          adapter,
          prepared: preparedData({ chatId: "chat-b" }),
          repository: repository.repository,
          runId: "run-b"
        })
      )
    ];

    await Promise.all(responses.map((response) => response.text()));

    expect(providerStarts).toBe(2);
    expect(repository.completeRuns.map((run) => run.runId).sort()).toEqual(["run-a", "run-b"]);
  });

  it("preserves SSE order, batches durable tokens, updates response ids, and keeps chat_update transient", async () => {
    const truncation: ContextTruncationSummary = {
      approxDroppedTokens: 10,
      approxFinalTokens: 20,
      approxOriginalTokens: 30,
      budgetTokens: 100,
      contextWindow: 200,
      droppedMessages: 2,
      keptMessages: 1,
      maxOutputTokens: 80,
      safetyMarginTokens: 20
    };
    const repository = createRepository({ chatUpdate: chatUpdate() });
    const adapter = createAdapter(async function* () {
      for (let index = 0; index < 33; index += 1) {
        yield { data: { delta: "x" }, type: "token" };
      }
      yield {
        data: { artifactType: "summary", payload: { responseId: "response-1" } },
        type: "artifact"
      };
      yield {
        data: { artifactType: "reasoning", payload: { text: "brief" } },
        type: "artifact"
      };
      return providerResult({ providerResponseId: "response-1" });
    });

    const response = createRunExecutionResponse(
      executionInput({
        adapter,
        prepared: preparedData({ contextTruncation: truncation }),
        repository: repository.repository
      })
    );
    const events = parseSse(await response.text());
    const eventTypes = events.map((event) => event.type);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(eventTypes).toEqual([
      "run_start",
      "message_start",
      "artifact",
      ...Array.from({ length: 33 }, () => "token"),
      "artifact",
      "artifact",
      "usage",
      "chat_update",
      "done"
    ]);
    expect(events[2]).toEqual({
      data: { artifactType: "context_truncated", payload: truncation },
      type: "artifact"
    });
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "artifact",
      "token",
      "token",
      "artifact",
      "artifact",
      "usage",
      "done"
    ]);
    expect(
      repository.persistedEvents
        .filter(({ event }) => event.type === "token")
        .map(({ event }) => (event.type === "token" ? event.data.delta : ""))
    ).toEqual(["x".repeat(32), "x"]);
    expect(repository.assistantTexts).toEqual(["x".repeat(32), "x".repeat(33)]);
    expect(repository.providerResponseIds).toEqual(["response-1"]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.chatUpdateLoads).toBe(1);
    expect(events.find((event) => event.type === "chat_update")).toMatchObject({
      data: {
        messages: expect.arrayContaining([
          expect.objectContaining({ id: "assistant-1", runUsage: { totalTokens: 5 } })
        ])
      }
    });
    expect(repository.persistedEvents.some(({ event }) => event.type === "chat_update")).toBe(false);
    expect(eventTypes.slice(-3)).toEqual(["usage", "chat_update", "done"]);
    expect(activeRunControllerRegistry.has("run-1")).toBe(false);
  });

  it("keeps grounded output live while persisting only provenance, usage, and a neutral placeholder", async () => {
    const persistedChatUpdate = chatUpdate();
    persistedChatUpdate.messages[1]!.content = textMessageContent(GROUNDED_LIVE_ONLY_PLACEHOLDER);
    const repository = createRepository({
      chatUpdate: persistedChatUpdate,
      entitlements: {
        modelKeys: new Set<string>(),
        providerKeys: new Set(["gemini"]),
        searchStrategies: new Set(["gemini-google-search"])
      }
    });
    const adapter = createAdapter(async function* () {
      for (let index = 0; index < 33; index += 1) {
        yield { data: { delta: "pre-marker-secret" }, type: "token" };
      }
      yield {
        data: {
          citations: [],
          provider: "gemini",
          runSearch: { callCount: 1, queryCount: 1 },
          suggestionsHtml: "<div>suggestion-secret</div>"
        },
        type: "grounding_display"
      };
      yield {
        data: {
          artifactType: "citation",
          payload: { title: "citation-secret", url: "https://source.example/secret" }
        },
        type: "artifact"
      };
      yield { data: { delta: "Live grounded answer" }, type: "token" };
      return providerResult({
        finalProviderResponsePreview: {
          citation: "https://source.example/secret",
          searchSuggestionsHtml: "<div>suggestion-secret</div>"
        },
        finalText: "Live grounded answer"
      });
    });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      prepared: preparedData({
        modelId: "gemini-3.6-flash",
        provider: "gemini",
        searchStrategy: "gemini-google-search"
      }),
      repository: repository.repository
    })).text());

    expect(repository.groundedMarks).toHaveLength(1);
    expect(repository.groundedMarks[0]).toMatchObject({
      assistantMessageId: "assistant-1",
      provider: "gemini",
      runId: "run-1",
      strategy: "gemini-google-search"
    });
    expect(repository.assistantTexts).toEqual([]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.completeRuns[0]?.finalText).toBe(GROUNDED_LIVE_ONLY_PLACEHOLDER);
    expect(repository.completeRuns[0]?.finalProviderResponsePreview).toEqual(
      groundedLiveOnlyProviderPreview()
    );
    expect(repository.durableProviderResponsePreview).toEqual(groundedLiveOnlyProviderPreview());
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "usage",
      "done"
    ]);
    const persisted = JSON.stringify({
      assistantTexts: repository.assistantTexts,
      completeRuns: repository.completeRuns,
      events: repository.persistedEvents,
      providerRequestPreviews: repository.providerRequestPreviews,
      providerResponsePreview: repository.durableProviderResponsePreview
    });
    expect(persisted).not.toContain("suggestion-secret");
    expect(persisted).not.toContain("citation-secret");
    expect(persisted).not.toContain("source.example");
    expect(persisted).not.toContain("Live grounded answer");
    expect(persisted).not.toContain("pre-marker-secret");

    const liveChatUpdate = events.find((event) => event.type === "chat_update");
    expect(JSON.stringify(liveChatUpdate)).toContain("Live grounded answer");
    expect(JSON.stringify(liveChatUpdate)).not.toContain(GROUNDED_LIVE_ONLY_PLACEHOLDER);
    const groundingIndex = events.findIndex((event) => event.type === "grounding_display");
    const liveAnswerIndex = events.findIndex(
      (event) => event.type === "token" && event.data.delta === "Live grounded answer"
    );
    expect(groundingIndex).toBeGreaterThan(-1);
    expect(liveAnswerIndex).toBeGreaterThan(groundingIndex);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("keeps failed grounded partial output transient and leaves no durable provider content", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield {
        data: {
          citations: [{
            endIndex: 8,
            startIndex: 0,
            title: "failed-citation-secret",
            url: "https://failed-source.example/secret"
          }],
          provider: "gemini",
          runSearch: { callCount: 1, queryCount: 1 },
          suggestionsHtml: "<div>failed-suggestion-secret</div>"
        },
        type: "grounding_display"
      };
      yield { data: { delta: "failed grounded partial" }, type: "token" };
      throw new Error("grounded_stream_failed");
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(repository.groundedMarks).toHaveLength(1);
    expect(repository.assistantTexts).toEqual([]);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toHaveLength(1);
    expect(repository.durableProviderResponsePreview).toEqual(groundedLiveOnlyProviderPreview());
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "error"
    ]);
    const persisted = JSON.stringify({
      assistantTexts: repository.assistantTexts,
      events: repository.persistedEvents,
      providerRequestPreviews: repository.providerRequestPreviews,
      providerResponsePreview: repository.durableProviderResponsePreview
    });
    expect(persisted).not.toContain("failed grounded partial");
    expect(persisted).not.toContain("failed-suggestion-secret");
    expect(persisted).not.toContain("failed-citation-secret");
    expect(persisted).not.toContain("failed-source.example");
    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "grounding_display",
      "token",
      "error"
    ]);
  });

  it("cannot append a contradictory error after durable completion because terminal evidence is repository-owned", async () => {
    const repository = createRepository();
    const appendRunEvent = repository.repository.appendRunEvent;
    repository.repository.appendRunEvent = async (runId, sequence, event) => {
      if (event.type === "usage" || event.type === "done") {
        throw new Error("legacy_terminal_append_failed");
      }
      return appendRunEvent(runId, sequence, event);
    };
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "answer" }, type: "token" };
      return providerResult({ finalText: "answer" });
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, repository: repository.repository })
      ).text()
    );

    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.failedRuns).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "usage",
      "done"
    ]);
    expect(repository.persistedEvents.map(({ event }) => event.type).slice(-2)).toEqual([
      "usage",
      "done"
    ]);
  });

  it("flushes partial text and persists error without terminal success for a truncated provider stream", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "partial" }, type: "token" };
      yield { data: usage(7, 2, 0), type: "usage" };
      throw new Error("openrouter_stream_truncated");
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token", "error"]);
    expect(repository.assistantTexts).toEqual(["partial"]);
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "error"
    ]);
    expect(repository.failedRuns).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: { code: "provider_stream_failed", message: "openrouter_stream_truncated" },
        runId: "run-1"
      }
    ]);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.recordedRunUsageEvents[0]?.usageAttributions).toMatchObject([
      {
        modelId: "fake-qsa",
        provider: "fake",
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          totalTokens: 9
        }
      }
    ]);
    expect(repository.persistedEvents.some(({ event }) => event.type === "usage" || event.type === "done")).toBe(false);
  });

  it("does not append an error when durable cancellation wins before failure settlement", async () => {
    const repository = createRepository({ failureWins: false });
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "accepted before cancellation" }, type: "token" };
      throw new Error("provider_failed_after_cancel");
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(repository.failedRuns).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token"]);
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token"
    ]);
  });

  it("suppresses usage, chat_update, and done when status-guarded completion loses", async () => {
    const repository = createRepository({ chatUpdate: chatUpdate(), completionWins: false });
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "answer" }, type: "token" };
      return providerResult();
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token"]);
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token"
    ]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.recordedRunUsageEvents).toHaveLength(1);
    expect(repository.recordedRunUsageEvents[0]?.usageAttributions).toMatchObject([
      {
        modelId: "fake-qsa",
        provider: "fake",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5
        }
      }
    ]);
    expect(repository.chatUpdateLoads).toBe(0);
    expect(repository.failedRuns).toEqual([]);
  });

  it("aborts the active provider, flushes accepted tokens, and leaves cancellation persistence external", async () => {
    const waitingForAbort = deferred<AbortSignal>();
    const repository = createRepository();
    const adapter = createAdapter(async function* (_request, options) {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("missing_abort_signal");
      }

      yield { data: { delta: "before-abort" }, type: "token" };
      waitingForAbort.resolve(signal);
      await new Promise<void>((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error("provider_run_aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
      throw new Error("unreachable");
    });
    const response = createRunExecutionResponse(executionInput({ adapter, repository: repository.repository }));

    const signal = await waitingForAbort.promise;
    expect(signal.aborted).toBe(false);
    expect(activeRunControllerRegistry.ids()).toEqual(["run-1"]);
    expect(activeRunControllerRegistry.abort("run-1")).toBe(true);
    expect(activeRunControllerRegistry.has("run-1")).toBe(false);
    expect(activeRunControllerRegistry.abort("run-1")).toBe(false);

    const events = parseSse(await response.text());
    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token"]);
    expect(repository.assistantTexts).toEqual(["before-abort"]);
    expect(repository.failedRuns).toEqual([]);
    expect(repository.completeRuns).toEqual([]);
  });

  it("cancels a provider response discovered after durable cancellation without publishing it to the terminal run", async () => {
    const repository = createRepository({ responseIdPublication: "cancelled" });
    const providerCancels: string[] = [];
    const adapter = createAdapter(async function* () {
      yield {
        data: {
          artifactType: "summary",
          payload: {
            responseId: "response-late",
            status: "in_progress"
          }
        },
        type: "artifact"
      };
      return providerResult();
    });
    adapter.cancel = async (providerResponseId) => {
      providerCancels.push(providerResponseId);
      return { status: "cancelled" };
    };

    const response = createRunExecutionResponse(
      executionInput({ adapter, repository: repository.repository })
    );
    await response.text();

    expect(repository.providerResponseIds).toEqual(["response-late"]);
    expect(providerCancels).toEqual(["response-late"]);
    expect(repository.completeRuns).toHaveLength(0);
    expect(repository.failedRuns).toHaveLength(0);
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start"
    ]);
  });

  it("keeps execution and durable finalization alive after the SSE consumer disconnects", async () => {
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      providerStarted.resolve();
      await releaseProvider.promise;
      yield { data: { delta: "finished without consumer" }, type: "token" };
      return providerResult({ finalText: "finished without consumer" });
    });
    const response = createRunExecutionResponse(executionInput({ adapter, repository: repository.repository }));
    await providerStarted.promise;

    const cancellation = response.body?.cancel();
    releaseProvider.resolve();
    await cancellation;
    await expect.poll(() => repository.completeRuns.length).toBe(1);

    expect(repository.assistantTexts).toEqual(["finished without consumer"]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "usage",
      "done"
    ]);
    expect(repository.failedRuns).toEqual([]);
    await expect.poll(() => activeRunControllerRegistry.has("run-1")).toBe(false);
  });

  it("keeps a replacement controller when an older execution with the same run id exits", async () => {
    const release = deferred<void>();
    const waiting = deferred<void>();
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "answer" }, type: "token" };
      waiting.resolve();
      await release.promise;
      return providerResult();
    });
    const response = createRunExecutionResponse(executionInput({ adapter, repository: repository.repository }));
    await waiting.promise;
    const original = activeRunControllersForTest().get("run-1");
    const replacement = new AbortController();
    activeRunControllersForTest().set("run-1", replacement);
    release.resolve();

    await response.text();
    expect(original).toBeDefined();
    expect(activeRunControllersForTest().get("run-1")).toBe(replacement);
  });

  it("runs a no-tool Perplexity strategy round without creating a SearchRun", async () => {
    const requests: ProviderRunRequest[] = [];
    const previewRequests: ProviderRunRequest[] = [];
    let searches = 0;
    const repository = createRepository();
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      yield { data: { delta: "Direct answer" }, type: "token" };
      return providerResult({ finalText: "Direct answer" });
    }, previewRequests);
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        searches += 1;
        throw new Error("unexpected_search");
      }
    };
    const prepared = preparedData({
      modelId: "openai-answer-model",
      provider: "openai",
      searchStrategy: "perplexity-tool-search"
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, prepared, repository: repository.repository, searchAdapter })
      ).text()
    );

    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "usage",
      "done"
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      toolChoice: "auto"
    });
    expect(requests[0]?.forceNonStreaming).toBeUndefined();
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["search_via_perplexity"]);
    expect(previewRequests).toHaveLength(1);
    expect(repository.providerRequestPreviews).toHaveLength(1);
    expect(repository.searchRuns).toEqual([]);
    expect(searches).toBe(0);
  });

  it("executes a Perplexity tool call, persists search evidence, and synthesizes with aggregate usage", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const previewRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const repository = createRepository();
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        yield { data: { artifactType: "reasoning", payload: { text: "Need current data" } }, type: "artifact" };
        yield { data: { delta: "discarded draft" }, type: "token" };
        yield { data: usage(1, 2, 0), type: "usage" };
        return providerResult({
          finalText: "",
          toolCalls: [
            {
              arguments: { query: "latest AIQSA news" },
              id: "tool-call-1",
              name: "search_via_perplexity"
            }
          ],
          usage: usage(1, 2, 0)
        });
      }

      yield { data: { delta: "Sourced answer" }, type: "token" };
      return providerResult({ finalText: "Sourced answer", usage: usage(5, 6, 1) });
    }, previewRequests);
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [
            {
              data: { artifactType: "search", payload: { query: "latest AIQSA news" } },
              type: "artifact"
            }
          ],
          finalProviderResponsePreview: { search: "safe" },
          finalText: "Search findings",
          providerResponseId: "search-response-1",
          requestPreview: { query: "latest AIQSA news" },
          usage: usage(3, 4, 0)
        };
      }
    };
    const prepared = preparedData({
      modelId: "openai-answer-model",
      provider: "openai",
      searchStrategy: "perplexity-tool-search"
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, prepared, repository: repository.repository, searchAdapter })
      ).text()
    );

    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "artifact",
      "token",
      "artifact",
      "message_reset",
      "artifact",
      "artifact",
      "token",
      "usage",
      "done"
    ]);
    expect(
      events
        .filter((event) => event.type === "artifact")
        .map((event) => (event.type === "artifact" ? event.data.artifactType : ""))
    ).toEqual(["reasoning", "tool_call", "search", "tool_result"]);
    expect(events.some((event) => event.type === "token" && event.data.delta === "discarded draft")).toBe(true);
    expect(events.some((event) => event.type === "message_reset")).toBe(true);
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]?.providerToolMessages).toHaveLength(2);
    expect(previewRequests).toHaveLength(2);
    expect(repository.providerRequestPreviews).toHaveLength(2);
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.query).toBe("latest AIQSA news");
    expect(searchRequests[0]?.searchPolicy).toEqual(
      prepared.normalizedRequest.searchPolicy
    );
    expect(repository.searchRuns).toHaveLength(1);
    expect(repository.searchRuns[0]).toMatchObject({
      modelId: "perplexity/sonar-pro-search",
      modelRunId: "run-1",
      provider: "openrouter",
      status: "complete",
      strategyId: "perplexity-tool-search"
    });
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.completeRuns[0]?.usage).toMatchObject({
      inputTokens: 9,
      outputTokens: 12,
      reasoningTokens: 1,
      totalTokens: 21
    });
    expect(repository.completeRuns[0]?.usageAttributions).toEqual([
      {
        estimatedCostMicros: null,
        modelId: "openai-answer-model",
        provider: "openai",
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 6,
          outputTokens: 8,
          reasoningTokens: 1,
          totalTokens: 14
        }
      },
      {
        estimatedCostMicros: null,
        modelId: "perplexity/sonar-pro-search",
        provider: "openrouter",
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 3,
          outputTokens: 4,
          reasoningTokens: 0,
          totalTokens: 7
        }
      }
    ]);
  });

  it("routes tools from several MCP servers and executes one provider batch in parallel", async () => {
    const firstTool = "mcp_memory_lookup_a";
    const secondTool = "mcp_tasks_list_b";
    const mcp: McpRunPlanSnapshot = {
      servers: [
        {
          fingerprint: "fingerprint-memory",
          revisionId: "revision-memory",
          serverId: "server-memory",
          serverName: "Memory"
        },
        {
          fingerprint: "fingerprint-tasks",
          revisionId: "revision-tasks",
          serverId: "server-tasks",
          serverName: "Tasks"
        }
      ],
      tools: [
        {
          definitionHash: "a".repeat(64),
          description: "Look up memory",
          inputSchema: { type: "object" },
          name: "lookup",
          namespacedName: firstTool,
          originalName: "lookup",
          serverId: "server-memory",
          serverName: "Memory"
        },
        {
          definitionHash: "b".repeat(64),
          description: "List tasks",
          inputSchema: { type: "object" },
          name: "list",
          namespacedName: secondTool,
          originalName: "list",
          serverId: "server-tasks",
          serverName: "Tasks"
        }
      ],
      version: 1
    };
    const repository = createRepository();
    const providerRequests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        yield { data: { delta: "Checking both systems" }, type: "token" };
        return providerResult({
          finalText: "",
          toolCalls: [
            {
              arguments: { apiKey: "sk-private-runtime-key", query: "AIQSA" },
              id: "memory-call",
              name: firstTool
            },
            { arguments: { project: "AIQSA" }, id: "tasks-call", name: secondTool }
          ],
          usage: usage(1, 1, 0)
        });
      }
      yield { data: { delta: "Combined answer" }, type: "token" };
      return providerResult({ finalText: "Combined answer", usage: usage(2, 2, 0) });
    });
    const release = deferred<void>();
    const bothStarted = deferred<void>();
    const calls: Array<{
      generationId: string;
      inputSchema: Record<string, unknown>;
      name: string;
    }> = [];
    let active = 0;
    let maxActive = 0;
    const mcpRuntime: NonNullable<RunExecutionInput["mcpRuntime"]> = {
      async callTool({ generationId, inputSchema, name }) {
        calls.push({ generationId, inputSchema, name });
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls.length === 2) bothStarted.resolve();
        await release.promise;
        active -= 1;
        return {
          isError: false,
          structuredContent: { generationId, name },
          text: [`${name} result`],
          unsupportedContentTypes: []
        };
      },
      async ensureAcceptedGeneration(generationId) {
        return generationId === "generation-fingerprint-memory" ||
          generationId === "generation-fingerprint-tasks";
      }
    };
    const responseBody = createRunExecutionResponse(executionInput({
      adapter,
      mcpRuntime,
      prepared: preparedData({ mcp, modelId: "gpt-tool-model", provider: "openai" }),
      repository: repository.repository
    })).text();

    await bothStarted.promise;
    release.resolve();
    const events = parseSse(await responseBody);

    expect(maxActive).toBe(2);
    expect(calls).toEqual([
      {
        generationId: "generation-fingerprint-memory",
        inputSchema: mcp.tools[0]?.inputSchema,
        name: "lookup"
      },
      {
        generationId: "generation-fingerprint-tasks",
        inputSchema: mcp.tools[1]?.inputSchema,
        name: "list"
      }
    ]);
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[0]?.tools?.map((tool) => tool.name)).toEqual([firstTool, secondTool]);
    expect(providerRequests[0]?.parallelToolCalls).toBe(true);
    expect(providerRequests[1]?.providerToolMessages).toHaveLength(4);
    expect(events.filter((event) => event.type === "message_reset")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "summary",
          payload: expect.objectContaining({ message: "Waiting for model" })
        }),
        type: "artifact"
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "summary",
          payload: expect.objectContaining({ count: 2, message: "Running 2 tools" })
        }),
        type: "artifact"
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "tool_result",
          payload: expect.objectContaining({ durationMs: expect.any(Number) })
        }),
        type: "artifact"
      })
    ]));
    const toolCallEvent = events.find((event) =>
      event.type === "artifact" && event.data.artifactType === "tool_call"
    );
    expect(JSON.stringify(toolCallEvent)).not.toContain("sk-private-runtime-key");
    expect(toolCallEvent).toMatchObject({
      data: {
        payload: {
          argumentsPreview: { apiKey: "[redacted]", query: "AIQSA" },
          snapshot: { capability: "mcp", serverName: "Memory", toolName: "lookup" }
        }
      }
    });
    expect(repository.completeRuns[0]?.finalText).toBe("Combined answer");
  });

  it("fails a legacy attachment-bearing Perplexity tool call closed without a SearchRun", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [
            {
              arguments: { query: "current sources" },
              id: "tool-call-1",
              name: "search_via_perplexity"
            }
          ],
          usage: usage(2, 1, 0)
        });
      }

      yield { data: { delta: "Final" }, type: "token" };
      return providerResult({ finalText: "Final", usage: usage(4, 2, 0) });
    });
    const search = vi.fn<ProviderSearchAdapter["search"]>();
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      search
    };
    const initialTruncation: ContextTruncationSummary = {
      approxDroppedTokens: 100,
      approxFinalTokens: 920,
      approxOriginalTokens: 1_020,
      budgetTokens: 1_160,
      contextWindow: 1_400,
      droppedMessages: 2,
      keptMessages: 3,
      maxOutputTokens: 100,
      safetyMarginTokens: 140
    };
    const base = preparedData({
      contextTruncation: initialTruncation,
      modelId: "openai-answer-model",
      provider: "openai",
      searchStrategy: "perplexity-tool-search"
    });
    const context = {
      messages: [
        {
          content: textMessageContent("u".repeat(800)),
          id: "kept-prior-user",
          role: "user" as const
        },
        {
          content: textMessageContent("a".repeat(800)),
          id: "kept-prior-assistant",
          role: "assistant" as const
        },
        {
          content: textMessageContent("Current question"),
          id: "current-user-message",
          role: "user" as const
        }
      ],
      mode: "branch_path" as const,
      summary: {
        truncation: initialTruncation
      }
    };
    const modelCapabilities = {
      ...base.normalizedRequest.modelCapabilities,
      contextWindow: 1_400,
      defaultMaxOutputTokens: 100
    };
    const normalizedRequest = {
      ...base.normalizedRequest,
      context,
      modelCapabilities
    };
    const prepared: MaterializedPreparedRunData = {
      ...base,
      normalizedRequest,
      providerRequest: {
        ...normalizedRequest,
        attachments: [
          {
            byteSize: 50_000,
            extractedText: null,
            fileName: "ATTACHMENT_FILENAME_CANARY.png",
            id: "attachment-1",
            kind: "image",
            metadata: {},
            mimeType: "image/png",
            status: "ready"
          }
        ]
      }
    };

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, prepared, repository: repository.repository, searchAdapter })
      ).text()
    );
    const truncations = events.flatMap((event) =>
      event.type === "artifact" && event.data.artifactType === "context_truncated"
        ? [event.data.payload as ContextTruncationSummary]
        : []
    );

    expect(providerRequests).toHaveLength(2);
    expect(search).not.toHaveBeenCalled();
    expect(repository.searchRuns).toEqual([]);
    expect(truncations).toHaveLength(1);
    const toolResult = events.find((event) =>
      event.type === "artifact" && event.data.artifactType === "tool_result"
    );
    expect(toolResult).toMatchObject({
      data: {
        payload: {
          resultPreview: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                text: "Search failed: client_search_with_attachments_not_supported"
              })
            ])
          })
        }
      }
    });
  });

  it("retains completed answer and Perplexity usage when a later tool round fails", async () => {
    let answerRounds = 0;
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      answerRounds += 1;
      if (answerRounds === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [
            {
              arguments: { query: "current sources" },
              id: "tool-call-1",
              name: "search_via_perplexity"
            }
          ],
          usage: usage(2, 1, 0)
        });
      }

      throw new Error("later_answer_round_failed");
    });
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          finalText: "Search findings",
          requestPreview: {},
          usage: usage(3, 2, 0)
        };
      }
    };
    const prepared = preparedData({
      modelId: "openai-answer-model",
      provider: "openai",
      searchStrategy: "perplexity-tool-search"
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, prepared, repository: repository.repository, searchAdapter })
      ).text()
    );

    expect(events.at(-1)).toMatchObject({
      data: {
        code: "provider_stream_failed",
        message: "later_answer_round_failed"
      },
      type: "error"
    });
    expect(repository.completeRuns).toEqual([]);
    expect(repository.recordedRunUsageEvents).toHaveLength(3);
    expect(repository.recordedRunUsageEvents[0]?.usageAttributions).toHaveLength(1);
    expect(repository.recordedRunUsageEvents.at(-1)?.usageAttributions).toEqual([
      {
        estimatedCostMicros: null,
        modelId: "openai-answer-model",
        provider: "openai",
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 2,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 3
        }
      },
      {
        estimatedCostMicros: null,
        modelId: "perplexity/sonar-pro-search",
        provider: "openrouter",
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 3,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 5
        }
      }
    ]);
  });
});
