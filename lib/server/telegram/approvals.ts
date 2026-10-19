import {
  decodeMcpApprovalCard, MCP_APPROVAL_CONTINUATION_KIND, type McpApprovalCard, type McpApprovalDecision
} from "../../contracts/mcpApprovals";
import type { TelegramCallbackKind } from "../../contracts/telegram";
import { MCP_APPROVAL_TTL_MS } from "../mcp/writeApproval";
import type { McpApprovalDecisionOutcome } from "../mcp/writeApprovalRepository";
import { logEvent, runInBackground } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { TelegramInlineKeyboardMarkup, TelegramInputRichBlock, TelegramInputRichMessage } from "./botApi";
import type { TelegramConversation } from "./bridge/conversation";
import { onTelegramRunEvent, type TelegramRunEventContext, type TelegramRunListener } from "./bridge/events";
import { telegramFailureCode } from "./codes";
import type { TelegramAccessResolver } from "./control/access";
import { reachTelegramChat, type TelegramChatBinding } from "./control/reach";
import type { TelegramSessionProvider } from "./control/session";
import {
  TELEGRAM_APPROVAL_COPY, TELEGRAM_COPY, telegramAlwaysAllowedText, telegramAlwaysAllowLabel, telegramApprovalTitle
} from "./copy";
import type { TelegramBotSession, TelegramCallbackHandler, TelegramHandlerRegistry } from "./dispatcher";
import type { TelegramKeyboard } from "./outbound";
import { plainTelegramMessage } from "./render";
import type { TelegramLinkRecord } from "./store/links";
import type { TelegramFailure } from "./transport";

/**
 * MCP approvals as Telegram buttons (D-15). An approval card of a Telegram
 * run (live, or found pending in the settled answer when the live event was
 * missed) becomes one message: "<server> · <tool>", what happens on Allow,
 * the call's redacted request (at most 1 500 characters) and Allow once,
 * Always allow <server> and Deny. A press decides as the run's initiator with
 * the button's id as nonce, while the run still settles retrying for 30 s
 * before asking to try again; the message then shows the decision actually
 * stored, whoever made it. An Allow starts nothing by itself: the bot sends
 * the continuation turn in order with the chat's messages, from the chat's
 * current leaf, streamed and delivered like any answer. Buttons decide within
 * the window an Allow once lasts (15 minutes); later the message says the
 * approval expired. Every decision attempt after a wait, every message with
 * the request and the continuation first check that the press's exact link
 * still reaches its chat with Telegram access allowed (D-04); once it does
 * not, nothing more is decided, shown or started from Telegram and the
 * approval stays pending in AIQSA. Logs carry ids and codes only.
 */

export const TELEGRAM_APPROVAL_CALLBACK_KINDS = [
  "approval_allow_once", "approval_allow_server", "approval_deny"
] as const satisfies readonly TelegramCallbackKind[];
export type TelegramApprovalCallbackKind = (typeof TELEGRAM_APPROVAL_CALLBACK_KINDS)[number];

/** Redacted request characters an approval message shows at most. */
export const TELEGRAM_APPROVAL_DETAILS_MAX_CHARS = 1_500;
/** How long a press waits for the approval's run to settle before asking to try again. */
export const TELEGRAM_APPROVAL_RUN_WAIT_MS = 30_000;
/** Buttons decide within the window an Allow once lasts. */
export const TELEGRAM_APPROVAL_WINDOW_MS = MCP_APPROVAL_TTL_MS;
const RETRY_FIRST_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4_000;
/** Runs whose announced approvals this process remembers, and approvals it continued. */
const MEMORY_LIMIT = 1_000;

/** Every code this module logs besides Telegram's transport codes. */
export const TELEGRAM_APPROVAL_LOG_CODES = ["telegram_approval_decision_failed", "telegram_approval_notice_failed"] as const;

const DECISIONS: Readonly<Record<TelegramApprovalCallbackKind, McpApprovalDecision>> = {
  approval_allow_once: "allow_once", approval_allow_server: "allow_server", approval_deny: "deny"
};
const KINDS: Readonly<Record<McpApprovalDecision, TelegramApprovalCallbackKind>> = {
  allow_once: "approval_allow_once", allow_server: "approval_allow_server", deny: "approval_deny"
};

/** The AIQSA operations of approvals, as the run's initiator. */
export type TelegramApprovalGateway = Readonly<{
  /** `decideMcpApproval`: the same nonce and decision replay the stored outcome. */
  decide(input: Readonly<{
    approvalId: string; decision: McpApprovalDecision; nonce: string; runId: string; userId: string;
  }>): Promise<McpApprovalDecisionOutcome>;
  /** The approval's card as its initiator sees it now; null when it is gone. */
  card(input: Readonly<{ approvalId: string; runId: string; userId: string }>): Promise<McpApprovalCard | null>;
  /** The refused call's redacted request as the web shows it; null when unavailable. */
  details(input: Readonly<{ ordinal: number; roundIndex: number; runId: string; userId: string }>): Promise<string | null>;
}>;

/** What a button names: identifiers, its window and (on a button offered again) the nonce of the first press. */
type ApprovalPayload = Readonly<{ approvalId: string; chatId: string; runId: string; until: number; nonce?: string }>;

type Press = Readonly<{
  decision: McpApprovalDecision;
  link: TelegramLinkRecord;
  messageId: number | null;
  nonce: string;
  payload: ApprovalPayload;
  telegramChatId: number;
  updateId: number;
}>;

type View = Readonly<{ card: McpApprovalCard; expired?: boolean; notice?: string; retry?: boolean }>;

export type TelegramApprovals = Readonly<{
  listener: TelegramRunListener;
  callbacks: Readonly<Record<TelegramApprovalCallbackKind, TelegramCallbackHandler>>;
  /** Resolves when no approval message or decision is in progress (tests and shutdown). */
  idle(): Promise<void>;
}>;

export type TelegramApprovalsDeps = Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  conversation: Pick<TelegramConversation, "submit">;
  gateway: TelegramApprovalGateway;
  sessions: TelegramSessionProvider;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/u;

/** Content-free: ids, codes and HTTP status. */
function log(fields: Readonly<{
  code: string; error?: unknown; httpStatus?: number; outcome: "degraded" | "failed" | "skipped"; runId?: string;
}>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    ...(fields.httpStatus ? { httpStatus: fields.httpStatus } : {}), outcome: fields.outcome,
    ...(fields.runId ? { run_id: fields.runId } : {}), stage: "dispatch", subsystem: "telegram"
  });
}

function logFailure(failure: TelegramFailure, runId: string): void {
  log({ code: telegramFailureCode(failure.kind, failure.errorCode), httpStatus: failure.status, outcome: "failed", runId });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function decodePayload(value: Readonly<Record<string, unknown>>): ApprovalPayload | null {
  const { approvalId, chatId, nonce, runId, until } = value;
  if (typeof approvalId !== "string" || !ID.test(approvalId) || typeof runId !== "string" || !ID.test(runId) ||
    typeof chatId !== "string" || !ID.test(chatId) || typeof until !== "number" || !Number.isSafeInteger(until) ||
    (nonce !== undefined && (typeof nonce !== "string" || !NONCE.test(nonce)))) return null;
  return { approvalId, chatId, runId, until, ...(typeof nonce === "string" ? { nonce } : {}) };
}

/** The request as the message shows it: at most 1 500 characters, never splitting a character. */
export function boundedTelegramApprovalDetails(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= TELEGRAM_APPROVAL_DETAILS_MAX_CHARS) return trimmed;
  let cut = TELEGRAM_APPROVAL_DETAILS_MAX_CHARS - 1;
  const code = trimmed.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${trimmed.slice(0, cut)}…`;
}

function stateText(card: McpApprovalCard, expired: boolean): string {
  switch (card.state) {
    case "allowed_once": return TELEGRAM_COPY.allowedOnce;
    case "allowed_server": return telegramAlwaysAllowedText(card.serverName);
    case "denied": return TELEGRAM_COPY.denied;
    case "pending":
      if (expired) return TELEGRAM_COPY.approvalExpired;
      return card.source === "code" ? TELEGRAM_APPROVAL_COPY.pendingCode
        : card.source === "agent" ? TELEGRAM_APPROVAL_COPY.pendingAgent : TELEGRAM_APPROVAL_COPY.pendingModel;
  }
}

/** One approval as its message shows it: the tool, its state, the redacted request and a notice. */
export function telegramApprovalMessage(input: Readonly<{
  card: McpApprovalCard; details: string | null; expired?: boolean; notice?: string;
}>): TelegramInputRichMessage {
  const blocks: TelegramInputRichBlock[] = [
    { type: "paragraph", text: { type: "bold", text: telegramApprovalTitle(input.card.serverName, input.card.toolName) } },
    { type: "paragraph", text: stateText(input.card, input.expired === true) },
    ...(input.details ? [{ type: "pre" as const, language: "json", text: input.details }] : []),
    ...(input.notice ? [{ type: "paragraph" as const, text: input.notice }] : [])
  ];
  return { blocks };
}

/** Allow once and Deny, then Always allow <server>; a button offered again keeps its first press's nonce. */
export function telegramApprovalKeyboard(
  card: McpApprovalCard, payload: Omit<ApprovalPayload, "nonce">, nonces: Partial<Record<McpApprovalDecision, string>> = {}
): TelegramKeyboard {
  const button = (decision: McpApprovalDecision, text: string) => {
    const nonce = nonces[decision];
    return { callback: { kind: KINDS[decision], payload: { ...payload, ...(nonce ? { nonce } : {}) } }, text };
  };
  return [
    [button("allow_once", TELEGRAM_COPY.allowOnce), button("deny", TELEGRAM_COPY.deny)],
    [button("allow_server", telegramAlwaysAllowLabel(card.serverName))]
  ];
}

function unchanged(failure: TelegramFailure): boolean {
  return failure.kind === "telegram" && failure.errorCode === 400 && /not modified/iu.test(failure.description ?? "");
}

function remember<K, V>(memory: Map<K, V>, key: K, value: V): void {
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as K);
}

export function createTelegramApprovals(deps: TelegramApprovalsDeps): TelegramApprovals {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  /** Approvals announced per run, so the settled answer's cards add only those the live stream missed. */
  const announced = new Map<string, Set<string>>();
  /** Approvals whose continuation this process started. */
  const continued = new Map<string, true>();
  /** One job at a time per approval: its message and presses never interleave. */
  const chains = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();

  function enqueue(approvalId: string, code: (typeof TELEGRAM_APPROVAL_LOG_CODES)[number], job: () => Promise<void>): void {
    const run = (chains.get(approvalId) ?? Promise.resolve()).then(() => runInBackground(job))
      .catch((error: unknown) => log({ code, error, outcome: "failed" }));
    chains.set(approvalId, run);
    pending.add(run);
    void run.finally(() => {
      pending.delete(run);
      if (chains.get(approvalId) === run) chains.delete(approvalId);
    });
  }

  async function readDetails(card: McpApprovalCard, runId: string, userId: string): Promise<string | null> {
    if (!card.details) return null;
    try {
      const text = await deps.gateway.details({ ...card.details, runId, userId });
      return text ? boundedTelegramApprovalDetails(text) : null;
    } catch (error) {
      // The message still asks; the request stays reviewable in AIQSA.
      log({ code: "telegram_approval_notice_failed", error, outcome: "degraded", runId });
      return null;
    }
  }

  /** The bot and the link while the bound chat may still receive approvals (D-04), or null (logged). */
  async function reach(
    binding: TelegramChatBinding, runId: string
  ): Promise<Readonly<{ bot: TelegramBotSession; link: TelegramLinkRecord }> | null> {
    const reached = await reachTelegramChat(deps, binding);
    if (reached.ok) return reached;
    log({ code: reached.reasonCode, outcome: "skipped", runId });
    return null;
  }

  /**
   * Asks the chat's authority again right before each Bot API dispatch, after the client's
   * pacing and 429 waits (a send refused here returns `unreachable`, nothing is dispatched).
   */
  function authority(binding: TelegramChatBinding): () => Promise<boolean> {
    return async () => (await reachTelegramChat(deps, binding)).ok;
  }

  /** The chat a press came from, bound to the link it was pressed through. */
  function pressed(press: Press): TelegramChatBinding {
    return { botId: press.link.botId, linkId: press.link.id, telegramChatId: press.telegramChatId, userId: press.link.userId };
  }

  /** Sends one pending approval's message; false when it did not reach Telegram. */
  async function announce(card: McpApprovalCard, context: TelegramRunEventContext): Promise<boolean> {
    const details = await readDetails(card, context.runId, context.userId);
    // Checked once the request is read, right before it goes out.
    const binding = { botId: context.bot.botId, linkId: context.linkId, telegramChatId: context.telegramChatId, userId: context.userId };
    const reached = await reach(binding, context.runId);
    if (!reached) return false;
    const delivery = await reached.bot.outbound.sendContent({
      authorize: authority(binding),
      chatId: context.telegramChatId,
      keyboard: telegramApprovalKeyboard(card, {
        approvalId: card.approvalId, chatId: context.chatId, runId: context.runId, until: now() + TELEGRAM_APPROVAL_WINDOW_MS
      }),
      messages: [telegramApprovalMessage({ card, details })],
      owner: { chatId: context.chatId, linkId: context.linkId, userId: context.userId }
    });
    if (delivery.ok) return true;
    if (delivery.failure.kind !== "unreachable") {
      log({ code: "telegram_approval_notice_failed", httpStatus: delivery.failure.status, outcome: "failed", runId: context.runId });
    }
    return false;
  }

  function offer(card: McpApprovalCard, context: TelegramRunEventContext): void {
    if (card.state !== "pending" || card.canDecide !== true) return;
    const seen = announced.get(context.runId) ?? new Set<string>();
    remember(announced, context.runId, seen);
    if (seen.has(card.approvalId)) return;
    seen.add(card.approvalId);
    enqueue(card.approvalId, "telegram_approval_notice_failed", async () => {
      // Not sent: the settled answer's card may still bring it.
      if (!(await announce(card, context))) seen.delete(card.approvalId);
    });
  }

  /**
   * Edits the pressed message in place, rich first, then as plain text: `edited`, `failed` when
   * it can no longer be edited (a new message may follow), or `unreachable` when the chat's
   * authority ended (nothing more may go out).
   */
  async function edit(bot: TelegramBotSession, press: Press, content: Readonly<{ message?: TelegramInputRichMessage; text?: string }>,
    markup: TelegramInlineKeyboardMarkup | undefined): Promise<"edited" | "failed" | "unreachable"> {
    if (press.messageId === null) return "failed";
    const target = { chat_id: press.telegramChatId, message_id: press.messageId, ...(markup ? { reply_markup: markup } : {}) };
    const options = { authorize: authority(pressed(press)) };
    if (content.message) {
      const rich = await bot.api.editMessageText({ ...target, rich_message: { ...content.message, skip_entity_detection: true } }, options);
      if (rich.ok || unchanged(rich)) return "edited";
      if (!rich.ok && rich.kind === "unreachable") return "unreachable";
      if (rich.kind !== "telegram" || rich.errorCode !== 400) {
        logFailure(rich, press.payload.runId);
        return "failed";
      }
    }
    const text = (content.text ?? plainTelegramMessage(content.message!).join("\n\n")).slice(0, 4_096);
    const plain = await bot.api.editMessageText({ ...target, link_preview_options: { is_disabled: true }, text }, options);
    if (plain.ok || unchanged(plain)) return "edited";
    if (!plain.ok && plain.kind === "unreachable") return "unreachable";
    logFailure(plain, press.payload.runId);
    return "failed";
  }

  /**
   * Shows the approval as it now is on the pressed message (or anew when it cannot be edited),
   * only while the press's chat may still receive it.
   */
  async function show(press: Press, view: View | null): Promise<void> {
    const owner = { chatId: press.payload.chatId, linkId: press.link.id, userId: press.link.userId };
    const details = view ? await readDetails(view.card, press.payload.runId, press.link.userId) : null;
    // Checked once the request is read, right before the decision and the request go out.
    const reached = await reach(pressed(press), press.payload.runId);
    if (!reached) return;
    const { bot } = reached;
    if (!view) {
      if (await edit(bot, press, { text: TELEGRAM_APPROVAL_COPY.unavailable }, undefined) === "failed") {
        await bot.outbound.sendText({ authorize: authority(pressed(press)), chatId: press.telegramChatId, text: TELEGRAM_APPROVAL_COPY.unavailable });
      }
      return;
    }
    const message = telegramApprovalMessage({
      card: view.card, details, ...(view.expired ? { expired: true } : {}), ...(view.notice ? { notice: view.notice } : {})
    });
    const keyboard = view.retry && view.card.state === "pending" && view.card.canDecide
      ? telegramApprovalKeyboard(view.card, { approvalId: press.payload.approvalId, chatId: press.payload.chatId, runId: press.payload.runId,
        until: press.payload.until }, { [press.decision]: press.nonce })
      : undefined;
    const markup = keyboard ? await bot.outbound.replyMarkup({ keyboard, linkId: press.link.id }) : undefined;
    if (await edit(bot, press, { message }, markup) !== "failed") return;
    await bot.outbound.sendContent({
      authorize: authority(pressed(press)), chatId: press.telegramChatId, ...(keyboard ? { keyboard } : {}), messages: [message], owner
    });
  }

  type Decided = McpApprovalDecisionOutcome | Readonly<{ kind: "failed" }>;

  /**
   * Decides, retrying while the run still settles (and after a failed write) for at most 30 s;
   * null when a wait outlived the press's link, the user's access or the bot.
   */
  async function decide(press: Press): Promise<Decided | null> {
    const deadline = now() + TELEGRAM_APPROVAL_RUN_WAIT_MS;
    let delay = RETRY_FIRST_DELAY_MS;
    for (;;) {
      let outcome: Decided;
      try {
        outcome = await deps.gateway.decide({
          approvalId: press.payload.approvalId, decision: press.decision, nonce: press.nonce, runId: press.payload.runId,
          userId: press.link.userId
        });
      } catch (error) {
        // The same nonce replays a decision that was stored after all.
        log({ code: "telegram_approval_decision_failed", error, outcome: "failed", runId: press.payload.runId });
        outcome = { kind: "failed" };
      }
      if ((outcome.kind !== "run_active" && outcome.kind !== "failed") || now() + delay > deadline) return outcome;
      await sleep(delay);
      delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
      // Nothing is decided for a chat that may no longer decide: no consent outlives the link or access.
      if (!(await reach(pressed(press), press.payload.runId))) return null;
    }
  }

  async function card(press: Press): Promise<McpApprovalCard | null> {
    try {
      return await deps.gateway.card({ approvalId: press.payload.approvalId, runId: press.payload.runId, userId: press.link.userId });
    } catch (error) {
      log({ code: "telegram_approval_decision_failed", error, outcome: "failed", runId: press.payload.runId });
      return null;
    }
  }

  /** The continuation turn of an Allow, once, in order with the chat's messages, while the press's chat may still receive it. */
  async function continueAnswer(press: Press): Promise<void> {
    if (continued.has(press.payload.approvalId)) return;
    const reached = await reach(pressed(press), press.payload.runId);
    if (!reached) return;
    remember(continued, press.payload.approvalId, true);
    deps.conversation.submit(reached.link, reached.bot, {
      chatId: press.payload.chatId, contentBlocks: [],
      systemTurn: { approvalId: press.payload.approvalId, kind: MCP_APPROVAL_CONTINUATION_KIND }, updateId: press.updateId
    });
  }

  async function decidePress(press: Press): Promise<void> {
    // A press that waited behind another one is checked as it starts.
    if (!(await reach(pressed(press), press.payload.runId))) return;
    if (now() >= press.payload.until) {
      // Past the window: the card shows the decision stored meanwhile, or that it expired.
      const current = await card(press);
      return show(press, current ? { card: current, expired: true } : null);
    }
    const outcome = await decide(press);
    if (!outcome) return;
    switch (outcome.kind) {
      case "decided":
        await show(press, { card: outcome.card });
        if (outcome.continuation) await continueAnswer(press);
        return;
      case "conflict":
        // Decided otherwise first (in AIQSA, or by another button): that decision stands and continues nothing here.
        return show(press, { card: outcome.card });
      case "not_found":
        return show(press, null);
      default: {
        const current = await card(press);
        if (current && current.state !== "pending") return show(press, { card: current });
        return show(press, current ? {
          card: current, notice: outcome.kind === "run_active" ? TELEGRAM_APPROVAL_COPY.stillRunning : TELEGRAM_APPROVAL_COPY.notSaved, retry: true
        } : null);
      }
    }
  }

  function handler(kind: TelegramApprovalCallbackKind): TelegramCallbackHandler {
    return async (context) => {
      const payload = decodePayload(context.callback.payload);
      if (!payload) return { text: TELEGRAM_COPY.buttonExpired };
      // Answered at once; the message itself shows the outcome when the decision is stored.
      enqueue(payload.approvalId, "telegram_approval_decision_failed", () => decidePress({
        decision: DECISIONS[kind], link: context.link, messageId: context.messageId, nonce: payload.nonce ?? context.callback.id, payload,
        telegramChatId: context.chatId, updateId: context.updateId
      }));
      return {};
    };
  }

  const listener: TelegramRunListener = (event, context) => {
    if (event.type === "approvalRequested") {
      const decoded = decodeMcpApprovalCard(event.card);
      if (decoded) offer(decoded, context);
    } else if (event.type === "delivered") {
      for (const value of event.artifactSummary?.mcpApprovals ?? []) {
        const decoded = decodeMcpApprovalCard(value);
        if (decoded) offer(decoded, context);
      }
    }
  };

  return Object.freeze({
    callbacks: Object.freeze({
      approval_allow_once: handler("approval_allow_once"),
      approval_allow_server: handler("approval_allow_server"),
      approval_deny: handler("approval_deny")
    }),
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    listener
  });
}

/** The application's approval operations, loading the MCP stack on first use. */
export function createDefaultTelegramApprovalGateway(): TelegramApprovalGateway {
  type DetailsReader = (key: Readonly<{ ordinal: number; roundIndex: number; runId: string; userId: string }>) =>
    Promise<Readonly<{ request: Readonly<{ text: string }> | null }> | null>;
  let details: Promise<DetailsReader> | null = null;
  const repository = async () => Promise.all([import("../prisma"), import("../mcp/writeApprovalRepository")]);
  return Object.freeze({
    async decide(input) {
      const [{ prisma }, { decideMcpApproval }] = await repository();
      return decideMcpApproval(prisma, input);
    },
    async card(input) {
      const [{ prisma }, { loadRunMcpApprovalCards }] = await repository();
      const cards = await loadRunMcpApprovalCards(prisma, { runId: input.runId, userId: input.userId });
      return cards.find((card) => card.approvalId === input.approvalId) ?? null;
    },
    async details(input) {
      details ??= (async () => {
        const [{ prisma }, { mcpCallDetailsForStorage }, { createS3StorageAdapter }] = await Promise.all([
          import("../prisma"), import("../mcp/callDetailsServices"), import("../uploads/storage")
        ]);
        return mcpCallDetailsForStorage(prisma, createS3StorageAdapter()) as DetailsReader;
      })().catch((error: unknown) => {
        details = null;
        throw error;
      });
      return (await (await details)(input))?.request?.text ?? null;
    }
  });
}

/** Approval messages and buttons for every Telegram run of this process; returns the function that removes them. */
export function registerTelegramApprovals(deps: Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  conversation: Pick<TelegramConversation, "submit">;
  registry: Pick<TelegramHandlerRegistry, "registerCallback">;
  sessions: TelegramSessionProvider;
  gateway?: TelegramApprovalGateway;
}>): () => void {
  const approvals = createTelegramApprovals({
    access: deps.access, conversation: deps.conversation, gateway: deps.gateway ?? createDefaultTelegramApprovalGateway(), sessions: deps.sessions
  });
  const removers = [
    onTelegramRunEvent(approvals.listener),
    ...TELEGRAM_APPROVAL_CALLBACK_KINDS.map((kind) => deps.registry.registerCallback(kind, approvals.callbacks[kind]))
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
