import type { TelegramCallbackKind } from "../../contracts/telegram";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent, runInBackground } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import {
  decodeTelegramUpdate, type TelegramBotApi, type TelegramCallbackQuery, type TelegramMessage, type TelegramUpdate
} from "./botApi";
import { telegramFailureCode } from "./codes";
import type { TelegramAccessResolver, TelegramAccessRefusal } from "./control/access";
import { TELEGRAM_COPY, telegramReasonText } from "./copy";
import type { TelegramOutbound } from "./outbound";
import type { TelegramCallbackRecord, TelegramCallbackStore } from "./store/callbacks";
import type { TelegramLinkRecord, TelegramLinkStore } from "./store/links";
import type { TelegramReceiptStore } from "./store/receipts";

/**
 * Routes claimed updates. Only private chats count: group and channel
 * additions make the bot leave, and other chats' messages are ignored.
 * Updates of one chat run strictly in order (at most 20 waiting; more get
 * one "busy" reply), at most 8 chats at a time. Every message and button is
 * checked against the sender's link and access before anything acts on it;
 * strangers learn only that the bot serves this AIQSA's users (or why their
 * link code was refused), at most once an hour. Later features plug in
 * through the handler registry.
 */

export type TelegramBotSession = Readonly<{
  api: TelegramBotApi;
  botId: number;
  botUsername: string;
  generation: number;
  outbound: TelegramOutbound;
}>;

export type TelegramCommand = Readonly<{ name: string; args: string }>;

/** A message from a linked user whose access was just allowed. */
export type TelegramMessageContext = Readonly<{
  updateId: number;
  message: TelegramMessage;
  link: TelegramLinkRecord;
  bot: TelegramBotSession;
  /** The leading command (lowercase, without slash), when the text starts with one for this bot. */
  command: TelegramCommand | null;
}>;
/** Returns true when it handled the message; the next registered handler runs otherwise. */
export type TelegramMessageHandler = (context: TelegramMessageContext) => Promise<boolean>;

export type TelegramCallbackContext = Readonly<{
  updateId: number;
  query: TelegramCallbackQuery;
  callback: TelegramCallbackRecord;
  link: TelegramLinkRecord;
  bot: TelegramBotSession;
  chatId: number;
  /** The message carrying the button, when Telegram still names it. */
  messageId: number | null;
}>;
/** The pop-up text of the press (at most 200 characters); `answerCallbackQuery` is always sent. */
export type TelegramCallbackReply = Readonly<{ text?: string; showAlert?: boolean }>;
export type TelegramCallbackHandler = (context: TelegramCallbackContext) => Promise<TelegramCallbackReply | void>;
export type TelegramCallbackOptions = Readonly<{
  /** Consumed before the handler runs, so a second press is refused (default true). */
  singleUse?: boolean;
}>;

export type TelegramStopContext = Readonly<{
  updateId: number;
  draftId: number;
  chatId: number;
  link: TelegramLinkRecord;
  bot: TelegramBotSession;
}>;
export type TelegramStopHandler = (context: TelegramStopContext) => Promise<void>;

/** The core account commands (`linking/commands.ts`). */
export type TelegramLinkCommands = Readonly<{
  /**
   * `/start <code>` from anyone: confirms a link itself and hands a refusal's text to `refuse`,
   * which answers a stranger only as often as any other stranger message.
   */
  start(context: Readonly<{
    bot: TelegramBotSession; message: TelegramMessage; code: string; refuse(text: string): Promise<void>;
  }>): Promise<void>;
  unlink(context: Readonly<{ bot: TelegramBotSession; message: TelegramMessage; link: TelegramLinkRecord }>): Promise<void>;
  help(context: Readonly<{ bot: TelegramBotSession; message: TelegramMessage }>): Promise<void>;
  confirmUnlink(context: TelegramCallbackContext): Promise<TelegramCallbackReply>;
}>;

// ---------------------------------------------------------------------------
// Handler registry (process-wide, shared across route bundles)

type CallbackRegistration = Readonly<{ handler: TelegramCallbackHandler; singleUse: boolean }>;

export type TelegramHandlerRegistry = Readonly<{
  registerMessage(handler: TelegramMessageHandler): () => void;
  registerCallback(kind: TelegramCallbackKind, handler: TelegramCallbackHandler, options?: TelegramCallbackOptions): () => void;
  registerStop(handler: TelegramStopHandler): () => void;
  messageHandlers(): readonly TelegramMessageHandler[];
  callbackHandler(kind: TelegramCallbackKind): CallbackRegistration | undefined;
  stopHandlers(): readonly TelegramStopHandler[];
}>;

/** Kinds the core owns; registrations for them are refused. */
const CORE_CALLBACK_KINDS: ReadonlySet<TelegramCallbackKind> = new Set(["unlink_confirm"]);

export function createTelegramHandlerRegistry(): TelegramHandlerRegistry {
  const messages: TelegramMessageHandler[] = [];
  const callbacks = new Map<TelegramCallbackKind, CallbackRegistration>();
  const stops: TelegramStopHandler[] = [];
  const remover = <T>(list: T[], entry: T) => () => {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
  return Object.freeze({
    registerMessage(handler: TelegramMessageHandler) {
      messages.push(handler);
      return remover(messages, handler);
    },
    registerCallback(kind: TelegramCallbackKind, handler: TelegramCallbackHandler, options: TelegramCallbackOptions = {}) {
      if (CORE_CALLBACK_KINDS.has(kind)) throw new Error("telegram_callback_kind_reserved");
      const registration = { handler, singleUse: options.singleUse ?? true };
      callbacks.set(kind, registration);
      return () => {
        if (callbacks.get(kind) === registration) callbacks.delete(kind);
      };
    },
    registerStop(handler: TelegramStopHandler) {
      stops.push(handler);
      return remover(stops, handler);
    },
    messageHandlers: () => [...messages],
    callbackHandler: (kind: TelegramCallbackKind) => callbacks.get(kind),
    stopHandlers: () => [...stops]
  });
}

const globalForRegistry = globalThis as unknown as { __aiqsaTelegramHandlers?: TelegramHandlerRegistry };

export function telegramHandlerRegistry(): TelegramHandlerRegistry {
  globalForRegistry.__aiqsaTelegramHandlers ??= createTelegramHandlerRegistry();
  return globalForRegistry.__aiqsaTelegramHandlers;
}

/**
 * Messages of linked users with access, after `/start`, `/unlink` and `/help`; handlers run in
 * registration order inside their chat's ordered lane, so a handler returns once the message is
 * admitted and streams an answer in the background, or the chat's later messages wait for it.
 */
export function registerTelegramMessageHandler(handler: TelegramMessageHandler): () => void {
  return telegramHandlerRegistry().registerMessage(handler);
}

/** Presses of one button kind, from the link's own account and chat, with access checked first. */
export function registerTelegramCallbackHandler(
  kind: TelegramCallbackKind, handler: TelegramCallbackHandler, options?: TelegramCallbackOptions
): () => void {
  return telegramHandlerRegistry().registerCallback(kind, handler, options);
}

/** The Stop button of a streamed draft (`stopped_message_generation`), with access checked first. */
export function registerTelegramStopHandler(handler: TelegramStopHandler): () => void {
  return telegramHandlerRegistry().registerStop(handler);
}

// ---------------------------------------------------------------------------
// Dispatcher

export const TELEGRAM_CHAT_QUEUE_LIMIT = 20;
export const TELEGRAM_DISPATCH_CONCURRENCY = 8;
export const TELEGRAM_UNKNOWN_REPLY_INTERVAL_MS = 3_600_000;
const NOTICE_MEMORY_LIMIT = 10_000;
const CALLBACK_ANSWER_MAX_LENGTH = 200;
const COMMAND_PATTERN = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/u;
const JOINED_STATUSES = new Set(["member", "administrator", "restricted", "creator"]);

export type TelegramDispatcher = Readonly<{
  /** Queues one claimed update; `settled` resolves once it was handled or refused. */
  dispatch(update: TelegramUpdate, session: TelegramBotSession): Readonly<{ settled: Promise<void> }>;
  /** Claims one update outside a poll (test-mode injection), then dispatches it. */
  inject(update: TelegramUpdate, session: TelegramBotSession): Promise<Readonly<{ claimed: boolean; settled: Promise<void> }>>;
  /** Resolves when no update waits or runs. */
  idle(): Promise<void>;
}>;

export type TelegramDispatcherDeps = Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  callbacks: Pick<TelegramCallbackStore, "consume" | "resolve">;
  commands: TelegramLinkCommands;
  links: Pick<TelegramLinkStore, "findByChat" | "findByTelegramUser" | "findByUserId" | "touch">;
  receipts: Pick<TelegramReceiptStore, "claim" | "finish">;
  registry: TelegramHandlerRegistry;
  /** Answers messages no registered handler took. */
  fallback?: TelegramMessageHandler;
  now?: () => number;
  queueLimit?: number;
  concurrency?: number;
  unknownReplyIntervalMs?: number;
}>;

/** Content-free: stages, outcomes, stable codes and counts only. */
function log(fields: Readonly<{
  action?: "retry" | "skip"; code?: string; error?: unknown; httpStatus?: number;
  outcome: "completed" | "failed" | "skipped"; prisma_code?: string; stage: "claim" | "dispatch" | "process";
}>): void {
  logEvent("service_operation", { subsystem: "telegram", ...fields });
}

export function parseTelegramCommand(text: string | undefined, botUsername: string): TelegramCommand | null {
  if (!text?.startsWith("/")) return null;
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return null;
  if (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { args: (match[3] ?? "").trim(), name: match[1]!.toLowerCase() };
}

/** The ordered lane an update runs in; null when nothing handles it. */
function laneOf(update: TelegramUpdate): string | null {
  switch (update.kind) {
    case "message":
    case "edited_message":
      return `message:${update.message.chat.id}`;
    case "callback_query":
      return `control:${update.callback_query.message?.chat.id ?? update.callback_query.from.id}`;
    case "stopped_message_generation":
      return `control:${update.stopped_message_generation.chat.id}`;
    case "my_chat_member":
      return `member:${update.my_chat_member.chat.id}`;
    default:
      return null;
  }
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function remember<K>(memory: Map<K, number>, key: K, at: number): void {
  memory.delete(key);
  memory.set(key, at);
  while (memory.size > NOTICE_MEMORY_LIMIT) memory.delete(memory.keys().next().value as K);
}

/** What no registered handler took (a sticker, a video, …) gets the unsupported-message reason. */
export const unsupportedMessageHandler: TelegramMessageHandler = async (context) => {
  await context.bot.outbound.sendText({ chatId: context.message.chat.id, text: telegramReasonText("telegram_unsupported_message")! });
  return true;
};

export function createTelegramDispatcher(deps: TelegramDispatcherDeps): TelegramDispatcher {
  const now = deps.now ?? Date.now;
  const queueLimit = deps.queueLimit ?? TELEGRAM_CHAT_QUEUE_LIMIT;
  const concurrency = deps.concurrency ?? TELEGRAM_DISPATCH_CONCURRENCY;
  const unknownInterval = deps.unknownReplyIntervalMs ?? TELEGRAM_UNKNOWN_REPLY_INTERVAL_MS;
  const fallback = deps.fallback ?? unsupportedMessageHandler;
  const unknownReplies = new Map<number, number>();
  const editNotices = new Map<string, number>();

  type Job = Readonly<{ run: () => Promise<void>; done: () => void }>;
  type Lane = { jobs: Job[]; running: boolean; overflowNoticed: boolean };
  const lanes = new Map<string, Lane>();
  const ready: string[] = [];
  let active = 0;
  let idleWaiters: Array<() => void> = [];

  function settleIdle(): void {
    if (active > 0 || ready.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function pump(): void {
    while (active < concurrency && ready.length > 0) {
      const key = ready.shift()!;
      const lane = lanes.get(key);
      if (!lane || lane.running || lane.jobs.length === 0) continue;
      const job = lane.jobs.shift()!;
      lane.running = true;
      active += 1;
      void runInBackground(() => job.run()).catch(() => undefined).finally(() => {
        active -= 1;
        lane.running = false;
        if (lane.jobs.length > 0) ready.push(key);
        else lanes.delete(key);
        job.done();
        pump();
        settleIdle();
      });
    }
  }

  function enqueue(key: string, run: () => Promise<void>, overflow: (first: boolean) => Promise<void>): Promise<void> {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { jobs: [], overflowNoticed: false, running: false };
      lanes.set(key, lane);
    }
    if (lane.jobs.length >= queueLimit) {
      const first = !lane.overflowNoticed;
      lane.overflowNoticed = true;
      return overflow(first);
    }
    const target = lane;
    return new Promise<void>((resolve) => {
      target.jobs.push({ done: resolve, run });
      if (!target.running && !ready.includes(key)) ready.push(key);
      pump();
    });
  }

  async function finish(update: TelegramUpdate, session: TelegramBotSession, state: "done" | "failed"): Promise<void> {
    try {
      await deps.receipts.finish({ botId: session.botId, state, updateId: update.update_id });
    } catch (error) {
      log({ code: "telegram_receipt_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "process" });
    }
  }

  async function say(session: TelegramBotSession, chatId: number, text: string): Promise<void> {
    await session.outbound.sendText({ chatId, text });
  }

  async function refuse(session: TelegramBotSession, chatId: number, code: TelegramAccessRefusal): Promise<void> {
    await say(session, chatId, telegramReasonText(code) ?? TELEGRAM_COPY.notLinked);
  }

  /**
   * At most one answer an hour per Telegram user that is not linked from this chat: the same
   * text for every stranger, or the refusal of a link code they sent.
   */
  async function answerStranger(
    session: TelegramBotSession, telegramUserId: number, chatId: number, text: string = TELEGRAM_COPY.notLinked
  ): Promise<void> {
    const at = now();
    const last = unknownReplies.get(telegramUserId);
    if (last !== undefined && at - last < unknownInterval) return;
    remember(unknownReplies, telegramUserId, at);
    await say(session, chatId, text);
  }

  /** A refused `/start <code>`: the linked user always learns why; a stranger within the stranger limit. */
  async function refuseStart(session: TelegramBotSession, telegramUserId: number, chatId: number, text: string): Promise<void> {
    const link = await deps.links.findByTelegramUser(session.botId, telegramUserId);
    if (link && link.telegramChatId === chatId) return say(session, chatId, text);
    await answerStranger(session, telegramUserId, chatId, text);
  }

  async function handleMessage(updateId: number, message: TelegramMessage, session: TelegramBotSession): Promise<void> {
    const sender = message.from;
    if (message.chat.type !== "private" || message.chat.id <= 0 || !sender || sender.is_bot) return;
    const command = parseTelegramCommand(message.text, session.botUsername);
    if (command?.name === "start" && command.args) {
      await deps.commands.start({
        bot: session, code: command.args, message, refuse: (text) => refuseStart(session, sender.id, message.chat.id, text)
      });
      return;
    }
    const link = await deps.links.findByTelegramUser(session.botId, sender.id);
    if (!link || link.telegramChatId !== message.chat.id) return answerStranger(session, sender.id, message.chat.id);
    // Disconnecting only removes authority, so it works while access is off.
    if (command?.name === "unlink") return deps.commands.unlink({ bot: session, link, message });
    const access = await deps.access.resolveTelegramAccess(link.userId, { link });
    if (!access.allowed) return refuse(session, message.chat.id, access.reasonCode);
    await deps.links.touch(link.id, new Date(now()));
    if (command?.name === "help" || command?.name === "start") return deps.commands.help({ bot: session, message });
    const context: TelegramMessageContext = { bot: session, command, link: access.link, message, updateId };
    for (const handler of deps.registry.messageHandlers()) {
      if (await handler(context)) return;
    }
    await fallback(context);
  }

  async function handleEdited(message: TelegramMessage, session: TelegramBotSession): Promise<void> {
    const sender = message.from;
    if (message.chat.type !== "private" || message.chat.id <= 0 || !sender || sender.is_bot) return;
    const link = await deps.links.findByTelegramUser(session.botId, sender.id);
    if (!link || link.telegramChatId !== message.chat.id) return answerStranger(session, sender.id, message.chat.id);
    const access = await deps.access.resolveTelegramAccess(link.userId, { link });
    if (!access.allowed) return refuse(session, message.chat.id, access.reasonCode);
    const key = `${message.chat.id}:${message.message_id}`;
    if (editNotices.has(key)) return;
    remember(editNotices, key, now());
    await say(session, message.chat.id, TELEGRAM_COPY.editsNotApplied);
  }

  async function handleCallback(updateId: number, query: TelegramCallbackQuery, session: TelegramBotSession): Promise<void> {
    const chatId = query.message?.chat.id ?? query.from.id;
    let reply: TelegramCallbackReply = { text: TELEGRAM_COPY.buttonExpired };
    try {
      if (query.from.is_bot || chatId <= 0 || (query.message && query.message.chat.type !== "private")) return;
      const resolved = await deps.callbacks.resolve({
        botId: session.botId, data: query.data, now: new Date(now()), telegramChatId: chatId, telegramUserId: query.from.id
      });
      if (!resolved.ok) {
        log({ code: "telegram_button_refused", outcome: "skipped", stage: "dispatch" });
        return;
      }
      const { callback } = resolved;
      const link = await deps.links.findByUserId(callback.userId);
      if (!link || link.id !== callback.linkId) return;
      const core = callback.kind === "unlink_confirm";
      const registration = core ? { handler: deps.commands.confirmUnlink, singleUse: true } : deps.registry.callbackHandler(callback.kind);
      if (!registration) return;
      if (!core) {
        const access = await deps.access.resolveTelegramAccess(link.userId, { link });
        if (!access.allowed) {
          reply = { text: telegramReasonText(access.reasonCode) ?? TELEGRAM_COPY.buttonExpired };
          return;
        }
      }
      if (registration.singleUse && !(await deps.callbacks.consume({ id: callback.id, now: new Date(now()) }))) return;
      // From here a failure is the handler's own: the press says so instead of claiming the button expired.
      reply = { text: TELEGRAM_COPY.buttonFailed };
      reply = await registration.handler({
        bot: session, callback, chatId, link, messageId: query.message?.message_id ?? null, query, updateId
      }) ?? {};
    } finally {
      const answered = await session.api.answerCallbackQuery({
        callback_query_id: query.id,
        ...(reply.text ? { text: bounded(reply.text, CALLBACK_ANSWER_MAX_LENGTH) } : {}),
        ...(reply.showAlert ? { show_alert: true } : {})
      });
      if (!answered.ok) log({ code: telegramFailureCode(answered.kind, answered.errorCode), httpStatus: answered.status, outcome: "failed", stage: "dispatch" });
    }
  }

  async function handleStop(updateId: number, chatId: number, chatType: string, draftId: number, session: TelegramBotSession): Promise<void> {
    if (chatType !== "private" || chatId <= 0) return;
    const link = await deps.links.findByChat(session.botId, chatId);
    if (!link) return;
    const access = await deps.access.resolveTelegramAccess(link.userId, { link });
    if (!access.allowed) return;
    for (const handler of deps.registry.stopHandlers()) await handler({ bot: session, chatId, draftId, link: access.link, updateId });
  }

  async function handleMembership(update: Extract<TelegramUpdate, { kind: "my_chat_member" }>, session: TelegramBotSession): Promise<void> {
    const change = update.my_chat_member;
    if (change.chat.type === "private" || change.new_chat_member.user.id !== session.botId) return;
    if (!JOINED_STATUSES.has(change.new_chat_member.status)) return;
    // Only private chats: the bot leaves every group and channel it is added to.
    const left = await session.api.leaveChat(change.chat.id);
    if (left.ok) log({ code: "telegram_group_left", outcome: "completed", stage: "dispatch" });
    else log({ code: telegramFailureCode(left.kind, left.errorCode), httpStatus: left.status, outcome: "failed", stage: "dispatch" });
  }

  async function route(update: TelegramUpdate, session: TelegramBotSession): Promise<void> {
    switch (update.kind) {
      case "message":
        return handleMessage(update.update_id, update.message, session);
      case "edited_message":
        return handleEdited(update.message, session);
      case "callback_query":
        return handleCallback(update.update_id, update.callback_query, session);
      case "stopped_message_generation": {
        const stop = update.stopped_message_generation;
        return handleStop(update.update_id, stop.chat.id, stop.chat.type, stop.draft_id, session);
      }
      case "my_chat_member":
        return handleMembership(update, session);
      default:
        return;
    }
  }

  async function run(update: TelegramUpdate, session: TelegramBotSession): Promise<void> {
    let state: "done" | "failed" = "done";
    try {
      await route(update, session);
    } catch (error) {
      state = "failed";
      log({ code: "telegram_update_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "process" });
    }
    await finish(update, session, state);
  }

  async function overflow(update: TelegramUpdate, session: TelegramBotSession, first: boolean): Promise<void> {
    log({ code: "telegram_busy", outcome: "skipped", stage: "dispatch" });
    try {
      if (update.kind === "callback_query") {
        await session.api.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: telegramReasonText("telegram_busy") });
      } else if (first && update.kind === "message" && update.message.chat.type === "private" && update.message.chat.id > 0) {
        await say(session, update.message.chat.id, telegramReasonText("telegram_busy")!);
      }
    } catch (error) {
      log({ code: "telegram_update_failed", error, outcome: "failed", stage: "dispatch" });
    }
    await finish(update, session, "failed");
  }

  const dispatcher: TelegramDispatcher = Object.freeze({
    dispatch(update: TelegramUpdate, session: TelegramBotSession) {
      const lane = laneOf(update);
      if (lane === null) return { settled: finish(update, session, "done") };
      return { settled: enqueue(lane, () => run(update, session), (first) => overflow(update, session, first)) };
    },

    async inject(update: TelegramUpdate, session: TelegramBotSession) {
      const claimed = await deps.receipts.claim({ botId: session.botId, update: { kind: update.kind, updateId: update.update_id } });
      if (!claimed) return { claimed: false, settled: Promise.resolve() };
      return { claimed: true, settled: dispatcher.dispatch(update, session).settled };
    },

    idle() {
      return active === 0 && ready.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    }
  });
  return dispatcher;
}

// ---------------------------------------------------------------------------
// Test-mode injection

export const TELEGRAM_TEST_INJECTION_SETTLE_MS = 60_000;

/**
 * `POST /api/test/telegram/updates`: exists only in test mode (404 otherwise,
 * before the body is read). Takes one Bot API `Update` and hands it to the
 * dispatcher as if a poll returned it: claimed once by its update id, never
 * moving the stored offset. Answers once its handling settled (202 when it
 * outlasts the wait).
 */
export function createTelegramTestUpdateHandler(deps: Readonly<{
  enabled(): boolean;
  load(): Promise<Readonly<{ dispatcher: Pick<TelegramDispatcher, "inject">; sessions: Readonly<{ current(): Promise<TelegramBotSession | null> }> }>>;
  settleMs?: number;
}>) {
  const headers = { "cache-control": "no-store" };
  return async function POST(request: Request): Promise<Response> {
    if (!deps.enabled()) return Response.json({ error: "not_found" }, { headers, status: 404 });
    const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (type !== "application/json") return Response.json({ error: "json_required" }, { headers, status: 415 });
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    const update = decodeTelegramUpdate(body);
    if (!update) return Response.json({ error: "telegram_update_invalid" }, { headers, status: 400 });
    const { dispatcher, sessions } = await deps.load();
    const session = await sessions.current();
    if (!session) return Response.json({ error: "telegram_bot_off" }, { headers, status: 409 });
    const injected = await dispatcher.inject(update, session);
    if (!injected.claimed) return Response.json({ claimed: false, settled: true }, { headers });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      injected.settled.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), deps.settleMs ?? TELEGRAM_TEST_INJECTION_SETTLE_MS); })
    ]);
    clearTimeout(timer);
    return Response.json({ claimed: true, settled }, { headers, status: settled ? 200 : 202 });
  };
}
