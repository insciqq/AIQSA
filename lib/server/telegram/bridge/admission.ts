import { randomInt, randomUUID } from "node:crypto";
import { decodePreparingRunAdmission } from "../../../contracts/runs";
import type { ContentBlock } from "../../../domain/content";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramRunLinkStore } from "../store/runLinks";
import {
  buildTelegramSendBody, resolveTelegramModel, type TelegramRunCatalog, type TelegramSendTarget, type TelegramSystemTurn
} from "./body";
import type { TelegramRunStreamEvent } from "./events";
import { TELEGRAM_TERMINAL_RUN_STATUSES, type TelegramRunGateway } from "./gateway";
import type { TelegramSendRefusal } from "./refusals";
import { createRunStreamReader, RUN_STREAM_IDLE_MS, type RunStreamFrame, type RunStreamReader } from "./sse";

/**
 * Admission of one Telegram message as an ordinary AIQSA run (D-07): the
 * explicit body from the user's catalog, the ordinary send handler called in
 * process as the linked user (who is re-read and whose Telegram access is
 * re-checked on every resolution), one retry when the chat moved on in the
 * web meanwhile (`active_leaf_changed`), the run's `TelegramRunLink` recorded
 * as soon as the run is known, and the run as a stream of typed events. A run
 * that streams nothing here (a deferred admission, or a stream lost before its
 * end) is followed through its state until it settles.
 */

export type TelegramChatTarget =
  | Readonly<{ kind: "existing"; chatId: string }>
  | Readonly<{ kind: "new"; assistantId: string | null }>;

export type TelegramSendInput = Readonly<{
  link: TelegramLinkRecord;
  chatTarget: TelegramChatTarget;
  /** Text and, from media, image and file blocks of uploads already made as the user. */
  contentBlocks: readonly ContentBlock[];
  /** A server-written continuation turn (after an MCP approval); the content is then ignored. */
  systemTurn?: TelegramSystemTurn;
  /** The update that asked for the run; it names the admission (`tg-<botId>-<updateId>`). */
  updateId: number;
}>;

export type TelegramAdmitted = Readonly<{
  kind: "admitted";
  chatId: string;
  runId: string;
  assistantMessageId: string | null;
  userMessageId: string | null;
  /** The draft the run streams into (`draft_id`, never 0). */
  draftId: number;
  /** Whether the run's `TelegramRunLink` row exists, so delivery is claimed exactly once. */
  runLinked: boolean;
  /** Admitted for later (PDF or Workspace preparation): nothing streams here. */
  deferred: boolean;
  events: AsyncIterable<TelegramRunStreamEvent>;
}>;

export type TelegramAdmission = TelegramAdmitted | Readonly<{ kind: "refused"; refusal: TelegramSendRefusal }>;

export type TelegramSendMessage = (input: TelegramSendInput) => Promise<TelegramAdmission>;

/** How often a run that streams nothing here is read: from 1 s, doubling up to 15 s. */
export const TELEGRAM_RUN_POLL_MIN_MS = 1_000;
export const TELEGRAM_RUN_POLL_MAX_MS = 15_000;
/** How long a run that streams nothing here is followed before the bridge stops watching it. */
export const TELEGRAM_RUN_FOLLOW_MS = 6 * 3_600_000;

export type TelegramRunWait = (input: Readonly<{ runId: string; userId: string; deadline: number }>) =>
  Promise<"complete" | "error" | "cancelled" | "gone" | null>;

type Clock = Readonly<{ now: () => number; sleep: (ms: number) => Promise<void> }>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Follows a run's state until it settles (`gone` when it can no longer be read), or null past the deadline. */
export function createTelegramRunWait(
  gateway: Pick<TelegramRunGateway, "runState">, clock: Partial<Clock> = {}
): TelegramRunWait {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? defaultSleep;
  return async ({ deadline, runId, userId }) => {
    let delay = TELEGRAM_RUN_POLL_MIN_MS;
    for (;;) {
      const state = await gateway.runState({ runId, userId }).catch(() => ({ status: "unknown" }));
      if (!state) return "gone";
      if (TELEGRAM_TERMINAL_RUN_STATUSES.has(state.status)) return state.status as "complete" | "error" | "cancelled";
      if (now() + delay > deadline) return null;
      await sleep(delay);
      delay = Math.min(delay * 2, TELEGRAM_RUN_POLL_MAX_MS);
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stream frames the bridge follows, as typed events; everything else stays with the web. */
export function telegramRunEvent(frame: RunStreamFrame): TelegramRunStreamEvent | null {
  const data = isRecord(frame.data) ? frame.data : {};
  switch (frame.type) {
    case "token":
      return typeof data.delta === "string" && data.delta ? { delta: data.delta, type: "answerDelta" } : null;
    case "message_reset":
      return { type: "answerReset" };
    case "artifact":
      if (data.artifactType === "mcp_approval") return { card: data.payload, type: "approvalRequested" };
      if (data.artifactType === "workspace_activity") return { entry: data.payload, type: "workspaceActivity" };
      return null;
    case "done":
      return { status: data.status === "cancelled" ? "cancelled" : "complete", type: "done" };
    case "error":
      return {
        code: typeof data.code === "string" ? data.code : null, message: typeof data.message === "string" ? data.message : null,
        type: "failed"
      };
    default:
      return null;
  }
}

function terminalEvent(status: "complete" | "error" | "cancelled" | "gone"): TelegramRunStreamEvent {
  if (status === "complete" || status === "cancelled") return { status, type: "done" };
  return { code: status === "gone" ? "model_run_not_found" : null, message: null, type: "failed" };
}

function refusalFrom(response: Response, body: unknown): TelegramSendRefusal {
  const value = isRecord(body) ? body : {};
  const code = response.status === 401 ? "unauthorized" : typeof value.error === "string" ? value.error : `http_${response.status}`;
  const retryAfter = Number(response.headers.get("retry-after"));
  const usage = isRecord(value.usageLimit) ? value.usageLimit : null;
  const run = isRecord(value.run) ? value.run : null;
  return {
    code,
    status: response.status,
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
    ...(usage ? {
      usageLimit: { limit: typeof usage.limit === "number" ? usage.limit : null, window: typeof usage.window === "string" ? usage.window : null }
    } : {}),
    ...(run && typeof run.id === "string" ? { activeRunId: run.id } : {})
  };
}

function log(fields: Readonly<{ code: string; error?: unknown; outcome: "failed" | "skipped"; runId?: string }>): void {
  logEvent("service_operation", {
    code: fields.code, ...(fields.error ? { error: fields.error, prisma_code: databaseFailureCode(fields.error) } : {}),
    outcome: fields.outcome, ...(fields.runId ? { run_id: fields.runId } : {}), stage: "dispatch", subsystem: "telegram"
  });
}

export function createTelegramAdmission(deps: Readonly<{
  gateway: Pick<TelegramRunGateway, "findChat" | "loadCatalog" | "runState" | "send" | "timeZone">;
  runLinks: Pick<TelegramRunLinkStore, "create">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newChatId?: () => string;
  newDraftId?: () => number;
  idleMs?: number;
  followMs?: number;
}>): TelegramSendMessage {
  const now = deps.now ?? Date.now;
  const newChatId = deps.newChatId ?? randomUUID;
  const newDraftId = deps.newDraftId ?? (() => randomInt(1, 2_147_483_647));
  const followMs = deps.followMs ?? TELEGRAM_RUN_FOLLOW_MS;
  const waitForRun = createTelegramRunWait(deps.gateway, { now, ...(deps.sleep ? { sleep: deps.sleep } : {}) });

  type Prepared = Readonly<{ body: Record<string, unknown>; chatId: string }> | Readonly<{ refusal: TelegramSendRefusal }>;

  async function prepare(
    input: TelegramSendInput, catalog: TelegramRunCatalog, timeZone: string | null, admissionId: string, newChat: string
  ): Promise<Prepared> {
    const { link } = input;
    let target: TelegramSendTarget;
    let chatId: string;
    let chatModel = null;
    if (input.chatTarget.kind === "existing") {
      const chat = await deps.gateway.findChat(link.userId, input.chatTarget.chatId);
      if (!chat) return { refusal: { code: "chat_not_found", status: 404 } };
      target = { activeLeafMessageId: chat.activeLeafMessageId, assistantBound: chat.assistantId !== null, kind: "existing" };
      chatId = chat.id;
      chatModel = chat.model;
    } else {
      target = { assistantId: input.chatTarget.assistantId, kind: "new" };
      chatId = newChat;
    }
    const assistantChat = target.kind === "existing" ? target.assistantBound : target.assistantId !== null;
    let model = null;
    if (!assistantChat) {
      const resolved = resolveTelegramModel(catalog, {
        chatModel,
        selected: link.selectedModelId && link.selectedProvider ? { modelId: link.selectedModelId, provider: link.selectedProvider } : null
      });
      if (!resolved.ok) return { refusal: { code: resolved.code, status: 409 } };
      model = resolved.model;
    }
    return {
      body: buildTelegramSendBody({
        admissionId, catalog, content: input.contentBlocks, model,
        settings: { searchEnabled: link.searchEnabled, workspaceEnabled: link.workspaceEnabled },
        ...(input.systemTurn ? { systemTurn: input.systemTurn } : {}),
        target, timeZone
      }),
      chatId
    };
  }

  async function recordRunLink(runId: string, link: TelegramLinkRecord, draftId: number): Promise<boolean> {
    try {
      await deps.runLinks.create({
        draftId, linkId: link.id, now: new Date(now()), runId, telegramChatId: link.telegramChatId, userId: link.userId
      });
      return true;
    } catch (error) {
      // The answer is still delivered; only exactly-once recovery and the push exclusion need the row.
      log({ code: "telegram_run_admission_failed", error, outcome: "failed", runId });
      return false;
    }
  }

  async function* polled(runId: string, userId: string, status: string | null): AsyncGenerator<TelegramRunStreamEvent> {
    if (status !== null) yield { status, type: "preparing" };
    const settled = await waitForRun({ deadline: now() + followMs, runId, userId });
    if (settled) yield terminalEvent(settled);
  }

  async function* streamed(
    reader: RunStreamReader, runId: string, userId: string, early: readonly TelegramRunStreamEvent[]
  ): AsyncGenerator<TelegramRunStreamEvent> {
    try {
      for (const event of early) {
        yield event;
        if (event.type === "done" || event.type === "failed") return;
      }
      for (;;) {
        const read = await reader.next();
        if (read.kind !== "frame") break;
        const event = telegramRunEvent(read.frame);
        if (!event) continue;
        yield event;
        if (event.type === "done" || event.type === "failed") return;
      }
    } finally {
      await reader.cancel();
    }
    // The stream ended or went silent before its terminal frame: the run's state decides.
    yield* polled(runId, userId, null);
  }

  async function admitStream(
    response: Response, input: TelegramSendInput, chatId: string, draftId: number
  ): Promise<TelegramAdmission> {
    const reader = createRunStreamReader(response.body!, { idleMs: deps.idleMs ?? RUN_STREAM_IDLE_MS });
    let runId: string | null = null;
    let linked: Promise<boolean> = Promise.resolve(false);
    let started: Record<string, unknown> = {};
    const early: TelegramRunStreamEvent[] = [];
    for (;;) {
      const read = await reader.next();
      if (read.kind !== "frame") break;
      const data = isRecord(read.frame.data) ? read.frame.data : {};
      if (!runId) {
        if (read.frame.type === "run_start" && typeof data.runId === "string") {
          runId = data.runId;
          // Recorded the moment the run is known, while the run goes on: whatever the run
          // does next (its first tool call included) can already tell it came from Telegram.
          linked = recordRunLink(runId, input.link, draftId);
        } else if (read.frame.type === "error") {
          await reader.cancel();
          const failed = telegramRunEvent(read.frame);
          return { kind: "refused", refusal: { code: failed?.type === "failed" && failed.code ? failed.code : "run_failed", status: 500 } };
        }
        continue;
      }
      if (read.frame.type === "message_start") {
        started = data;
        break;
      }
      const event = telegramRunEvent(read.frame);
      if (event) early.push(event);
      if (event?.type === "done" || event?.type === "failed") break;
    }
    if (!runId) {
      await reader.cancel();
      return { kind: "refused", refusal: { code: "run_stream_unavailable", status: 500 } };
    }
    return {
      assistantMessageId: typeof started.assistantMessageId === "string" ? started.assistantMessageId : null,
      chatId, deferred: false, draftId, events: streamed(reader, runId, input.link.userId, early), kind: "admitted", runId,
      runLinked: await linked, userMessageId: typeof started.userMessageId === "string" ? started.userMessageId : null
    };
  }

  async function classify(response: Response, input: TelegramSendInput, chatId: string, draftId: number): Promise<TelegramAdmission> {
    if (response.ok && response.body && response.headers.get("content-type")?.startsWith("text/event-stream")) {
      return admitStream(response, input, chatId, draftId);
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 202) {
      const deferred = decodePreparingRunAdmission(body);
      if (!deferred) return { kind: "refused", refusal: { code: "run_stream_unavailable", status: 500 } };
      const runLinked = await recordRunLink(deferred.run.id, input.link, draftId);
      return {
        assistantMessageId: deferred.assistantMessageId, chatId, deferred: true, draftId,
        events: polled(deferred.run.id, input.link.userId, deferred.run.status), kind: "admitted", runId: deferred.run.id, runLinked,
        userMessageId: deferred.userMessageId
      };
    }
    return { kind: "refused", refusal: refusalFrom(response, body) };
  }

  return async function sendTelegramMessage(input) {
    const [catalog, timeZone] = await Promise.all([
      deps.gateway.loadCatalog(input.link.userId),
      // Only a hint: an unreadable zone leaves the run on the UTC fallback, never refuses it.
      deps.gateway.timeZone(input.link.userId).catch((error: unknown) => {
        log({ code: "telegram_time_zone_unavailable", error, outcome: "skipped" });
        return null;
      })
    ]);
    if (!catalog) return { kind: "refused", refusal: { code: "unauthorized", status: 401 } };
    const admissionId = `tg-${input.link.botId}-${input.updateId}`;
    const draftId = newDraftId();
    const newChat = newChatId();
    for (let attempt = 0; ; attempt += 1) {
      const prepared = await prepare(input, catalog, timeZone, admissionId, newChat);
      if ("refusal" in prepared) return { kind: "refused", refusal: prepared.refusal };
      const response = await deps.gateway.send({ body: prepared.body, chatId: prepared.chatId, userId: input.link.userId });
      const admission = await classify(response, input, prepared.chatId, draftId);
      // Someone continued the chat in the web meanwhile: read its new leaf and try once more.
      if (admission.kind === "refused" && admission.refusal.code === "active_leaf_changed" && attempt === 0 &&
        input.chatTarget.kind === "existing") continue;
      return admission;
    }
  };
}
