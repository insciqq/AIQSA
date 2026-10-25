import type { CatalogWireSearchStrategy } from "@/lib/contracts/catalog";
import type { ThreadArtifactSummary } from "@/lib/contracts/chats";
import { encodeSseEvent, type ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import { createFakeTelegramBotApi, type FakeTelegramBotApi, type FakeTelegramUser } from "./fakeTelegramBotApi";
import { createTelegramBotApi, createTelegramPacer, decodeTelegramUpdate, type TelegramUpdate } from "@/lib/server/telegram/botApi";
import { createTelegramAccessResolver, type TelegramAccessUser } from "@/lib/server/telegram/control/access";
import type { TelegramEffectiveControl } from "@/lib/server/telegram/control/state";
import {
  createTelegramDispatcher, createTelegramHandlerRegistry, type TelegramBotSession, type TelegramDispatcher
} from "@/lib/server/telegram/dispatcher";
import { createTelegramLinkCommands } from "@/lib/server/telegram/linking/commands";
import type { TelegramLinkingService } from "@/lib/server/telegram/linking/service";
import { createTelegramOutbound } from "@/lib/server/telegram/outbound";
import { createPrismaTelegramCallbackStore } from "@/lib/server/telegram/store/callbacks";
import type { TelegramLinkRecord, TelegramLinkStore } from "@/lib/server/telegram/store/links";
import type { TelegramMessageRef, TelegramMessageRefStore } from "@/lib/server/telegram/store/messageRefs";
import type { TelegramReceiptStore } from "@/lib/server/telegram/store/receipts";
import type { TelegramRunLinkRecord, TelegramRunLinkStore } from "@/lib/server/telegram/store/runLinks";
import type { TelegramCatalogModel, TelegramRunCatalog } from "@/lib/server/telegram/bridge/body";
import type { TelegramAssistantChoice, TelegramChatRecord, TelegramRunGateway } from "@/lib/server/telegram/bridge/gateway";
import { createTelegramChatBridge, type TelegramChatBridge, type TelegramChatBridgeDeps } from "@/lib/server/telegram/bridge";

/**
 * A synthetic AIQSA for chat bridge tests: a catalog, personal chats and runs
 * whose streams the test drives frame by frame (encoded exactly as the run
 * stream encodes them), in-memory link, run-link and message-reference
 * stores, and the real dispatcher, outbound and Bot API client against the
 * fake Bot API. Content is synthetic.
 */

export const SEARCH_OPTION: CatalogWireSearchStrategy = {
  displayName: "Web", executionModes: ["all_selected", "model_choice"], kind: "web_search", strategyId: "search-web"
};

export function fakeCatalogModel(overrides: Partial<TelegramCatalogModel> = {}): TelegramCatalogModel {
  return {
    capabilities: {
      background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false, openRouterPerplexitySearch: false,
      reasoning: false, streaming: true, text: true, toolCalling: true
    },
    contextWindow: 16_384,
    defaultParams: {},
    displayName: "Fake QSA",
    modelId: "model-fake",
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 1_024, maxValue: 4_096 },
      reasoningEffort: { defaultValue: "none", options: [], supported: false },
      stream: { defaultValue: false, supported: false },
      temperature: { defaultValue: 0.7, maxValue: 2, minValue: 0, supported: true }
    },
    parameterDialect: "fake",
    provider: "connection-fake",
    providerFamily: "fake",
    searchStrategyIds: [SEARCH_OPTION.strategyId],
    upstreamModelId: "fake-qsa",
    ...overrides
  };
}

export function fakeCatalog(overrides: Partial<{
  models: TelegramCatalogModel[]; defaults: Partial<TelegramRunCatalog["defaults"]>; searchStrategies: CatalogWireSearchStrategy[];
}> = {}): TelegramRunCatalog {
  const models = overrides.models ?? [fakeCatalogModel()];
  return {
    defaults: {
      controlValues: {}, mcpMode: "auto", modelId: models[0]?.modelId ?? "", provider: models[0]?.provider ?? "",
      searchPlan: { mode: "all_selected", optionIds: [SEARCH_OPTION.strategyId] }, skillsMode: "auto", ...overrides.defaults
    },
    models,
    searchStrategies: overrides.searchStrategies ?? [SEARCH_OPTION]
  };
}

// ---------------------------------------------------------------------------
// In-memory stores with the Prisma stores' semantics

export function memoryLinkStore() {
  const records = new Map<string, TelegramLinkRecord>();
  const store: TelegramLinkStore = {
    findByChat: async (botId, chatId) => [...records.values()].find((link) => link.botId === botId && link.telegramChatId === chatId) ?? null,
    findByTelegramUser: async (botId, telegramUserId) =>
      [...records.values()].find((link) => link.botId === botId && link.telegramUserId === telegramUserId) ?? null,
    findByUserId: async (userId) => records.get(userId) ?? null,
    touch: async () => undefined,
    updatePreferences: async (linkId, preferences) => {
      const link = [...records.values()].find((candidate) => candidate.id === linkId);
      if (!link) return false;
      const { selectedModel, ...rest } = preferences;
      records.set(link.userId, {
        ...link, ...rest,
        ...(selectedModel === undefined ? {} : {
          selectedModelId: selectedModel?.modelId ?? null, selectedProvider: selectedModel?.provider ?? null
        })
      });
      return true;
    }
  };
  return { records, store };
}

export function memoryRunLinkStore() {
  const rows = new Map<string, TelegramRunLinkRecord>();
  const store: TelegramRunLinkStore = {
    async create(input) {
      if (rows.has(input.runId)) return false;
      rows.set(input.runId, {
        createdAt: input.now, deliveredAt: null, deliveryState: "pending", draftId: input.draftId, linkId: input.linkId, runId: input.runId,
        statusMessageId: null, telegramChatId: input.telegramChatId, userId: input.userId
      });
      return true;
    },
    find: async (runId) => rows.get(runId) ?? null,
    async setStatusMessage({ runId, statusMessageId }) {
      const row = rows.get(runId);
      if (row) rows.set(runId, { ...row, statusMessageId });
    },
    async claimDelivery(runId) {
      const row = rows.get(runId);
      if (row?.deliveryState !== "pending") return false;
      rows.set(runId, { ...row, deliveryState: "claimed" });
      return true;
    },
    async settle({ at, runId, state }) {
      const row = rows.get(runId);
      if (row?.deliveryState === "claimed") rows.set(runId, { ...row, deliveredAt: state === "delivered" ? at : null, deliveryState: state });
    },
    listByState: async ({ limit, state }) => [...rows.values()].filter((row) => row.deliveryState === state)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()).slice(0, limit)
  };
  return { rows, store };
}

export function memoryMessageRefStore() {
  const refs: TelegramMessageRef[] = [];
  const store: TelegramMessageRefStore = {
    async record(entries) {
      for (const entry of entries) {
        if (!refs.some((ref) => ref.botId === entry.botId && ref.telegramChatId === entry.telegramChatId &&
          ref.telegramMessageId === entry.telegramMessageId)) refs.push(entry);
      }
    },
    async find({ botId, telegramChatId, telegramMessageId }) {
      const ref = refs.find((entry) => entry.botId === botId && entry.telegramChatId === telegramChatId &&
        entry.telegramMessageId === telegramMessageId);
      return ref ? { chatId: ref.chatId, linkId: ref.linkId, messageId: ref.messageId ?? null, userId: ref.userId } : null;
    }
  };
  return { refs, store };
}

// ---------------------------------------------------------------------------
// Synthetic AIQSA

export type FakeRunStatus = "streaming" | "complete" | "cancelled" | "error";

export type FakeRun = {
  readonly id: string;
  readonly chatId: string;
  readonly userId: string;
  readonly assistantMessageId: string;
  readonly body: Record<string, unknown>;
  status: FakeRunStatus;
  text: string;
  errorMessage: string | null;
  summary: ThreadArtifactSummary | null;
  followups: string[];
  token(delta: string): void;
  reset(): void;
  emit(event: ModelRunSseEvent): void;
  complete(): void;
  cancel(): void;
  fail(code: string, message: string): void;
  /** Ends the stream without a terminal frame (the run itself goes on). */
  drop(): void;
};

export type FakeChat = { -readonly [Key in keyof TelegramChatRecord]: TelegramChatRecord[Key] } & { userId: string; archived: boolean };

export type FakeSend = Readonly<{ body: Record<string, unknown>; chatId: string; userId: string }>;

export function createFakeGateway(options: Readonly<{
  catalog?: TelegramRunCatalog;
  assistants?: readonly TelegramAssistantChoice[];
  /** The answer a run completes with right away; null leaves every run to the test. */
  autoAnswer?: ((body: Record<string, unknown>) => string | null) | null;
  /** The zone the user's browser last reported; none by default. */
  timeZone?: string | null;
}> = {}) {
  let catalog = options.catalog ?? fakeCatalog();
  let timeZone = options.timeZone ?? null;
  const sent: FakeSend[] = [];
  const runs: FakeRun[] = [];
  const chats = new Map<string, FakeChat>();
  const queued: Array<(input: FakeSend) => Response> = [];
  const followups: Array<Readonly<{ runId: string; nonce: string; text: string }>> = [];
  let followupResponse: ((input: Readonly<{ runId: string; text: string }>) => Response | null) | null = null;
  let autoAnswer = options.autoAnswer === undefined
    ? (body: Record<string, unknown>) => {
      const blocks = (body.content as { blocks?: Array<{ text?: string }> } | undefined)?.blocks ?? [];
      return `Answer: ${blocks.map((block) => block.text ?? "").join(" ")}`;
    }
    : options.autoAnswer;
  let counter = 0;
  const encoder = new TextEncoder();

  function startRun(input: FakeSend, deferred: boolean): Readonly<{ run: FakeRun; response: Response }> {
    counter += 1;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const chat = chats.get(input.chatId)!;
    const emit = (event: ModelRunSseEvent) => {
      try { controller.enqueue(encoder.encode(encodeSseEvent(event))); } catch { /* closed */ }
    };
    const close = () => {
      try { controller.close(); } catch { /* closed */ }
    };
    const run: FakeRun = {
      assistantMessageId: `answer-${counter}`, body: input.body, chatId: input.chatId, errorMessage: null, followups: [], id: `run-${counter}`,
      status: "streaming", summary: null, text: "", userId: input.userId,
      token(delta) {
        run.text += delta;
        emit({ data: { delta }, type: "token" });
      },
      reset() {
        run.text = "";
        emit({ data: { round: 1 }, type: "message_reset" });
      },
      emit,
      complete() {
        run.status = "complete";
        chat.activeLeafMessageId = run.assistantMessageId;
        emit({ data: { runId: run.id, status: "complete" }, type: "done" });
        close();
      },
      cancel() {
        run.status = "cancelled";
        chat.activeLeafMessageId = run.assistantMessageId;
        emit({ data: { runId: run.id, status: "cancelled" }, type: "done" });
        close();
      },
      fail(code, message) {
        run.status = "error";
        run.errorMessage = message;
        chat.activeLeafMessageId = run.assistantMessageId;
        emit({ data: { code, message }, type: "error" });
        close();
      },
      drop: close
    };
    runs.push(run);
    if (deferred) {
      close();
      return {
        response: Response.json({
          assistantMessageId: run.assistantMessageId, run: { id: run.id, status: "queued" }, userMessageId: `question-${counter}`, version: 1
        }, { status: 202 }),
        run
      };
    }
    emit({ data: { modelId: String(input.body.modelId ?? "assistant-model"), provider: "fake", runId: run.id, status: "streaming" }, type: "run_start" });
    emit({ data: { assistantMessageId: run.assistantMessageId, userMessageId: `question-${counter}` }, type: "message_start" });
    const answer = autoAnswer?.(input.body);
    if (answer !== null && answer !== undefined) {
      run.token(answer);
      run.complete();
    }
    return { response: new Response(stream, { headers: { "content-type": "text/event-stream" } }), run };
  }

  const gateway: TelegramRunGateway = {
    loadCatalog: async () => catalog,
    async findChat(userId, chatId) {
      const chat = chats.get(chatId);
      return chat && chat.userId === userId && !chat.archived
        ? { activeLeafMessageId: chat.activeLeafMessageId, assistantId: chat.assistantId, id: chat.id, model: chat.model, title: chat.title }
        : null;
    },
    async send(input) {
      sent.push(input);
      const scripted = queued.shift();
      if (scripted) return scripted(input);
      if (!chats.has(input.chatId)) {
        if (!input.body.personalDraft) return Response.json({ error: "chat_not_found" }, { status: 404 });
        chats.set(input.chatId, {
          activeLeafMessageId: null, archived: false, assistantId: typeof input.body.assistantId === "string" ? input.body.assistantId : null,
          id: input.chatId, model: { modelId: String(input.body.modelId ?? ""), provider: String(input.body.provider ?? "") },
          title: `Chat ${chats.size + 1}`, userId: input.userId
        });
      }
      return startRun(input, false).response;
    },
    async followup(input) {
      const scripted = followupResponse?.(input);
      if (scripted) return scripted;
      const run = runs.find((candidate) => candidate.id === input.runId);
      if (!run || run.status !== "streaming") return Response.json({ error: "followup_closed" }, { status: 409 });
      if (!followups.some((entry) => entry.runId === input.runId && entry.nonce === input.nonce)) {
        followups.push({ nonce: input.nonce, runId: input.runId, text: input.text });
        run.followups.push(input.text);
      }
      return Response.json({ followup: { id: input.nonce, ordinal: run.followups.length, text: input.text } });
    },
    async stop({ runId }) {
      const run = runs.find((candidate) => candidate.id === runId);
      if (!run) return "not_found";
      if (run.status !== "streaming") return "not_cancelable";
      run.cancel();
      return "stopped";
    },
    async runState({ runId }) {
      const run = runs.find((candidate) => candidate.id === runId);
      return run ? { status: run.status } : null;
    },
    async answer({ runId }) {
      const run = runs.find((candidate) => candidate.id === runId);
      return run ? {
        artifactSummary: run.summary, assistantMessageId: run.assistantMessageId, chatId: run.chatId, errorMessage: run.errorMessage,
        status: run.status, text: run.text
      } : null;
    },
    async activeRun({ chatId }) {
      const run = runs.find((candidate) => candidate.chatId === chatId && candidate.status === "streaming");
      return run ? { runId: run.id } : null;
    },
    recentChats: async (userId) => [...chats.values()].filter((chat) => chat.userId === userId && !chat.archived).reverse().slice(0, 10)
      .map((chat) => ({ id: chat.id, title: chat.title })),
    assistants: async () => options.assistants ?? [],
    timeZone: async () => timeZone
  };

  return {
    chats,
    followups,
    gateway,
    runs,
    sent,
    setAutoAnswer(next: ((body: Record<string, unknown>) => string | null) | null) { autoAnswer = next; },
    setCatalog(next: TelegramRunCatalog) { catalog = next; },
    setTimeZone(next: string | null) { timeZone = next; },
    setFollowupResponse(next: typeof followupResponse) { followupResponse = next; },
    /** The next send answers with this response instead of admitting a run. */
    respondNext(response: (input: FakeSend) => Response) { queued.push(response); },
    /** The next send is admitted for later (202), as PDF or Workspace preparation does. */
    deferNext() {
      queued.push((input) => {
        if (!chats.has(input.chatId)) {
          chats.set(input.chatId, {
            activeLeafMessageId: null, archived: false, assistantId: null, id: input.chatId,
            model: { modelId: String(input.body.modelId ?? ""), provider: String(input.body.provider ?? "") }, title: "Deferred chat",
            userId: input.userId
          });
        }
        return startRun(input, true).response;
      });
    },
    addChat(chat: Partial<FakeChat> & Pick<FakeChat, "id" | "userId">) {
      const value: FakeChat = {
        activeLeafMessageId: null, archived: false, assistantId: null, model: { modelId: "", provider: "" }, title: "Web chat", ...chat
      };
      chats.set(value.id, value);
      return value;
    }
  };
}

export type FakeGateway = ReturnType<typeof createFakeGateway>;

// ---------------------------------------------------------------------------
// Bridge behind the real dispatcher and the fake Bot API

const TEST_NOW = Date.parse("2026-10-19T08:00:00.000Z");

export function createBridgeHarness(options: Readonly<{
  gateway?: FakeGateway;
  user?: TelegramAccessUser;
  bridge?: Partial<TelegramChatBridgeDeps>;
}> = {}) {
  const fake: FakeTelegramBotApi = createFakeTelegramBotApi({ now: () => Date.now() });
  const aiqsa = options.gateway ?? createFakeGateway();
  const links = memoryLinkStore();
  const runLinks = memoryRunLinkStore();
  const messageRefs = memoryMessageRefStore();
  let user: TelegramAccessUser = options.user ?? { activeGroupIds: [], scimDeactivatedAt: null, status: "active" };
  const control: TelegramEffectiveControl = {
    bot: { generation: 1, id: fake.bot.id, token: fake.token, username: fake.bot.username },
    enabled: true, groupIds: new Set(), restricted: false, tokenState: "ready", version: 1
  };
  type CallbackRow = { consumedAt: Date | null; expiresAt: Date; id: string; kind: string; linkId: string; payload: unknown };
  const callbackRows = new Map<string, CallbackRow>();
  const callbacks = createPrismaTelegramCallbackStore({
    telegramCallback: {
      createMany: async ({ data }: { data: CallbackRow[] }) => {
        for (const row of data) callbackRows.set(row.id, { ...row, consumedAt: null });
        return { count: data.length };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = callbackRows.get(where.id);
        const link = row ? [...links.records.values()].find((candidate) => candidate.id === row.linkId) : undefined;
        return row && link ? {
          ...row,
          link: { botId: BigInt(link.botId), telegramChatId: BigInt(link.telegramChatId), telegramUserId: BigInt(link.telegramUserId), userId: link.userId }
        } : null;
      },
      updateMany: async ({ data, where }: { data: { consumedAt: Date }; where: { id: string; expiresAt: { gt: Date } } }) => {
        const row = callbackRows.get(where.id);
        if (!row || row.consumedAt || row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      }
    }
  } as never);
  const access = createTelegramAccessResolver({ control: async () => control, links: links.store, users: async () => user });
  const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => undefined, token: fake.token, transport: fake.transport });
  const outbound = createTelegramOutbound({
    api, botId: fake.bot.id, callbacks, messageRefs: messageRefs.store
  });
  const session: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  let sessionOn = true;
  const sessions = { current: async () => sessionOn ? session : null };
  const bridge: TelegramChatBridge = createTelegramChatBridge({
    access, gateway: aiqsa.gateway, links: links.store, messageRefs: messageRefs.store, runLinks: runLinks.store, sessions,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    ...options.bridge
  });
  const registry = createTelegramHandlerRegistry();
  bridge.register(registry);
  const receiptStates = new Map<number, string>();
  const receipts: Pick<TelegramReceiptStore, "claim" | "finish"> = {
    async claim({ update }) {
      if (receiptStates.has(update.updateId)) return false;
      receiptStates.set(update.updateId, "claimed");
      return true;
    },
    async finish({ state, updateId }) { receiptStates.set(updateId, state); }
  };
  const linking = { linkFromStart: async () => ({ code: "telegram_link_code_invalid", kind: "refused" }), unlinkFromBot: async () => false } as
    unknown as TelegramLinkingService;
  const dispatcher: TelegramDispatcher = createTelegramDispatcher({
    access, callbacks, commands: createTelegramLinkCommands({ linking }), links: links.store, receipts, registry
  });

  function link(telegramUser: FakeTelegramUser, userId = "user-1", overrides: Partial<TelegramLinkRecord> = {}): TelegramLinkRecord {
    const record: TelegramLinkRecord = {
      botId: fake.bot.id, currentChatId: null, displayName: telegramUser.first_name, id: `link-${userId}`,
      lastSeenAt: new Date(TEST_NOW), linkedAt: new Date(TEST_NOW), pendingAssistantId: null, searchEnabled: true, selectedModelId: null,
      selectedProvider: null, telegramChatId: telegramUser.id, telegramUserId: telegramUser.id, telegramUsername: telegramUser.username ?? null,
      userId, workspaceEnabled: false, ...overrides
    };
    links.records.set(userId, record);
    return record;
  }

  /** Hands one raw update to the dispatcher as a poll would, and waits until its handler returned. */
  async function deliver(raw: Record<string, unknown>): Promise<void> {
    const injected = await dispatcher.inject(decodeTelegramUpdate(raw) as TelegramUpdate, session);
    await injected.settled;
  }

  /** Sends what waits in merge windows and waits until every queued request and run settled. */
  async function settle(): Promise<void> {
    bridge.conversation.flush();
    await bridge.conversation.idle();
    await dispatcher.idle();
  }

  return {
    access, aiqsa, bridge, control, deliver, dispatcher, fake, link, links, messageRefs, registry, runLinks, session, sessions, settle,
    setSessionOn: (on: boolean) => { sessionOn = on; },
    setUser: (next: TelegramAccessUser) => { user = next; },
    close: () => fake.close()
  };
}

export type BridgeHarness = ReturnType<typeof createBridgeHarness>;

/** The callback data of the button with this text on a bot message. */
export function buttonData(message: { reply_markup?: unknown } | undefined, text: string | RegExp): string {
  const keyboard = (message?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string; text: string }>> } | undefined)
    ?.inline_keyboard ?? [];
  const button = keyboard.flat().find((entry) => typeof text === "string" ? entry.text === text : text.test(entry.text));
  if (!button?.callback_data) throw new Error(`button not found: ${String(text)}`);
  return button.callback_data;
}
