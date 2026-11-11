import { randomInt, randomUUID } from "node:crypto";
import type { ContentBlock } from "../../../domain/content";
import { CONNECTOR_RUN_FOLLOW_MS, createConnectorRunWait, followConnectorSend } from "../../connectors/runAdmission";
import { RUN_STREAM_IDLE_MS } from "../../connectors/sse";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramRunLinkStore } from "../store/runLinks";
import {
  buildTelegramSendBody, resolveTelegramModel, type TelegramRunCatalog, type TelegramSendTarget, type TelegramSystemTurn
} from "./body";
import type { TelegramRunStreamEvent } from "./events";
import type { TelegramRunGateway } from "./gateway";
import type { TelegramSendRefusal } from "./refusals";

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
  const followMs = deps.followMs ?? CONNECTOR_RUN_FOLLOW_MS;
  const waitForRun = createConnectorRunWait(deps.gateway, { now, ...(deps.sleep ? { sleep: deps.sleep } : {}) });

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

  async function classify(response: Response, input: TelegramSendInput, chatId: string, draftId: number): Promise<TelegramAdmission> {
    const followed = await followConnectorSend(response, {
      followMs, idleMs: deps.idleMs ?? RUN_STREAM_IDLE_MS, now, recordRun: (runId) => recordRunLink(runId, input.link, draftId),
      userId: input.link.userId, waitForRun
    });
    return followed.kind === "refused" ? followed : { ...followed, chatId, draftId };
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
