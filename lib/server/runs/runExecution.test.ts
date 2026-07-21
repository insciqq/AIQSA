import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import type { ResolvedEntitlements } from "../auth/entitlements";
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

type CompleteRunInput = Parameters<RunRepository["completeRun"]>[0];
type CreateSearchRunInput = Parameters<RunRepository["createSearchRun"]>[0];
type RecordRunUsageEventsInput = Parameters<RunRepository["recordRunUsageEvents"]>[0];
type FailedRun = {
  assistantMessageId: string;
  error: { code: string; message: string };
  runId: string;
};

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
      contextWindow: 32_768,
      defaultMaxOutputTokens: 512,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: true,
      reasoning: true,
      streaming: true,
      vision: true
    },
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
        status: "complete"
      }
    ]
  };
}

function createRepository(options: RepositoryOptions = {}) {
  const assistantTexts: string[] = [];
  const completeRuns: CompleteRunInput[] = [];
  const failedRuns: FailedRun[] = [];
  const persistedEvents: { event: ModelRunSseEvent; runId: string; sequence: number }[] = [];
  const providerResponseIds: string[] = [];
  const providerRequestPreviews: Record<string, unknown>[] = [];
  const recordedRunUsageEvents: RecordRunUsageEventsInput[] = [];
  const searchRuns: CreateSearchRunInput[] = [];
  let chatUpdateLoads = 0;
  const repository: RunExecutionRepository = {
    async appendAssistantText(_assistantMessageId, text) {
      assistantTexts.push(text);
    },
    async appendRunEvent(runId, sequence, event) {
      persistedEvents.push({ event, runId, sequence });
    },
    async completeRun(input) {
      completeRuns.push(input);
      if (options.completionWins === false) {
        return false;
      }

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
    async nextRunEventSequence() {
      return persistedEvents.length;
    },
    async recordRunUsageEvents(input) {
      recordedRunUsageEvents.push(input);
      return true;
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
    failedRuns,
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
    expect(repository.persistedEvents.some(({ event }) => event.type === "chat_update")).toBe(false);
    expect(eventTypes.slice(-3)).toEqual(["usage", "chat_update", "done"]);
    expect(activeRunControllerRegistry.has("run-1")).toBe(false);
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
      forceNonStreaming: true,
      toolChoice: "auto"
    });
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
              arguments: { keyword: "latest AIQSA news" },
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
      "artifact",
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
    expect(events.some((event) => event.type === "token" && event.data.delta === "discarded draft")).toBe(false);
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]?.providerToolMessages).toHaveLength(2);
    expect(previewRequests).toHaveLength(2);
    expect(repository.providerRequestPreviews).toHaveLength(2);
    expect(searchRequests).toHaveLength(1);
    expect(textFromContentBlocks(searchRequests[0]?.content ?? {})).toBe("latest AIQSA news");
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

  it("re-budgets attachments with tool transcripts and emits cumulative late truncation evidence", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [
            {
              arguments: { keyword: "current sources" },
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
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          finalText: "s".repeat(1_200),
          requestPreview: {},
          usage: usage(3, 2, 0)
        };
      }
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
            fileName: "reference.png",
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
    expect(providerRequests[1]?.context?.messages.map((message) => message.id)).toEqual([
      "current-user-message"
    ]);
    expect(truncations).toHaveLength(2);
    expect(truncations[1]).toMatchObject({
      droppedMessages: 4,
      keptMessages: 1
    });
    expect(providerRequests[1]?.context?.summary?.truncation).toEqual(truncations[1]);
    expect(repository.providerRequestPreviews.at(-1)).toMatchObject({
      contextTruncation: truncations[1]
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
              arguments: { keyword: "current sources" },
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
    expect(repository.recordedRunUsageEvents).toHaveLength(1);
    expect(repository.recordedRunUsageEvents[0]?.usageAttributions).toEqual([
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
