import { MCP_APPROVAL_CONTINUATION_UNAVAILABLE } from "../../../contracts/mcpApprovals";
import { isUsageLimitRefusalCode } from "../../../contracts/usageLimits";
import { TELEGRAM_COPY, TELEGRAM_RUN_REFUSAL_COPY as COPY, telegramReasonText, telegramUsageLimitText } from "../copy";

/**
 * Every refusal of the send handler as a short text and the one recovery
 * action that fits it: choose another model, open the bot settings, or open
 * the chat in AIQSA. Codes are mapped by family, so a code added later still
 * gets its family's text, and an unknown one the generic text with AIQSA.
 */

/** Why a message was not admitted, as the send handler (or the bridge before it) answered. */
export type TelegramSendRefusal = Readonly<{
  status: number;
  code: string;
  /** From `retry-after`, for usage limits. */
  retryAfterSeconds?: number;
  usageLimit?: Readonly<{ limit: number | null; window: string | null }>;
  /** The run that holds the chat (`active_run_in_progress`). */
  activeRunId?: string;
}>;

export type TelegramRefusalAction = "model" | "settings" | "open" | "none";

export type TelegramRefusalReply = Readonly<{
  text: string;
  action: TelegramRefusalAction;
  /** The chat can no longer take messages: the link stops naming it as current. */
  chatGone?: true;
}>;

const ACCESS_CODES = new Set(["unauthorized", "forbidden", "user_not_available", "user_not_found"]);
const MODEL_CODES = new Set([
  "model_unavailable", "model_not_available", "provider_not_available", "provider_unavailable", "provider_admission_changed",
  "model_cannot_report", "openrouter_routing_unavailable", "openrouter_required_parameters_unavailable"
]);
const CHAT_CODES = new Set(["chat_not_found", "chat_not_created", "personal_draft_invalid", "personal_draft_conflict"]);
const ATTACHMENT_CODES = new Set(["unsupported_attachment_type", "image_attachment_not_supported"]);
const CONTEXT_CODES = new Set([
  "context_too_large", "assistant_instructions_expansion_too_large", "instruction_preset_expansion_too_large"
]);

function reply(text: string, action: TelegramRefusalAction, chatGone = false): TelegramRefusalReply {
  return chatGone ? { action, chatGone: true, text } : { action, text };
}

export function telegramRefusalReply(refusal: TelegramSendRefusal): TelegramRefusalReply {
  const { code } = refusal;
  if (ACCESS_CODES.has(code)) return reply(telegramReasonText("telegram_access_off")!, "none");
  if (isUsageLimitRefusalCode(code)) {
    return reply(telegramUsageLimitText({
      code, limit: refusal.usageLimit?.limit, retryAfterSeconds: refusal.retryAfterSeconds, window: refusal.usageLimit?.window
    }), "none");
  }
  if (code === "usage_limits_unavailable") return reply(COPY.usageUnavailable, "none");
  if (code === "active_run_in_progress") return reply(COPY.replyRunning, "open");
  if (code === "no_model") return reply(COPY.noModel, "none");
  if (MODEL_CODES.has(code) || code.startsWith("credential_")) return reply(COPY.modelUnavailable, "model");
  if (code.startsWith("search_") || code === "unsupported_search_strategy") return reply(COPY.searchUnavailable, "settings");
  if (CONTEXT_CODES.has(code)) return reply(COPY.contextTooLarge, "none");
  if (code === "workspace_disabled") return reply(COPY.workspaceDisabled, "settings");
  if (code === "workspace_model_tools_required") return reply(COPY.workspaceModel, "model");
  if (code.startsWith("workspace_")) return reply(COPY.workspaceUnavailable, "settings");
  // An approval's continuation after its window or its use: only a new request asks again.
  if (code === MCP_APPROVAL_CONTINUATION_UNAVAILABLE) return reply(TELEGRAM_COPY.approvalExpired, "none");
  if (code.startsWith("mcp_")) return reply(COPY.toolsUnavailable, "open");
  if (code.startsWith("skill")) return reply(COPY.skillUnavailable, "open");
  if (code.startsWith("assistant_")) return reply(COPY.assistantUnavailable, "none");
  if (CHAT_CODES.has(code) || code.startsWith("memory_temporary_")) {
    return reply(COPY.chatUnavailable, "none", true);
  }
  if (code.startsWith("attachment_") || code.startsWith("pdf_") || code.startsWith("chat_pdf_") || ATTACHMENT_CODES.has(code)) {
    return reply(COPY.attachmentUnavailable, "open");
  }
  if (code === "request_body_too_large") return reply(COPY.tooLong, "none");
  return reply(COPY.generic, "open");
}
