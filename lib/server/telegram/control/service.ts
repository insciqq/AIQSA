import {
  isTelegramReasonCode, telegramAdminStateSchema, type TelegramAdminState, type TelegramHealthCode
} from "../../../contracts/telegram";
import { logEvent } from "../../observability";
import type { TelegramBotApi } from "../botApi";
import { telegramFailureCode } from "../codes";
import { TELEGRAM_BOT_COMMANDS } from "../copy";
import type { TelegramFailure } from "../transport";
import type { TelegramControlHooks } from "./hooks";
import type { TelegramControlRecord, TelegramControlRepository, TelegramControlWrite } from "./repository";
import { effectiveTelegramControl, type TelegramControlCache } from "./state";
import { encryptTelegramBotToken, isTelegramBotToken, telegramTokenBotId } from "./tokenEnvelope";

/**
 * The administrator's bot control: Test & Save proves a token with `getMe`
 * before anything is stored, enabling proves the stored token can take over
 * the bot (`deleteWebhook`, then `setMyCommands`), and every change names the
 * version it was made against. The token never leaves this service except
 * inside its envelope and the Bot API client.
 */

export const TELEGRAM_CONTROL_ERROR_CODES = [
  "telegram_access_groups_invalid",
  "telegram_control_stale",
  "telegram_encryption_unavailable",
  "telegram_token_missing",
  "telegram_token_rejected",
  "telegram_token_unreadable",
  "telegram_unreachable"
] as const;
export type TelegramControlErrorCode = (typeof TELEGRAM_CONTROL_ERROR_CODES)[number];

export type TelegramControlResult =
  | Readonly<{ ok: true; state: TelegramAdminState }>
  | Readonly<{ ok: false; code: TelegramControlErrorCode }>;

export type TelegramControlService = Readonly<{
  read(): Promise<TelegramAdminState>;
  testAndSave(input: Readonly<{ actorUserId: string; expectedVersion: number; token: string }>): Promise<TelegramControlResult>;
  enable(input: Readonly<{ actorUserId: string; expectedVersion: number }>): Promise<TelegramControlResult>;
  disable(input: Readonly<{ actorUserId: string; expectedVersion: number }>): Promise<TelegramControlResult>;
  setAccess(input: Readonly<{
    actorUserId: string; expectedVersion: number; groupIds: readonly string[]; restricted: boolean;
  }>): Promise<TelegramControlResult>;
}>;

/** A Telegram call made for the administrator gets this hard deadline, waits for rate limits included. */
export const TELEGRAM_ADMIN_CALL_DEADLINE_MS = 15_000;

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** The browser projection: switch, access, whether a token is stored, the bot's username and health codes. */
export function telegramAdminState(record: TelegramControlRecord): TelegramAdminState {
  const lastFailureCode = isTelegramReasonCode(record.lastFailureCode) ? record.lastFailureCode : null;
  return telegramAdminStateSchema.parse({
    botUsername: record.botUsername && USERNAME_PATTERN.test(record.botUsername) ? record.botUsername : null,
    enabled: record.enabled,
    groupIds: [...record.groupIds],
    health: {
      lastFailureAt: lastFailureCode ? iso(record.lastFailureAt) : null,
      lastFailureCode,
      lastPollAt: iso(record.lastPollAt),
      lastSuccessAt: iso(record.lastSuccessAt)
    },
    restricted: record.restricted,
    tokenConfigured: record.tokenEnvelope !== null,
    version: record.version
  });
}

/** Content-free: stages, outcomes and stable codes only. */
function log(fields: Readonly<{
  code?: string; httpStatus?: number; outcome: "completed" | "failed" | "skipped"; stage: "probe" | "publish" | "write";
}>): void {
  logEvent("service_operation", { subsystem: "telegram", ...fields });
}

/** 401 and 404 mean Telegram does not know the token; anything else is Telegram being unreachable. */
export function telegramTokenFailureCode(failure: TelegramFailure): "telegram_token_rejected" | "telegram_unreachable" {
  return failure.kind === "telegram" && (failure.errorCode === 401 || failure.errorCode === 404)
    ? "telegram_token_rejected" : "telegram_unreachable";
}

function writeFailure(write: Exclude<TelegramControlWrite, { kind: "ok" }>): TelegramControlErrorCode {
  if (write.kind === "stale") return "telegram_control_stale";
  if (write.kind === "token_missing") return "telegram_token_missing";
  return "telegram_access_groups_invalid";
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export function createTelegramControlService(deps: Readonly<{
  cache: TelegramControlCache;
  createBotApi(token: string): TelegramBotApi;
  encryptionKey(): Buffer;
  hooks: TelegramControlHooks;
  repository: TelegramControlRepository;
  deadlineMs?: number;
}>): TelegramControlService {
  const deadlineMs = deps.deadlineMs ?? TELEGRAM_ADMIN_CALL_DEADLINE_MS;

  function committed(record: TelegramControlRecord): TelegramControlResult {
    deps.cache.invalidate();
    deps.hooks.changed();
    return { ok: true, state: telegramAdminState(record) };
  }

  function refused(code: TelegramControlErrorCode): TelegramControlResult {
    return { ok: false, code };
  }

  /** Takes the bot over for long polling and registers its commands, then runs the activation hooks. */
  async function activate(api: TelegramBotApi, botId: number): Promise<ReturnType<typeof telegramTokenFailureCode> | null> {
    for (const step of [() => api.deleteWebhook(), () => api.setMyCommands(TELEGRAM_BOT_COMMANDS)]) {
      const outcome = await withDeadline(step(), deadlineMs);
      if (outcome === "timeout") {
        log({ code: "telegram_request_timeout", outcome: "failed", stage: "publish" });
        return "telegram_unreachable";
      }
      if (!outcome.ok) {
        log({ code: telegramFailureCode(outcome.kind, outcome.errorCode), httpStatus: outcome.status, outcome: "failed", stage: "publish" });
        return telegramTokenFailureCode(outcome);
      }
    }
    for (const hook of deps.hooks.activationHooks()) {
      try {
        await hook({ api, botId });
      } catch {
        log({ code: "telegram_activation_hook_failed", outcome: "failed", stage: "publish" });
      }
    }
    return null;
  }

  /** Health of the bot just saved; a lost health write still shows the failure in this answer. */
  async function recordActivationFailure(
    record: TelegramControlRecord, botId: number, failureCode: TelegramHealthCode
  ): Promise<TelegramControlRecord> {
    const at = new Date();
    try {
      await deps.repository.recordPollHealth({ at, botId, failureCode, success: false });
    } catch {
      log({ code: "telegram_health_write_failed", outcome: "failed", stage: "write" });
    }
    return { ...record, lastFailureAt: at, lastFailureCode: failureCode, lastPollAt: at };
  }

  return Object.freeze({
    async read() {
      return telegramAdminState(await deps.repository.read());
    },

    async testAndSave(input) {
      const current = await deps.repository.read();
      if (current.version !== input.expectedVersion) return refused("telegram_control_stale");
      let key: Buffer;
      try {
        key = deps.encryptionKey();
      } catch {
        log({ code: "telegram_encryption_unavailable", outcome: "failed", stage: "write" });
        return refused("telegram_encryption_unavailable");
      }
      const tokenBotId = isTelegramBotToken(input.token) ? telegramTokenBotId(input.token) : null;
      if (tokenBotId === null) return refused("telegram_token_rejected");
      const api = deps.createBotApi(input.token);
      const me = await withDeadline(api.getMe(), deadlineMs);
      if (me === "timeout" || !me.ok) {
        const code = me === "timeout" ? "telegram_unreachable" : telegramTokenFailureCode(me);
        log({ code, httpStatus: me === "timeout" ? undefined : me.status, outcome: "failed", stage: "probe" });
        return refused(code);
      }
      // A token always names its own bot; anything else is not a usable bot token.
      if (me.result.id !== tokenBotId || !me.result.is_bot || !USERNAME_PATTERN.test(me.result.username)) {
        log({ code: "telegram_token_rejected", outcome: "failed", stage: "probe" });
        return refused("telegram_token_rejected");
      }
      const write = await deps.repository.saveToken({
        actorUserId: input.actorUserId,
        botId: me.result.id,
        botUsername: me.result.username,
        expectedVersion: input.expectedVersion,
        seal: (generation) => encryptTelegramBotToken({ generation, key, token: input.token })
      });
      if (write.kind !== "ok") return refused(writeFailure(write));
      log({ outcome: "completed", stage: "probe" });
      // A new token while the bot is on: the new bot is taken over now. The token stays saved
      // either way; a failed takeover becomes the bot's health so the administrator sees it.
      if (write.record.enabled) {
        const failure = await activate(api, me.result.id);
        if (failure) return committed(await recordActivationFailure(write.record, me.result.id, failure));
      }
      return committed(write.record);
    },

    async enable(input) {
      const current = await deps.repository.read();
      if (current.version !== input.expectedVersion) return refused("telegram_control_stale");
      if (current.tokenEnvelope === null) return refused("telegram_token_missing");
      const control = effectiveTelegramControl(current, deps.encryptionKey);
      if (!control.bot) {
        log({ code: "telegram_token_unreadable", outcome: "failed", stage: "publish" });
        return refused("telegram_token_unreadable");
      }
      const failure = await activate(deps.createBotApi(control.bot.token), control.bot.id);
      if (failure) return refused(failure);
      const write = await deps.repository.setEnabled({ actorUserId: input.actorUserId, enabled: true, expectedVersion: input.expectedVersion });
      return write.kind === "ok" ? committed(write.record) : refused(writeFailure(write));
    },

    async disable(input) {
      const write = await deps.repository.setEnabled({ actorUserId: input.actorUserId, enabled: false, expectedVersion: input.expectedVersion });
      return write.kind === "ok" ? committed(write.record) : refused(writeFailure(write));
    },

    async setAccess(input) {
      const write = await deps.repository.setAccess(input);
      return write.kind === "ok" ? committed(write.record) : refused(writeFailure(write));
    }
  });
}
