import { randomBytes } from "node:crypto";
import type { ThreadArtifactSummary } from "../../../contracts/chats";
import type { TelegramCallbackKind } from "../../../contracts/telegram";
import { logEvent, runInBackground } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramInlineKeyboardMarkup, TelegramInputRichBlock, TelegramInputRichMessage } from "../botApi";
import { onTelegramRunEvent, type TelegramRunEventContext, type TelegramRunListener } from "../bridge/events";
import { telegramFailureCode } from "../codes";
import type { TelegramAccessResolver } from "../control/access";
import { reachTelegramChat, type TelegramChatBinding } from "../control/reach";
import type { TelegramSessionProvider } from "../control/session";
import type { TelegramBotSession, TelegramCallbackHandler, TelegramHandlerRegistry } from "../dispatcher";
import type { TelegramKeyboard } from "../outbound";
import { plainTelegramMessage } from "../render";
import { TELEGRAM_CALLBACK_GROUP_KEY, TELEGRAM_CALLBACK_MAX_TTL_MS } from "../store/callbacks";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramFailure } from "../transport";
import type { TelegramChangeGateway } from "./gateway";
import {
  telegramAnswerChanges, telegramChangeKey, telegramChangePlan, telegramChangeRef, telegramChangeResult, type TelegramChange,
  type TelegramChangeOutcome, type TelegramChangePlan, type TelegramChangeVerb, type TelegramChangeView
} from "./plan";

/**
 * The changes a Telegram answer made to the user's own resources (operator
 * decision 2026-11-16: Telegram gets what the web chat can do). Once the
 * answer is delivered, each change its web answer shows as a card becomes one
 * message: what changed, with Undo where the web card has it, or a proposal
 * (deleting, sharing or publishing beyond the user) with Confirm and Cancel.
 * Nothing is deleted or shared until the user presses Confirm, as on the web,
 * where the turn also goes on without waiting for the card.
 *
 * A button is a random server row naming only the run, its chat and a hash of
 * the change (`store/callbacks.ts`); the dispatcher counts a press only from
 * the link's own Telegram account in its own chat and uses each button once,
 * Confirm and Cancel together. A press then reads the run's answer again as
 * the link's user (a run of anyone else, or of another chat, is not found),
 * finds the change there and sends the web card's request through the same
 * Settings route as that user (`./gateway.ts`), guarded by the version the card
 * names. The pressed message shows what happened, or why nothing did; a
 * failure offers the buttons again. While the press's link no longer reaches
 * its chat with Telegram access allowed, nothing is done; when it stops
 * reaching it only after the request returned, the change stands unannounced.
 * A button counts as used when pressed, before its request goes out, so a
 * restart between the two leaves the decision to the web card (accepted:
 * nothing is ever done twice). Change messages follow even an answer that
 * failed to reach Telegram: the change happened, and its Undo is the user's.
 */

export const TELEGRAM_CHANGE_CALLBACK_KINDS = ["change_undo", "change_confirm", "change_cancel"] as const satisfies readonly TelegramCallbackKind[];
export type TelegramChangeCallbackKind = (typeof TELEGRAM_CHANGE_CALLBACK_KINDS)[number];

/** Every code this module logs besides Telegram's transport codes. */
export const TELEGRAM_CHANGE_LOG_CODES = ["telegram_change_action_failed", "telegram_change_notice_failed"] as const;

/** A web card offers Undo and Confirm for as long as the answer exists; a button lives as long as the store allows. */
export const TELEGRAM_CHANGE_BUTTON_TTL_MS = TELEGRAM_CALLBACK_MAX_TTL_MS;

export const TELEGRAM_CHANGE_COPY = {
  undo: "Undo",
  unavailable: "This change is no longer available."
} as const;

/** Characters a change message keeps for its details; card fields are bounded, this bounds their sum. */
const DETAILS_MAX_CHARS = 2_500;
/** Runs whose announced changes this process remembers. */
const MEMORY_LIMIT = 1_000;

const VERBS: Readonly<Record<TelegramChangeCallbackKind, TelegramChangeVerb>> = {
  change_cancel: "cancel", change_confirm: "confirm", change_undo: "undo"
};

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REF = /^[A-Za-z0-9_-]{43}$/u;

/** What a button's row names: the run, its AIQSA chat, the change's hash and, for Confirm and Cancel, their group. */
export type TelegramChangePayload = Readonly<{ change: string; chatId: string; runId: string }>;

type Press = Readonly<{ link: TelegramLinkRecord; messageId: number | null; payload: TelegramChangePayload; telegramChatId: number; verb: TelegramChangeVerb }>;

/** A settled answer as its owner reads it now: its chat and summary; null when it is not the user's or gone. */
export type TelegramChangeAnswerReader = (input: Readonly<{ runId: string; userId: string }>) =>
  Promise<Readonly<{ chatId: string; artifactSummary: ThreadArtifactSummary | null }> | null>;

export type TelegramChanges = Readonly<{
  listener: TelegramRunListener;
  callbacks: Readonly<Record<TelegramChangeCallbackKind, TelegramCallbackHandler>>;
  /** Resolves when no change message or press is in progress (tests and shutdown). */
  idle(): Promise<void>;
}>;

export type TelegramChangesDeps = Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  answer: TelegramChangeAnswerReader;
  gateway: TelegramChangeGateway;
  sessions: TelegramSessionProvider;
  /** A fresh group for the buttons of one decision. */
  newGroup?: () => string;
}>;

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

function decodePayload(value: Readonly<Record<string, unknown>>): TelegramChangePayload | null {
  const { change, chatId, runId } = value;
  if (typeof change !== "string" || !REF.test(change) || typeof chatId !== "string" || !ID.test(chatId) ||
    typeof runId !== "string" || !ID.test(runId)) return null;
  return { change, chatId, runId };
}

function remember<K, V>(memory: Map<K, V>, key: K, value: V): void {
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as K);
}

function newGroupId(): string {
  return randomBytes(12).toString("base64url");
}

/** One change as its message shows it: the heading, the name with its meta line, the details and the status. */
export function telegramChangeMessage(view: TelegramChangeView): TelegramInputRichMessage {
  let budget = DETAILS_MAX_CHARS;
  const details: string[] = [];
  for (const line of view.details) {
    if (line.length > budget) break;
    details.push(line);
    budget -= line.length;
  }
  const blocks: TelegramInputRichBlock[] = [
    { type: "paragraph", text: { type: "bold", text: view.heading } },
    { type: "paragraph", text: `“${view.name}”${view.meta ? ` · ${view.meta}` : ""}` },
    ...details.map((text) => ({ type: "paragraph" as const, text })),
    ...(view.status ? [{ type: "paragraph" as const, text: view.status }] : [])
  ];
  return { blocks };
}

/** Undo where the card has it, else Confirm and Cancel of a proposal (one group), else none. */
export function telegramChangeKeyboard(plan: TelegramChangePlan, payload: TelegramChangePayload, group: string): TelegramKeyboard | undefined {
  const button = (kind: TelegramChangeCallbackKind, text: string, grouped: boolean) => ({
    callback: { kind, payload: { ...payload, ...(grouped ? { [TELEGRAM_CALLBACK_GROUP_KEY]: group } : {}) }, ttlMs: TELEGRAM_CHANGE_BUTTON_TTL_MS },
    text
  });
  if (plan.undo) return [[button("change_undo", TELEGRAM_CHANGE_COPY.undo, false)]];
  if (plan.proposal) {
    return [[button("change_confirm", plan.proposal.confirmLabel, true), button("change_cancel", plan.proposal.keepLabel, true)]];
  }
  return undefined;
}

function unchanged(failure: TelegramFailure): boolean {
  return failure.kind === "telegram" && failure.errorCode === 400 && /not modified/iu.test(failure.description ?? "");
}

export function createTelegramChanges(deps: TelegramChangesDeps): TelegramChanges {
  const newGroup = deps.newGroup ?? newGroupId;
  /** Changes announced per run, so a second `delivered` of one run (recovery) sends none twice. */
  const announced = new Map<string, Set<string>>();
  /** One job at a time per change: its presses never interleave. */
  const chains = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();

  function enqueue(key: string, code: (typeof TELEGRAM_CHANGE_LOG_CODES)[number], job: () => Promise<void>): void {
    const run = (chains.get(key) ?? Promise.resolve()).then(() => runInBackground(job))
      .catch((error: unknown) => log({ code, error, outcome: "failed" }));
    chains.set(key, run);
    pending.add(run);
    void run.finally(() => {
      pending.delete(run);
      if (chains.get(key) === run) chains.delete(key);
    });
  }

  /** The bot and the link while the bound chat may still receive the message (D-04), or null (logged). */
  async function reach(binding: TelegramChatBinding, runId: string): Promise<Readonly<{ bot: TelegramBotSession; link: TelegramLinkRecord }> | null> {
    const reached = await reachTelegramChat(deps, binding);
    if (reached.ok) return reached;
    log({ code: reached.reasonCode, outcome: "skipped", runId });
    return null;
  }

  /** Asked again right before each Bot API dispatch, after pacing and 429 waits. */
  function authority(binding: TelegramChatBinding): () => Promise<boolean> {
    return async () => (await reachTelegramChat(deps, binding)).ok;
  }

  function pressed(press: Press): TelegramChatBinding {
    return { botId: press.link.botId, linkId: press.link.id, telegramChatId: press.telegramChatId, userId: press.link.userId };
  }

  async function announce(change: TelegramChange, context: TelegramRunEventContext): Promise<boolean> {
    const binding = { botId: context.bot.botId, linkId: context.linkId, telegramChatId: context.telegramChatId, userId: context.userId };
    const reached = await reach(binding, context.runId);
    if (!reached) return false;
    const plan = telegramChangePlan(change);
    const keyboard = telegramChangeKeyboard(plan, { change: telegramChangeRef(change), chatId: context.chatId, runId: context.runId }, newGroup());
    const delivery = await reached.bot.outbound.sendContent({
      authorize: authority(binding), chatId: context.telegramChatId, ...(keyboard ? { keyboard } : {}),
      messages: [telegramChangeMessage(plan.view)], owner: { chatId: context.chatId, linkId: context.linkId, userId: context.userId }
    });
    if (delivery.ok) return true;
    if (delivery.failure.kind !== "unreachable") {
      log({ code: "telegram_change_notice_failed", httpStatus: delivery.failure.status, outcome: "failed", runId: context.runId });
    }
    return false;
  }

  function offer(changes: readonly TelegramChange[], context: TelegramRunEventContext): void {
    const seen = announced.get(context.runId) ?? new Set<string>();
    remember(announced, context.runId, seen);
    const fresh = changes.filter((change) => !seen.has(telegramChangeKey(change)));
    if (fresh.length === 0) return;
    for (const change of fresh) seen.add(telegramChangeKey(change));
    // In the answer's order, one run's messages after one another.
    enqueue(`run:${context.runId}`, "telegram_change_notice_failed", async () => {
      for (const change of fresh) {
        if (!(await announce(change, context))) seen.delete(telegramChangeKey(change));
      }
    });
  }

  /** Edits the pressed message in place, rich first, then as plain text. */
  async function edit(bot: TelegramBotSession, press: Press, message: TelegramInputRichMessage,
    markup: TelegramInlineKeyboardMarkup | undefined): Promise<"edited" | "failed" | "unreachable"> {
    if (press.messageId === null) return "failed";
    const target = { chat_id: press.telegramChatId, message_id: press.messageId, ...(markup ? { reply_markup: markup } : {}) };
    const options = { authorize: authority(pressed(press)) };
    const rich = await bot.api.editMessageText({ ...target, rich_message: { ...message, skip_entity_detection: true } }, options);
    if (rich.ok || unchanged(rich)) return "edited";
    if (rich.kind === "unreachable") return "unreachable";
    if (rich.kind === "telegram" && rich.errorCode === 400) {
      const plain = await bot.api.editMessageText({ ...target, link_preview_options: { is_disabled: true },
        text: plainTelegramMessage(message).join("\n\n").slice(0, 4_096) }, options);
      if (plain.ok || unchanged(plain)) return "edited";
      if (plain.kind === "unreachable") return "unreachable";
      log({ code: telegramFailureCode(plain.kind, plain.errorCode), httpStatus: plain.status, outcome: "failed", runId: press.payload.runId });
      return "failed";
    }
    log({ code: telegramFailureCode(rich.kind, rich.errorCode), httpStatus: rich.status, outcome: "failed", runId: press.payload.runId });
    return "failed";
  }

  /** Shows the pressed change as it now is, with fresh buttons when it asks again; a new message when it cannot be edited. */
  async function show(press: Press, bot: TelegramBotSession, message: TelegramInputRichMessage, keyboard?: TelegramKeyboard): Promise<void> {
    const markup = keyboard ? await bot.outbound.replyMarkup({ keyboard, linkId: press.link.id }) : undefined;
    if (await edit(bot, press, message, markup) !== "failed") return;
    await bot.outbound.sendContent({
      authorize: authority(pressed(press)), chatId: press.telegramChatId, ...(keyboard ? { keyboard } : {}), messages: [message],
      owner: { chatId: press.payload.chatId, linkId: press.link.id, userId: press.link.userId }
    });
  }

  /** The change the button names, in the run's answer as the link's user reads it now; null when it is not there. */
  async function find(press: Press): Promise<TelegramChange | null> {
    const answer = await deps.answer({ runId: press.payload.runId, userId: press.link.userId });
    // The run is the user's own (the read is scoped to them) and of the chat the button was made for.
    if (!answer || answer.chatId !== press.payload.chatId) return null;
    return telegramAnswerChanges(answer.artifactSummary).find((change) => telegramChangeRef(change) === press.payload.change) ?? null;
  }

  async function act(press: Press, plan: TelegramChangePlan): Promise<TelegramChangeOutcome> {
    const action = press.verb === "undo" ? plan.undo : plan.proposal;
    if (!action) return { kind: "failed" };
    try {
      return await deps.gateway.act({ operation: action.operation, userId: press.link.userId });
    } catch (error) {
      // Nothing is known to have happened: the message offers the buttons again.
      log({ code: "telegram_change_action_failed", error, outcome: "failed", runId: press.payload.runId });
      return { kind: "failed" };
    }
  }

  async function decide(press: Press): Promise<void> {
    if (!(await reach(pressed(press), press.payload.runId))) return;
    let change: TelegramChange | null;
    try {
      change = await find(press);
    } catch (error) {
      log({ code: "telegram_change_action_failed", error, outcome: "failed", runId: press.payload.runId });
      change = null;
    }
    const plan = change ? telegramChangePlan(change) : null;
    const offered = plan && (press.verb === "undo" ? plan.undo !== null : plan.proposal !== null);
    const outcome: TelegramChangeOutcome = !plan || !offered || press.verb === "cancel" ? { kind: "done" } : await act(press, plan);
    // Checked again once the request returned, right before its outcome goes out.
    const reached = await reach(pressed(press), press.payload.runId);
    if (!reached) return;
    if (!plan || !offered) {
      await show(press, reached.bot, { blocks: [{ type: "paragraph", text: TELEGRAM_CHANGE_COPY.unavailable }] });
      return;
    }
    const result = telegramChangeResult(plan, press.verb, outcome);
    const keyboard = result.retry ? telegramChangeKeyboard(plan, press.payload, newGroup()) : undefined;
    await show(press, reached.bot, telegramChangeMessage(result.view), keyboard);
  }

  function handler(kind: TelegramChangeCallbackKind): TelegramCallbackHandler {
    return async (context) => {
      const payload = decodePayload(context.callback.payload);
      if (!payload) return { text: TELEGRAM_CHANGE_COPY.unavailable };
      // Answered at once; the message itself shows the outcome.
      enqueue(`change:${payload.runId}:${payload.change}`, "telegram_change_action_failed", () => decide({
        link: context.link, messageId: context.messageId, payload, telegramChatId: context.chatId, verb: VERBS[kind]
      }));
      return {};
    };
  }

  const listener: TelegramRunListener = (event, context) => {
    if (event.type !== "delivered") return;
    const changes = telegramAnswerChanges(event.artifactSummary);
    if (changes.length > 0) offer(changes, context);
  };

  return Object.freeze({
    callbacks: Object.freeze({
      change_cancel: handler("change_cancel"),
      change_confirm: handler("change_confirm"),
      change_undo: handler("change_undo")
    }),
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    listener
  });
}

/** Change messages and their buttons for every Telegram run of this process; returns the function that removes them. */
export function registerTelegramChanges(deps: Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  answer: TelegramChangeAnswerReader;
  gateway: TelegramChangeGateway;
  registry: Pick<TelegramHandlerRegistry, "registerCallback">;
  sessions: TelegramSessionProvider;
}>): () => void {
  const changes = createTelegramChanges({ access: deps.access, answer: deps.answer, gateway: deps.gateway, sessions: deps.sessions });
  const removers = [
    onTelegramRunEvent(changes.listener),
    ...TELEGRAM_CHANGE_CALLBACK_KINDS.map((kind) => deps.registry.registerCallback(kind, changes.callbacks[kind]))
  ];
  return () => {
    for (const remove of removers) remove();
  };
}

/** A gateway whose routes load on the first press, so the bot starts without the Settings stacks. */
export function lazyTelegramChangeGateway(load: () => Promise<TelegramChangeGateway>): TelegramChangeGateway {
  let loaded: Promise<TelegramChangeGateway> | null = null;
  return Object.freeze({
    async act(input) {
      loaded ??= load().catch((error: unknown) => {
        loaded = null;
        throw error;
      });
      return (await loaded).act(input);
    }
  } satisfies TelegramChangeGateway);
}
