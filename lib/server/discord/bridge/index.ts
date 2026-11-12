import { randomUUID } from "node:crypto";
import { RUN_FOLLOWUP_MAX_CHARS } from "../../../contracts/runFollowups";
import type { ContentBlock } from "../../../domain/content";
import { recoverConnectorDeliveries, type ConnectorRecoveryLink } from "../../connectors/recovery";
import {
  CONNECTOR_RUN_FOLLOW_MS, createConnectorRunWait, followConnectorSend, type ConnectorSendFollowed, type ConnectorSendRefusal
} from "../../connectors/runAdmission";
import type { ConnectorRunStreamEvent } from "../../connectors/runEvents";
import type { ConnectorRunAnswer, ConnectorRunGateway } from "../../connectors/runGateway";
import { followConnectorRunEvents } from "../../connectors/runObserver";
import { RUN_STREAM_IDLE_MS } from "../../connectors/sse";
import { logEvent, runInBackground } from "../../observability";
import { discordChannelInfo, discordChannelKind, type DiscordChannelInfo } from "../access";
import { isDiscordBotActive, type DiscordActiveControl, type DiscordEffectiveControl } from "../control/state";
import {
  DISCORD_COPY, discordAuthorDailyLimitText, discordAuthorLimitText, discordFailureStatus, discordQuestionFallbackThreadName,
  discordThreadLimitText
} from "../copy";
import {
  decodeDiscordIntakeMessage, DISCORD_STALE_MESSAGE_MS, type DiscordHandlerRegistry, type DiscordIntakeMessage, type DiscordLanes,
  type DiscordMessageContext, type DiscordMessageHandler, type DiscordOverflowHandler
} from "../intake";
import { redactOutgoing } from "../redaction";
import { discordStableNonce, type DiscordRest } from "../rest";
import type { DiscordConversationKind, DiscordConversationRecord, DiscordConversationStore } from "../store/conversations";
import { discordLimitExceeded, type DiscordLimitStore } from "../store/limits";
import type { DiscordReplyKind, DiscordReplyPatch, DiscordReplyRecord, DiscordReplyState, DiscordReplyStore } from "../store/replies";
import { composeDiscordAnswer, discordNoAnswerFiles, type DiscordAnswerFilesHook } from "./answer";
import {
  createDiscordNames, DISCORD_MERGE_WINDOW_MS, discordAttachmentNamesOnly, discordConversationHeader, readDiscordTurnContext,
  type DiscordAttachmentHook, type DiscordContextScope
} from "./context";
import { publishDiscordRunEvent, type DiscordRunEvent, type DiscordRunEventContext } from "./events";
import {
  discordEventIds, logDiscordBridgeFailure, logDiscordRequestStage, logDiscordRunSummary, type DiscordQuestionIds, type DiscordRequestStage
} from "./journal";
import { compareDiscordIds, decodeDiscordContextMessage, type DiscordContextMessage, type DiscordMentionNames } from "./messages";
import { discordRunFailure, discordSendRefusalFailure, type DiscordFailure } from "./refusals";
import type { DiscordRunFacts } from "./runFacts";
import {
  createDiscordStatusMessage, discordActivityLabel, discordReact, DISCORD_REACTION_DONE, DISCORD_REACTION_FAILED, DISCORD_REACTION_SEEN,
  DISCORD_STATUS_EDIT_INTERVAL_MS, DISCORD_TYPING_INTERVAL_MS, type DiscordFinalMessage, type DiscordStatusMessage
} from "./status";
import { discordTrigger } from "./triggers";
import type { DiscordUploads } from "./uploads";

/**
 * Discord messages become runs of the installation's service account, one
 * AIQSA chat per Discord conversation (PRD O-04…O-07, O-13…O-19, O-26, D-11,
 * D-13…D-22, D-25, D-26, D-28):
 *
 * - A message that asks the bot (`triggers.ts`) is claimed first: its
 *   `DiscordReply` row keeps it to one answer however often Discord delivers
 *   it; a repeat stops there.
 * - Author and conversation limits refuse with a short text at most once an
 *   hour per author or conversation, then with ❌ only.
 * - A mention in a channel opens a thread from the message and answers there;
 *   where no thread can be opened (a voice-channel chat, a refusal) it answers
 *   in place, the conversation keyed by the channel.
 * - The context is read from Discord at the question (`context.ts`), admitted
 *   through the shared run gateway as a new Assistant chat excluded from
 *   Memory, without Workspace, or as the conversation's next turn on its
 *   expected leaf.
 * - While a run of the conversation goes on, a question joins it as a
 *   follow-up; one the run no longer takes waits for it and becomes the next
 *   turn. Conversations run side by side; one conversation stays in order.
 * - The status message is edited into the answer (`status.ts`, `answer.ts`);
 *   a cut answer links a read-only share of its chat.
 * - Deliveries a restart interrupted are found by their rows: settled runs are
 *   delivered once, a claimed question without a run is asked again, and one
 *   older than a day ends with ❌.
 *
 * Every stage writes its journal field and a content-free record (`journal.ts`).
 */

export type DiscordShareLinks = Readonly<{
  /** A read-only share of the chat at this answer, made as the service account; an absolute URL, or null. */
  create(input: Readonly<{ userId: string; chatId: string; assistantMessageId: string }>): Promise<string | null>;
}>;

export type DiscordBridgeTiming = Readonly<{
  mergeWindowMs: number;
  statusIntervalMs: number;
  typingIntervalMs: number;
  /** How long a run that streams nothing here is followed. */
  followMs: number;
  idleMs: number;
  /** A claimed question without a run is left this long to the process that claimed it before it is asked again. */
  claimGraceMs: number;
  /** How often the rows a restart left are swept. */
  recoveryIntervalMs: number;
}>;

export const DISCORD_BRIDGE_TIMING: DiscordBridgeTiming = Object.freeze({
  claimGraceMs: 2 * 60_000,
  followMs: CONNECTOR_RUN_FOLLOW_MS,
  idleMs: RUN_STREAM_IDLE_MS,
  mergeWindowMs: DISCORD_MERGE_WINDOW_MS,
  recoveryIntervalMs: 60_000,
  statusIntervalMs: DISCORD_STATUS_EDIT_INTERVAL_MS,
  typingIntervalMs: DISCORD_TYPING_INTERVAL_MS
});

export type DiscordBridgeDeps = Readonly<{
  control(): Promise<DiscordEffectiveControl>;
  /** Whether every blocking setup item passes (`controlService.health().setupReady`). */
  setupReady(): Promise<boolean>;
  rest(): DiscordRest;
  replies: DiscordReplyStore;
  conversations: DiscordConversationStore;
  limits: DiscordLimitStore;
  gateway: ConnectorRunGateway;
  facts: DiscordRunFacts;
  shares: DiscordShareLinks;
  /** Intake's lanes: a run in a thread this bridge opened holds the thread's slot, so its follow-ups run at once. */
  lanes?: Pick<DiscordLanes, "hold">;
  /** Uploads for a long history's `discord-history.md`; null cuts it instead. */
  uploads?: DiscordUploads | null;
  attachments?: DiscordAttachmentHook;
  answerFiles?: DiscordAnswerFilesHook;
  publish?: (event: DiscordRunEvent, context: DiscordRunEventContext) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newChatId?: () => string;
  timing?: Partial<DiscordBridgeTiming>;
}>;

export type DiscordBridge = Readonly<{
  handleMessage: DiscordMessageHandler;
  handleOverflow: DiscordOverflowHandler;
  /** Registers both handlers; returns the function that removes them. */
  register(registry: DiscordHandlerRegistry): () => void;
  /** One recovery sweep (at most one at a time). */
  recover(startedAt: Date): Promise<void>;
  /** Sweeps now and then on the recovery interval; returns the function that stops it. */
  startRecovery(startedAt: Date): () => void;
  /** Whether this process follows the run. */
  isLive(runId: string): boolean;
  /** Resolves once no question is handled, no answer delivered and no sweep runs here; runs still going are not waited for (tests). */
  idle(): Promise<void>;
}>;

type Question = {
  readonly ids: DiscordQuestionIds;
  readonly receivedAt: Date;
  /** The conversation's thread, when it is one. */
  threadId: string | null;
  runId: string | null;
  chatId: string | null;
  kind: DiscordReplyKind;
  redactions: number;
};

type ActiveRun = {
  readonly runId: string;
  readonly chatId: string;
  readonly assistantMessageId: string | null;
  readonly conversation: DiscordConversationRecord;
  /** The newest Discord message the run's context includes (follow-ups included). */
  includedUpTo: string;
  /** The run settled: it takes no follow-up any more. */
  answered: boolean;
  /** Its final message was handled. */
  done: boolean;
  outcome: "complete" | "cancelled" | "error" | null;
  readonly settled: Promise<void>;
  readonly followUps: Question[];
};

type Placement = {
  answerChannelId: string;
  replyTo: string | null;
  conversation: DiscordConversationRecord | null;
  /** The conversation to create once the run's chat exists. */
  create: Readonly<{
    discordChannelId: string; kind: DiscordConversationKind; guildId: string | null; parentChannelId: string | null; botOpened: boolean;
  }> | null;
  scope: DiscordContextScope;
  kind: DiscordConversationKind;
  parentChannelId: string | null;
};

type RecoveryLink = ConnectorRecoveryLink & Readonly<{ rows: readonly DiscordReplyRecord[] }>;

const MERGED_MAX = 4_096;
const THREAD_NAME_MAX = 80;
const SETTLED_STATES: Readonly<Record<"complete" | "cancelled" | "error", DiscordReplyState>> = {
  cancelled: "interrupted", complete: "delivered", error: "failed"
};
/** A question whose journal write of its run failed is still `claimed`: its answer goes out all the same. */
const DELIVERABLE_STATES: readonly DiscordReplyState[] = ["admitted", "claimed"];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function authorName(author: DiscordIntakeMessage["author"]): string {
  return author.nick ?? author.globalName ?? author.username ?? "Discord user";
}

/** A thread name from the question: mentions and markup out, secrets redacted, at most 80 characters. */
export function discordThreadName(text: string, author: string): Readonly<{ name: string; redactions: number }> {
  const plain = text.replace(/<@[!&]?[0-9]{1,20}>|<#[0-9]{1,20}>|<a?:[A-Za-z0-9_]{1,32}:[0-9]{1,20}>|<t:[^>]{1,40}>/gu, " ")
    .replace(/@(?:everyone|here)/giu, " ").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const redacted = redactOutgoing(plain);
  const name = redacted.text.length > THREAD_NAME_MAX ? `${redacted.text.slice(0, THREAD_NAME_MAX - 1).trimEnd()}…` : redacted.text;
  return { name: name.trim() || discordQuestionFallbackThreadName(author), redactions: redacted.count };
}

/** The send body of a Discord turn (PRD D-17): the Assistant's rows govern, Memory excluded, no Workspace, UTC. */
export function discordSendBody(input: Readonly<{
  admissionId: string;
  blocks: readonly ContentBlock[];
  expectedActiveLeafId: string | null;
  /** A new chat with this Assistant; null for the conversation's next turn. */
  newChatAssistantId: string | null;
}>): Record<string, unknown> {
  return {
    admissionId: input.admissionId,
    content: { blocks: input.blocks.map((block) => ({ ...block })) },
    expectedActiveLeafId: input.expectedActiveLeafId,
    ...(input.newChatAssistantId
      ? { assistantId: input.newChatAssistantId, personalDraft: { folderId: null, memoryMode: "EXCLUDED" } }
      : {}),
    timeZone: "UTC",
    workspace: { enabled: false }
  };
}

export function createDiscordBridge(deps: DiscordBridgeDeps): DiscordBridge {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const timing: DiscordBridgeTiming = { ...DISCORD_BRIDGE_TIMING, ...deps.timing };
  const newChatId = deps.newChatId ?? randomUUID;
  const attachments = deps.attachments ?? discordAttachmentNamesOnly;
  const answerFiles = deps.answerFiles ?? discordNoAnswerFiles;
  const publish = deps.publish ?? publishDiscordRunEvent;
  const names = createDiscordNames({ now, rest: deps.rest });
  const waitForRun = createConnectorRunWait(deps.gateway, { now, sleep });

  /** Conversation channel id → the run that answers there now. */
  const active = new Map<string, ActiveRun>();
  /** A message joined to an answer's question → that answer's run (bounded, kept after it settled). */
  const merged = new Map<string, ActiveRun>();
  const following = new Set<string>();
  const inFlight = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  const work = new Set<Promise<unknown>>();
  let sweeping: Promise<void> | null = null;

  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise);
    void promise.finally(() => work.delete(promise)).catch(() => undefined);
    return promise;
  }

  function serialized(key: string, job: () => Promise<void>): Promise<void> {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    const settled = next.catch(() => undefined);
    chains.set(key, settled);
    void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
    return next;
  }

  function eventIds(question: Question) {
    return discordEventIds(question.ids, { chatId: question.chatId, runId: question.runId, threadId: question.threadId });
  }

  function stage(question: Question, name: DiscordRequestStage, extra: Readonly<{
    kind?: DiscordReplyKind; code?: string | null; limitKind?: DiscordReplyRecord["limitKind"]; redactions?: number;
  }> = {}): void {
    logDiscordRequestStage(eventIds(question), name, { at: now(), receivedAt: question.receivedAt, ...extra });
  }

  /** Journal writes never hold up or fail an answer (answer first). */
  async function patch(question: Question, changes: DiscordReplyPatch, whenState?: readonly DiscordReplyState[]): Promise<boolean> {
    try {
      return await deps.replies.update(question.ids.questionMessageId, changes, whenState);
    } catch (error) {
      logDiscordBridgeFailure({ code: "discord_journal_failed", error, stage: "write" });
      return false;
    }
  }

  function mentionNames(control: DiscordActiveControl): DiscordMentionNames {
    return { botName: control.bot.username, botRoleId: control.bot.roleId, botUserId: control.bot.userId };
  }

  function questionOf(message: DiscordIntakeMessage, input: Readonly<{ receivedAt: Date; test: boolean }>): Question {
    return {
      chatId: null,
      ids: { channelId: message.channelId, discordUserId: message.author.id, guildId: message.guildId, questionMessageId: message.id, test: input.test },
      kind: "refused", receivedAt: input.receivedAt, redactions: 0, runId: null, threadId: null
    };
  }

  function questionOfRow(row: DiscordReplyRecord): Question {
    return {
      chatId: null,
      ids: { channelId: row.channelId, discordUserId: row.discordUserId, guildId: row.guildId, questionMessageId: row.questionMessageId, test: row.test },
      kind: row.kind, receivedAt: row.receivedAt, redactions: 0, runId: row.runId, threadId: null
    };
  }

  // -------------------------------------------------------------------------
  // Refusals

  /** ❌ on the question and, when it has one and it may go out, the short reason as a Reply. */
  async function refuse(question: Question, failure: DiscordFailure, options: Readonly<{
    notice?: boolean; status?: DiscordStatusMessage | null;
  }> = {}): Promise<void> {
    options.status?.stop();
    const rest = deps.rest();
    let noticeId: string | null = null;
    if (failure.text && options.notice !== false) {
      const created = await rest.createMessage(question.ids.channelId, {
        content: discordFailureStatus(failure.text), replyTo: question.ids.questionMessageId
      }, { nonce: discordStableNonce(question.ids.questionMessageId, "r") });
      if (created.ok) noticeId = created.value.id;
    }
    await discordReact(rest, {
      add: [DISCORD_REACTION_FAILED], channelId: question.ids.channelId, messageId: question.ids.questionMessageId, remove: [DISCORD_REACTION_SEEN]
    });
    await patch(question, {
      answerMessageId: noticeId, code: failure.code, failureKind: failure.failureKind, limitKind: failure.limitKind ?? null, state: "failed",
      statusMessageId: noticeId
    }, ["claimed"]);
    stage(question, failure.limitKind ? "limited" : "failed", {
      code: failure.code, kind: "refused", limitKind: failure.limitKind ?? null, redactions: question.redactions
    });
  }

  async function refuseLimit(question: Question, control: DiscordActiveControl, conversationId: string | null): Promise<boolean> {
    const at = new Date(now());
    const usage = await deps.limits.usage({ conversationId, discordUserId: question.ids.discordUserId, limits: control.limits, now: at });
    const exceeded = discordLimitExceeded(usage);
    if (!exceeded) return false;
    const minutes = exceeded.freesAt ? Math.ceil((exceeded.freesAt.getTime() - at.getTime()) / 60_000) : 60;
    const text = exceeded.kind === "thread" ? discordThreadLimitText(exceeded.limit, minutes)
      : exceeded.window === "day" ? discordAuthorDailyLimitText(exceeded.limit) : discordAuthorLimitText(exceeded.limit, minutes);
    const sent = await deps.limits.noticeSent({
      kind: exceeded.kind, now: at, ...(exceeded.kind === "author" ? { discordUserId: question.ids.discordUserId } : { conversationId: conversationId ?? undefined })
    }).catch(() => true);
    await refuse(question, {
      code: exceeded.kind === "author" ? "discord_user_limit" : "discord_thread_limit", failureKind: "limit", limitKind: exceeded.kind, text
    }, { notice: !sent });
    return true;
  }

  // -------------------------------------------------------------------------
  // Follow-ups

  /** The question is part of the running answer: 👀 now, the run's ending later. */
  async function join(question: Question, run: ActiveRun): Promise<void> {
    question.runId = run.runId;
    question.chatId = run.chatId;
    question.threadId = run.conversation.kind === "thread" || run.conversation.kind === "forum_post" ? run.conversation.discordChannelId : null;
    question.kind = "follow_up";
    await patch(question, {
      admittedAt: new Date(now()), conversationId: run.conversation.id, kind: "follow_up", runId: run.runId, state: "admitted"
    }, ["claimed"]);
    stage(question, "admitted", { kind: "follow_up" });
    if (run.done) await settleFollowUps([question], run.outcome ?? "error", null);
    else run.followUps.push(question);
  }

  /** Adds the question to the running answer; false when the run no longer takes it and it must be the next turn. */
  async function followUp(question: Question, run: ActiveRun, control: DiscordActiveControl, trigger: DiscordContextMessage): Promise<boolean> {
    if (compareDiscordIds(question.ids.questionMessageId, run.includedUpTo) <= 0) {
      await join(question, run);
      return true;
    }
    if (!run.assistantMessageId || !control.serviceUserId) return false;
    const turn = await readDiscordTurnContext({
      attachments: discordAttachmentNamesOnly, conversationId: run.conversation.id, facts: deps.facts, header: null,
      maxChars: RUN_FOLLOWUP_MAX_CHARS, mergeWindowMs: timing.mergeWindowMs, names: mentionNames(control), rest: deps.rest(),
      scope: { afterId: run.includedUpTo, bounded: false, channelId: run.conversation.discordChannelId, kind: "delta" },
      trigger, uploads: null, userId: control.serviceUserId
    });
    if (!turn.ok || run.answered) return false;
    const input = {
      assistantMessageId: run.assistantMessageId, chatId: run.chatId, nonce: `dc-${question.ids.questionMessageId}`, runId: run.runId,
      text: turn.text, userId: control.serviceUserId
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await deps.gateway.followup(input);
      if (response.ok) {
        if (compareDiscordIds(turn.includedUpTo, run.includedUpTo) > 0) run.includedUpTo = turn.includedUpTo;
        for (const id of turn.mergedIds) remember(id, run);
        await deps.conversations.touch({ at: new Date(now()), id: run.conversation.id, lastIncludedMessageId: run.includedUpTo })
          .catch((error: unknown) => logDiscordBridgeFailure({ code: "discord_journal_failed", error, stage: "write" }));
        await join(question, run);
        return true;
      }
      // An unconfirmed acceptance is asked about once more under the same nonce; a refusal is final.
      if (response.status !== 503) break;
    }
    logDiscordBridgeFailure({ code: "discord_followup_refused", outcome: "skipped", runId: run.runId });
    return false;
  }

  function remember(messageId: string, run: ActiveRun): void {
    merged.set(messageId, run);
    while (merged.size > MERGED_MAX) merged.delete(merged.keys().next().value as string);
  }

  // -------------------------------------------------------------------------
  // Placement: where the answer goes and what the context reads

  async function threadFrom(context: DiscordMessageContext, question: Question): Promise<string | null> {
    const rest = deps.rest();
    const named = discordThreadName(context.message.content, authorName(context.message.author));
    question.redactions += named.redactions;
    const started = await rest.startThreadFromMessage(context.message.channelId, context.message.id, { autoArchiveMinutes: 1440, name: named.name });
    if (started.ok) return started.value.id;
    // An ambiguous outcome, or Discord saying the message has its thread already: the thread may be there.
    if (started.delivery === "unknown" || started.discordCode === 160004) {
      const probe = await rest.getChannel(context.message.id);
      if (probe.ok) return probe.value.id;
    }
    logDiscordBridgeFailure({ code: "discord_thread_failed", outcome: "degraded" });
    return null;
  }

  async function place(context: DiscordMessageContext, question: Question, conversation: DiscordConversationRecord | null): Promise<Placement> {
    const { channel, message } = context;
    const guildId = message.guildId;
    if (conversation) {
      const answerChannelId = conversation.discordChannelId;
      const bounded = conversation.kind === "dm" || conversation.kind === "voice_chat" || conversation.kind === "channel";
      return {
        answerChannelId, conversation, create: null, kind: conversation.kind, parentChannelId: conversation.parentChannelId,
        replyTo: message.channelId === answerChannelId ? message.id : null,
        scope: conversation.lastIncludedMessageId
          ? { afterId: conversation.lastIncludedMessageId, bounded, channelId: answerChannelId, kind: "delta" }
          : { channelId: answerChannelId, kind: "channel_window" }
      };
    }
    const inPlace = (kind: DiscordConversationKind): Placement => ({
      answerChannelId: message.channelId, conversation: null, kind, parentChannelId: channel.parentId,
      create: { botOpened: false, discordChannelId: message.channelId, guildId, kind, parentChannelId: kind === "dm" ? null : channel.parentId },
      replyTo: message.id, scope: { channelId: message.channelId, kind: "channel_window" }
    });
    switch (context.kind) {
      case "dm": return inPlace("dm");
      case "voice": return inPlace("voice_chat");
      case "thread":
      case "forum_post": {
        const kind = context.kind;
        return {
          answerChannelId: message.channelId, conversation: null, kind, parentChannelId: channel.parentId,
          create: { botOpened: false, discordChannelId: message.channelId, guildId, kind, parentChannelId: channel.parentId },
          replyTo: message.id,
          scope: { kind: "thread_start", starterChannelId: kind === "thread" ? channel.parentId : null, threadId: message.channelId }
        };
      }
      case "text":
      case "announcement": {
        const threadId = await threadFrom(context, question);
        if (!threadId) return inPlace("channel");
        return {
          answerChannelId: threadId, conversation: null, kind: "thread", parentChannelId: message.channelId,
          create: { botOpened: true, discordChannelId: threadId, guildId, kind: "thread", parentChannelId: message.channelId },
          replyTo: null, scope: { channelId: message.channelId, kind: "channel_window" }
        };
      }
      default: return inPlace("channel");
    }
  }

  async function header(placement: Placement, trigger: DiscordContextMessage, guildId: string | null): Promise<string> {
    const [channelName, parentName, guildName] = await Promise.all([
      placement.kind === "dm" ? Promise.resolve(null) : names.channel(placement.answerChannelId).catch(() => null),
      placement.parentChannelId && placement.kind !== "dm" ? names.channel(placement.parentChannelId).catch(() => null) : Promise.resolve(null),
      guildId ? names.guild(guildId).catch(() => null) : Promise.resolve(null)
    ]);
    return discordConversationHeader({ channelName, guildName, kind: placement.kind, parentName, partner: trigger });
  }

  // -------------------------------------------------------------------------
  // Admission

  type Admitted = Extract<ConnectorSendFollowed, { kind: "admitted" }> & Readonly<{ chatId: string }>;

  async function recordRun(question: Question, placement: Placement, input: Readonly<{
    runId: string; chatId: string; userId: string; includedUpTo: string;
  }>): Promise<boolean> {
    question.runId = input.runId;
    question.chatId = input.chatId;
    if (!placement.conversation && placement.create) {
      try {
        const created = await deps.conversations.create({
          ...placement.create, chatId: input.chatId, lastIncludedMessageId: input.includedUpTo, now: new Date(now()), userId: input.userId
        });
        placement.conversation = created.record;
      } catch (error) {
        logDiscordBridgeFailure({ code: "discord_journal_failed", error, runId: input.runId, stage: "write" });
      }
    }
    // Written the moment the run is known, so whatever the run does next can tell it came from Discord.
    return patch(question, {
      admittedAt: new Date(now()), conversationId: placement.conversation?.id ?? null, kind: "answer", runId: input.runId, state: "admitted"
    }, ["claimed"]);
  }

  async function admit(question: Question, placement: Placement, input: Readonly<{
    userId: string; assistantId: string; blocks: readonly ContentBlock[]; includedUpTo: string; recoveredLeaf: string | null | undefined;
  }>): Promise<Admitted | Readonly<{ kind: "refused"; refusal: ConnectorSendRefusal }>> {
    const conversation = placement.conversation;
    const chatId = conversation?.chatId ?? newChatId();
    for (let attempt = 0; ; attempt += 1) {
      let expected: string | null = null;
      if (conversation) {
        const chat = await deps.gateway.chat(input.userId, chatId);
        if (!chat) return { kind: "refused", refusal: { code: "chat_not_found", status: 404 } };
        expected = attempt === 0 && input.recoveredLeaf !== undefined && input.recoveredLeaf !== null ? input.recoveredLeaf : chat.activeLeafMessageId;
      }
      await patch(question, { expectedLeafId: expected });
      const response = await deps.gateway.send({
        body: discordSendBody({
          admissionId: `dc-${question.ids.questionMessageId}`, blocks: input.blocks, expectedActiveLeafId: expected,
          newChatAssistantId: conversation ? null : input.assistantId
        }),
        chatId, userId: input.userId
      });
      const followed = await followConnectorSend(response, {
        followMs: timing.followMs, idleMs: timing.idleMs, now,
        recordRun: (runId) => recordRun(question, placement, { chatId, includedUpTo: input.includedUpTo, runId, userId: input.userId }),
        userId: input.userId, waitForRun
      });
      if (followed.kind === "admitted") return { ...followed, chatId };
      // Someone else's turn moved the chat on meanwhile: read the new leaf and try once more; a recovered question's
      // own first attempt that arrived reads the same way, and is found instead (`readmit`).
      if (followed.refusal.code === "active_leaf_changed" && conversation && attempt === 0 && input.recoveredLeaf === undefined) continue;
      return followed;
    }
  }

  /** A run that streams nothing here, followed through its state until it settles. */
  async function* polled(runId: string, userId: string): AsyncGenerator<ConnectorRunStreamEvent> {
    const settled = await waitForRun({ deadline: now() + timing.followMs, runId, userId });
    if (settled === "complete" || settled === "cancelled") yield { status: settled, type: "done" };
    else if (settled) yield { code: settled === "gone" ? "model_run_not_found" : null, message: null, type: "failed" };
  }

  /** A question for a run already holding its chat (`active_run_in_progress`): joined to it as a follow-up when it takes one. */
  async function adopt(question: Question, placement: Placement, runId: string, text: string, userId: string): Promise<boolean> {
    const conversation = placement.conversation;
    if (!conversation) return false;
    const answer = await deps.gateway.answer({ runId, userId }).catch(() => null);
    if (!answer || answer.status !== "streaming") return false;
    const response = await deps.gateway.followup({
      assistantMessageId: answer.assistantMessageId, chatId: answer.chatId, nonce: `dc-${question.ids.questionMessageId}`, runId,
      text: text.length > RUN_FOLLOWUP_MAX_CHARS ? text.slice(text.length - RUN_FOLLOWUP_MAX_CHARS) : text, userId
    });
    if (!response.ok) return false;
    question.runId = runId;
    question.chatId = answer.chatId;
    question.kind = "follow_up";
    // Another process (or one before a restart) follows that run; recovery ends this question with it.
    await patch(question, { admittedAt: new Date(now()), conversationId: conversation.id, kind: "follow_up", runId, state: "admitted" }, ["claimed"]);
    stage(question, "admitted", { kind: "follow_up" });
    return true;
  }

  // -------------------------------------------------------------------------
  // The question's whole way

  async function answerQuestion(context: DiscordMessageContext, question: Question, existing: DiscordConversationRecord | null,
    recovered?: Readonly<{ expectedLeafId: string | null }>): Promise<void> {
    const { control, message } = context;
    const rest = deps.rest();
    if (await discordReact(rest, { add: [DISCORD_REACTION_SEEN], channelId: message.channelId, messageId: message.id })) {
      await patch(question, { ackAt: new Date(now()) });
      stage(question, "acked");
    }
    const joined = merged.get(message.id);
    if (joined) return join(question, joined);
    const serviceUserId = control.serviceUserId;
    if (!serviceUserId) {
      return refuse(question, { code: "discord_service_account_missing", failureKind: "setup", text: DISCORD_COPY.notSetUp });
    }
    if (!control.assistantId || !(await deps.setupReady().catch(() => false))) {
      return refuse(question, { code: "discord_setup_incomplete", failureKind: "setup", text: DISCORD_COPY.notSetUp });
    }
    const assistantId = control.assistantId;
    const trigger = decodeDiscordContextMessage(message.raw, mentionNames(control));
    if (!trigger) return refuse(question, { code: "discord_context_unavailable", failureKind: "context", text: DISCORD_COPY.contextUnavailable });
    // A channel mention opens a thread keyed by the message's own id; everything else is keyed by its channel.
    const opensThread = !existing && (context.kind === "text" || context.kind === "announcement");
    const key = existing?.discordChannelId ?? (opensThread ? message.id : message.channelId);

    await serialized(key, async () => {
      let conversation = existing ?? (opensThread ? null : await deps.conversations.findByChannel(key));
      const running = conversation ? active.get(conversation.discordChannelId) : undefined;
      if (running && !running.answered) {
        if (await refuseLimit(question, control, running.conversation.id)) return;
        if (await followUp(question, running, control, trigger)) return;
        // The run no longer takes it: it becomes the next turn once that run's answer is out.
        await running.settled;
        conversation = await deps.conversations.findByChannel(running.conversation.discordChannelId) ?? running.conversation;
      } else if (await refuseLimit(question, control, conversation?.id ?? null)) {
        return;
      }
      const placement = await place(context, question, conversation);
      question.threadId = placement.kind === "thread" || placement.kind === "forum_post" ? placement.answerChannelId : null;
      const status = createDiscordStatusMessage({
        answerChannelId: placement.answerChannelId, editIntervalMs: timing.statusIntervalMs, now,
        onPosted: (messageId, at) => {
          void patch(question, { firstStatusAt: new Date(at), statusMessageId: messageId });
          stage(question, "first_status");
        },
        questionMessageId: message.id, replyTo: placement.replyTo, rest: deps.rest, startedAt: now(), typingIntervalMs: timing.typingIntervalMs
      });
      status.startTyping();
      // The same author's next messages within the window join this question.
      const wait = message.createdAt.getTime() + timing.mergeWindowMs - now();
      if (wait > 0 && context.source === "live") await sleep(Math.min(wait, timing.mergeWindowMs));
      const turn = await readDiscordTurnContext({
        attachments, conversationId: placement.conversation?.id ?? null, facts: deps.facts,
        header: await header(placement, trigger, message.guildId), mergeWindowMs: timing.mergeWindowMs, names: mentionNames(control), rest,
        scope: placement.scope, trigger, uploads: deps.uploads ?? null, userId: serviceUserId
      });
      if (!turn.ok) return refuse(question, { code: turn.code, failureKind: "context", text: DISCORD_COPY.contextUnavailable }, { status });
      const admitted = await admit(question, placement, {
        assistantId, blocks: turn.blocks, includedUpTo: turn.includedUpTo, recoveredLeaf: recovered?.expectedLeafId, userId: serviceUserId
      });
      if (admitted.kind === "refused") {
        const { refusal } = admitted;
        if (refusal.code === "active_run_in_progress" && refusal.activeRunId &&
          await adopt(question, placement, refusal.activeRunId, turn.text, serviceUserId)) {
          status.stop();
          return;
        }
        if (refusal.code === "active_leaf_changed" && recovered && placement.conversation) {
          // A recovered question whose first attempt arrived: its run is the chat's active one, if it still runs.
          const found = await deps.gateway.activeRun({ chatId: placement.conversation.chatId, userId: serviceUserId }).catch(() => null);
          const owners = found ? await deps.facts.questionsOfRun(found.runId).catch(() => null) : null;
          if (found && owners?.length === 0) {
            await recordRun(question, placement, { chatId: placement.conversation.chatId, includedUpTo: turn.includedUpTo, runId: found.runId, userId: serviceUserId });
            start(context, question, placement, status, {
              assistantMessageId: null, chatId: placement.conversation.chatId, events: polled(found.runId, serviceUserId), runId: found.runId
            }, turn.includedUpTo, turn.mergedIds, serviceUserId);
            return;
          }
          return refuse(question, { code: "discord_delivery_unknown", failureKind: "delivery", text: DISCORD_COPY.somethingWrong }, { status });
        }
        logDiscordBridgeFailure({ code: "discord_run_refused", outcome: "skipped" });
        return refuse(question, discordSendRefusalFailure(refusal), { status });
      }
      if (placement.conversation && placement.conversation.lastIncludedMessageId !== turn.includedUpTo && !placement.create) {
        await deps.conversations.touch({ at: new Date(now()), id: placement.conversation.id, lastIncludedMessageId: turn.includedUpTo })
          .catch((error: unknown) => logDiscordBridgeFailure({ code: "discord_journal_failed", error, stage: "write" }));
      }
      stage(question, "admitted", { kind: "answer" });
      await status.post();
      start(context, question, placement, status, admitted, turn.includedUpTo, turn.mergedIds, serviceUserId);
    });
  }

  /** Follows the admitted run in the background; the lane's slot stays taken until its answer is out. */
  function start(context: DiscordMessageContext, question: Question, placement: Placement, status: DiscordStatusMessage,
    admitted: Readonly<{ runId: string; chatId: string; assistantMessageId: string | null; events: AsyncIterable<ConnectorRunStreamEvent> }>,
    includedUpTo: string, mergedIds: readonly string[], userId: string): void {
    const conversation = placement.conversation;
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    if (!conversation) {
      // The conversation row could not be written: the answer still goes out, without follow-ups.
      void observe();
      return;
    }
    const run: ActiveRun = {
      answered: false, assistantMessageId: admitted.assistantMessageId, chatId: admitted.chatId, conversation, done: false, followUps: [],
      includedUpTo, outcome: null, runId: admitted.runId, settled
    };
    active.set(conversation.discordChannelId, run);
    for (const id of mergedIds) remember(id, run);
    if (placement.answerChannelId !== context.message.channelId && deps.lanes) deps.lanes.hold(placement.answerChannelId, settled);
    else context.hold(settled);
    void observe(run).finally(() => {
      if (active.get(conversation.discordChannelId) === run) active.delete(conversation.discordChannelId);
      // Joined messages stay known (bounded): one whose handler comes after the answer still gets that answer's ending.
      settle();
    });

    async function observe(run?: ActiveRun): Promise<void> {
      following.add(admitted.runId);
      const eventContext = runContext(question, admitted.runId, admitted.chatId, userId, placement.answerChannelId, "live");
      let failedCode: string | null = null;
      try {
        const ended = await followConnectorRunEvents(admitted.events, {
          publish: async (event) => {
            status.setActivity(discordActivityLabel(event));
            if (event.type === "failed") failedCode = event.code;
            await publish(event, eventContext);
          }
        });
        if (run) run.answered = true;
        if (!ended) {
          // Followed past its bound: recovery delivers it once it settles.
          status.stop();
          logDiscordBridgeFailure({ code: "discord_delivery_unknown", outcome: "waiting", runId: admitted.runId, stage: "settle" });
          return;
        }
        await track(deliver({
          answerChannelId: placement.answerChannelId, failedCode, followUps: run?.followUps ?? [], question, run, runId: admitted.runId,
          source: "live", status, userId
        }));
      } catch (error) {
        status.stop();
        logDiscordBridgeFailure({ code: "discord_delivery_failed", error, runId: admitted.runId, stage: "settle" });
      } finally {
        following.delete(admitted.runId);
      }
    }
  }

  function runContext(question: Question, runId: string, chatId: string, userId: string, answerChannelId: string,
    source: "live" | "recovery"): DiscordRunEventContext {
    return {
      answerChannelId, chatId, discordUserId: question.ids.discordUserId, guildId: question.ids.guildId,
      questionChannelId: question.ids.channelId, questionMessageId: question.ids.questionMessageId, runId, source, test: question.ids.test, userId
    };
  }

  // -------------------------------------------------------------------------
  // Delivery

  async function settleFollowUps(followUps: readonly Question[], outcome: "complete" | "cancelled" | "error", code: string | null): Promise<void> {
    const rest = deps.rest();
    for (const question of followUps) {
      await discordReact(rest, {
        add: outcome === "complete" ? [DISCORD_REACTION_DONE] : outcome === "error" ? [DISCORD_REACTION_FAILED] : [],
        channelId: question.ids.channelId, messageId: question.ids.questionMessageId, remove: [DISCORD_REACTION_SEEN]
      });
      const at = new Date(now());
      await patch(question, {
        ...(outcome === "complete" ? { deliveredAt: at } : { code }), state: SETTLED_STATES[outcome]
      }, ["admitted"]);
      stage(question, outcome === "complete" ? "delivered" : outcome === "cancelled" ? "interrupted" : "failed", {
        kind: "follow_up", ...(outcome === "complete" ? {} : { code })
      });
    }
  }

  async function deliver(input: Readonly<{
    question: Question; runId: string; userId: string; status: DiscordStatusMessage; followUps: readonly Question[];
    answerChannelId: string; source: "live" | "recovery"; failedCode: string | null; run?: ActiveRun; answer?: ConnectorRunAnswer | null;
  }>): Promise<"delivered" | "failed" | "unknown" | "skipped"> {
    const { question, runId, status, userId } = input;
    // A question deleted meanwhile, or answered by another process, gets nothing more.
    const row = await deps.replies.find(question.ids.questionMessageId).catch(() => null);
    if (row && row.state !== "admitted" && row.state !== "claimed") {
      status.stop();
      return "skipped";
    }
    const answer = input.answer !== undefined ? input.answer : await deps.gateway.answer({ runId, userId }).catch(() => null);
    const summary = await deps.facts.summary(runId).catch((error: unknown) => {
      logDiscordBridgeFailure({ code: "discord_journal_failed", error, runId, stage: "settle" });
      return null;
    });
    question.chatId = answer?.chatId ?? question.chatId;
    let final: DiscordFinalMessage;
    let failure: DiscordFailure | null = null;
    let outcome: "complete" | "cancelled" | "error";
    let redactions = status.redactions();
    if (answer?.status === "complete") {
      const files = await answerFiles({ answer, chatId: answer.chatId, runId, test: question.ids.test, userId }).catch((error: unknown) => {
        logDiscordBridgeFailure({ code: "discord_delivery_failed", error, runId, stage: "settle" });
        return { files: [], note: null };
      });
      const composed = await composeDiscordAnswer({
        answer, files,
        share: () => deps.shares.create({ assistantMessageId: answer.assistantMessageId, chatId: answer.chatId, userId }).catch((error: unknown) => {
          logDiscordBridgeFailure({ code: "discord_share_failed", error, runId });
          return null;
        })
      });
      redactions += composed.redactions;
      final = composed;
      outcome = "complete";
    } else if (answer?.status === "cancelled") {
      failure = { code: "discord_stopped", failureKind: "stopped", text: DISCORD_COPY.stopped };
      final = { content: DISCORD_COPY.stopped };
      outcome = "cancelled";
    } else {
      failure = discordRunFailure(input.failedCode ?? summary?.errorCode ?? (answer ? null : "model_run_not_found"));
      final = { content: discordFailureStatus(failure.text ?? DISCORD_COPY.somethingWrong) };
      outcome = "error";
    }
    const sent = await status.finish(final);
    const rest = deps.rest();
    const totals = {
      compactions: summary?.compactions ?? 0, mcpByServer: summary?.mcpByServer ?? {}, sources: answer?.artifactSummary?.citations.length ?? 0,
      subagents: summary?.subagents ?? 0
    };
    const at = new Date(now());
    let result: "delivered" | "failed" | "unknown";
    if (sent.kind === "sent") {
      await discordReact(rest, {
        add: outcome === "complete" ? [DISCORD_REACTION_DONE] : outcome === "error" ? [DISCORD_REACTION_FAILED] : [],
        channelId: question.ids.channelId, messageId: question.ids.questionMessageId, remove: [DISCORD_REACTION_SEEN]
      });
      await patch(question, {
        answerMessageId: sent.messageId, code: failure?.code ?? null, compactions: totals.compactions,
        ...(outcome === "complete" ? { deliveredAt: at } : {}), failureKind: failure?.failureKind ?? null, limitKind: failure?.limitKind ?? null,
        mcpByServer: totals.mcpByServer, sources: totals.sources, state: SETTLED_STATES[outcome], statusMessageId: status.messageId() ?? sent.messageId,
        subagents: totals.subagents
      }, DELIVERABLE_STATES);
      if (failure?.limitKind) stage(question, "limited", { code: failure.code, kind: question.kind, limitKind: failure.limitKind });
      stage(question, outcome === "complete" ? "delivered" : outcome === "cancelled" ? "interrupted" : "failed", {
        kind: question.kind, redactions: redactions + question.redactions, ...(failure ? { code: failure.code } : {})
      });
      result = outcome === "complete" ? "delivered" : "failed";
    } else {
      const unknown = sent.failure.delivery === "unknown";
      const code = unknown ? "discord_delivery_unknown" : sent.failure.code;
      await patch(question, {
        code, compactions: totals.compactions, failureKind: "delivery", mcpByServer: totals.mcpByServer, sources: totals.sources,
        state: unknown ? "unknown" : "failed", subagents: totals.subagents
      }, DELIVERABLE_STATES);
      stage(question, "failed", { code, kind: question.kind, redactions: redactions + question.redactions });
      result = unknown ? "unknown" : "failed";
    }
    if (input.run) {
      input.run.done = true;
      input.run.outcome = outcome;
    }
    await settleFollowUps(input.followUps, sent.kind === "sent" ? outcome : "error", failure?.code ?? (sent.kind === "sent" ? null : "discord_delivery_failed"));
    logDiscordRunSummary(eventIds(question), totals);
    if (answer) {
      await publish({
        answerMessageId: sent.kind === "sent" ? sent.messageId : null, sent: sent.kind === "sent", status: outcome, type: "delivered",
        ...(answer.artifactSummary ? { artifactSummary: answer.artifactSummary } : {})
      }, runContext(question, runId, answer.chatId, userId, input.answerChannelId, input.source));
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Handlers

  async function claimed(context: DiscordMessageContext): Promise<Readonly<{
    question: Question; existing: DiscordConversationRecord | null;
  }> | "ignored" | "duplicate"> {
    const { control, message } = context;
    const triggerOf = (botOpenedThread: boolean) => discordTrigger({
      botOpenedThread, botRoleId: control.bot.roleId, botUserId: control.bot.userId, kind: context.kind, message
    });
    // Only a thread can be one AIQSA opened; elsewhere a message that asks nothing costs no read.
    let trigger = triggerOf(false);
    const thread = context.kind === "thread" || context.kind === "forum_post";
    const existing = trigger || thread ? await deps.conversations.findByChannel(message.channelId) : null;
    if (!trigger && existing?.botOpened) trigger = triggerOf(true);
    const ids = {
      author_id: message.author.id, channel_id: message.channelId, ...(message.guildId ? { guild_id: message.guildId } : {}), message_id: message.id,
      ...(context.test ? { test: true } : {})
    };
    if (!trigger) {
      // Only a thread the bot opened logs a skipped message (people talking to each other there); every other channel
      // message is ordinary conversation and would flood the logs.
      if (existing?.botOpened) logEvent("discord_intake", { ...ids, outcome: "ignored", reason: "no_trigger" });
      return "ignored";
    }
    const question = questionOf(message, { receivedAt: context.receivedAt, test: context.test });
    const claim = await deps.replies.claim({
      authorName: authorName(message.author), channelId: message.channelId, conversationId: existing?.id ?? null, discordUserId: message.author.id,
      guildId: message.guildId, kind: "refused", questionMessageId: message.id, receivedAt: context.receivedAt, test: context.test
    });
    if (claim === "duplicate") {
      logEvent("discord_intake", { ...ids, outcome: "duplicate", reason: "duplicate" });
      return "duplicate";
    }
    logEvent("discord_intake", { ...ids, outcome: "claimed" });
    stage(question, "received");
    return { existing, question };
  }

  const handleMessage: DiscordMessageHandler = async (context) => {
    const outcome = await claimed(context);
    if (outcome === "ignored") return false;
    if (outcome === "duplicate") return true;
    const { existing, question } = outcome;
    inFlight.add(question.ids.questionMessageId);
    const handling = track(answerQuestion(context, question, existing).catch(async (error: unknown) => {
      logDiscordBridgeFailure({ code: "discord_handler_failed", error });
      await refuse(question, { code: "discord_handler_failed", failureKind: "admission", text: DISCORD_COPY.somethingWrong }).catch(() => undefined);
    }).finally(() => inFlight.delete(question.ids.questionMessageId)));
    await handling;
    return true;
  };

  const handleOverflow: DiscordOverflowHandler = async (context) => {
    const outcome = await claimed(context);
    if (outcome === "ignored" || outcome === "duplicate") return;
    await refuse(outcome.question, { code: "discord_busy", failureKind: "busy", text: DISCORD_COPY.busy });
  };

  // -------------------------------------------------------------------------
  // Recovery

  /** Ends questions recovery can no longer answer: ❌ with "Something went wrong. Ask again." */
  async function expire(rows: readonly DiscordReplyRecord[], code: string, whenState: readonly DiscordReplyState[]): Promise<void> {
    const rest = deps.rest();
    for (const row of rows) {
      const question = questionOfRow(row);
      const content = discordFailureStatus(DISCORD_COPY.somethingWrong);
      let noticeId = row.statusMessageId;
      if (row.kind !== "follow_up") {
        // The status is in the question's channel, or in the thread AIQSA opened from it (which has the question's id).
        let edited = false;
        for (const channelId of noticeId ? [row.channelId, row.questionMessageId] : []) {
          if ((await rest.editMessage(channelId, noticeId!, { content })).ok) {
            edited = true;
            break;
          }
        }
        if (!edited) {
          const created = await rest.createMessage(row.channelId, { content, replyTo: row.questionMessageId },
            { nonce: discordStableNonce(row.questionMessageId, "r") });
          noticeId = created.ok ? created.value.id : noticeId;
        }
      }
      await discordReact(rest, { add: [DISCORD_REACTION_FAILED], channelId: row.channelId, messageId: row.questionMessageId, remove: [DISCORD_REACTION_SEEN] });
      await patch(question, { answerMessageId: noticeId, code, failureKind: "delivery", state: "failed", statusMessageId: noticeId }, whenState);
      stage(question, "failed", { code, kind: row.kind });
    }
  }

  /** Delivers a settled run of a question this process did not follow, once, with its follow-ups. */
  async function recoverRun(rows: readonly DiscordReplyRecord[], userId: string): Promise<"delivered" | "failed" | "unknown" | "skipped"> {
    const runId = rows[0]!.runId!;
    const main = rows.find((row) => row.kind === "answer");
    const followUps = rows.filter((row) => row !== main).map(questionOfRow);
    const answer = await deps.gateway.answer({ runId, userId }).catch(() => null);
    if (!main) {
      await settleFollowUps(followUps, answer?.status === "complete" ? "complete" : answer?.status === "cancelled" ? "cancelled" : "error",
        answer?.status === "complete" ? null : "run_failed");
      return "delivered";
    }
    const conversation = answer ? await deps.conversations.findByChat(answer.chatId).catch(() => null) : null;
    const answerChannelId = conversation?.discordChannelId ?? main.channelId;
    const question = questionOfRow(main);
    question.chatId = answer?.chatId ?? null;
    question.threadId = conversation && (conversation.kind === "thread" || conversation.kind === "forum_post") ? conversation.discordChannelId : null;
    const status = createDiscordStatusMessage({
      answerChannelId, existingMessageId: main.statusMessageId, now, questionMessageId: main.questionMessageId,
      replyTo: main.channelId === answerChannelId ? main.questionMessageId : null, rest: deps.rest,
      startedAt: (main.admittedAt ?? main.receivedAt).getTime()
    });
    return deliver({ answer, answerChannelId, failedCode: null, followUps, question, runId, source: "recovery", status, userId });
  }

  /** A claimed question without a run: asked again once, with the expected leaf its first attempt recorded. */
  async function readmit(row: DiscordReplyRecord, control: DiscordActiveControl): Promise<void> {
    if (inFlight.has(row.questionMessageId) || now() - row.receivedAt.getTime() < timing.claimGraceMs) return;
    if (now() - row.receivedAt.getTime() > DISCORD_STALE_MESSAGE_MS) {
      await expire([row], "discord_reply_expired", ["claimed"]);
      return;
    }
    const rest = deps.rest();
    const fetched = await rest.getChannelMessage(row.channelId, row.questionMessageId);
    if (!fetched.ok) {
      if (fetched.delivery === "refused" && fetched.status === 404) {
        await patch(questionOfRow(row), { code: "discord_question_deleted", state: "interrupted" }, ["claimed"]);
      }
      return;
    }
    const decoded = decodeDiscordIntakeMessage(fetched.value);
    const channelAnswer = await rest.getChannel(row.channelId);
    const channel: DiscordChannelInfo | null = channelAnswer.ok ? discordChannelInfo(channelAnswer.value, row.guildId) : null;
    if (!decoded || !channel) return;
    const parentAnswer = channel.parentId ? await rest.getChannel(channel.parentId) : null;
    const parent = parentAnswer?.ok ? discordChannelInfo(parentAnswer.value, row.guildId) : null;
    const context: DiscordMessageContext = {
      channel, control, hold: () => undefined, kind: discordChannelKind(channel, parent ?? undefined),
      message: { ...decoded, guildId: row.guildId }, parent, receivedAt: row.receivedAt, source: "backfill", test: row.test
    };
    const existing = await deps.conversations.findByChannel(row.channelId);
    const question = questionOfRow(row);
    inFlight.add(row.questionMessageId);
    try {
      await answerQuestion(context, question, existing, { expectedLeafId: row.expectedLeafId });
    } finally {
      inFlight.delete(row.questionMessageId);
    }
  }

  async function sweep(startedAt: Date): Promise<void> {
    const control = await deps.control();
    if (!isDiscordBotActive(control) || !control.serviceUserId) return;
    const userId = control.serviceUserId;
    const rows = await deps.replies.listUnsettled({ before: new Date(now()), limit: 500 });
    const byRun = new Map<string, DiscordReplyRecord[]>();
    const waiting: DiscordReplyRecord[] = [];
    for (const row of rows) {
      if (row.state === "admitted" && row.runId) {
        const group = byRun.get(row.runId) ?? [];
        group.push(row);
        byRun.set(row.runId, group);
      } else if (row.state === "claimed" && !row.runId) {
        waiting.push(row);
      }
    }
    await recoverConnectorDeliveries<RecoveryLink>({
      available: async () => isDiscordBotActive(await deps.control()),
      deliver: (link) => recoverRun(link.rows, link.userId),
      isLive: (runId) => following.has(runId),
      links: {
        // A delivery is never claimed apart from its row: editing the status into the answer is idempotent, and creates carry nonces.
        claimDelivery: async () => true,
        listByState: async ({ state }) => state === "claimed" ? [] : [...byRun].map(([runId, group]) => ({
          createdAt: new Date(Math.min(...group.map((row) => (row.admittedAt ?? row.receivedAt).getTime()))), rows: group, runId, userId
        })),
        settle: async ({ runId }) => expire(byRun.get(runId) ?? [], "discord_reply_expired", ["admitted"])
      },
      log: { deliveryFailed: "discord_delivery_failed", recoveryFailed: "discord_recovery_failed", subsystem: "discord", unknown: "discord_delivery_unknown" },
      now, waitForRun
    }, { startedAt });
    for (const row of waiting) {
      await readmit(row, control).catch((error: unknown) => logDiscordBridgeFailure({ code: "discord_recovery_failed", error, stage: "recovery" }));
    }
  }

  const bridge: DiscordBridge = Object.freeze({
    handleMessage,
    handleOverflow,

    register(registry: DiscordHandlerRegistry) {
      const removers = [registry.registerMessage(handleMessage), registry.registerOverflow(handleOverflow)];
      return () => { for (const remove of removers) remove(); };
    },

    recover(startedAt: Date) {
      sweeping ??= track(runInBackground(() => sweep(startedAt))
        .catch((error: unknown) => logDiscordBridgeFailure({ code: "discord_recovery_failed", error, stage: "recovery" }))
        .finally(() => { sweeping = null; }));
      return sweeping;
    },

    startRecovery(startedAt: Date) {
      void bridge.recover(startedAt);
      const timer = setInterval(() => { void bridge.recover(startedAt); }, timing.recoveryIntervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },

    isLive: (runId: string) => following.has(runId),

    async idle() {
      while (work.size > 0) await Promise.allSettled([...work]);
    }
  });
  return bridge;
}
