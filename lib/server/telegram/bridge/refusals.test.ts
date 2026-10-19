import { describe, expect, it } from "vitest";
import failureCodes from "../../observability/failureCodes.json";
import { TELEGRAM_COPY, TELEGRAM_RUN_REFUSAL_COPY as COPY, telegramReasonText, telegramUsageLimitText } from "../copy";
import { TELEGRAM_BRIDGE_LOG_CODES } from "./index";
import { telegramRefusalReply } from "./refusals";

describe("refusals of the send handler in Telegram", () => {
  it.each([
    ["unauthorized", telegramReasonText("telegram_access_off"), "none"],
    ["user_not_available", telegramReasonText("telegram_access_off"), "none"],
    ["active_run_in_progress", COPY.replyRunning, "open"],
    ["usage_limits_unavailable", COPY.usageUnavailable, "none"],
    ["no_model", COPY.noModel, "none"],
    ["model_unavailable", COPY.modelUnavailable, "model"],
    ["model_not_available", COPY.modelUnavailable, "model"],
    ["provider_not_available", COPY.modelUnavailable, "model"],
    ["credential_revoked", COPY.modelUnavailable, "model"],
    ["search_plan_invalid", COPY.searchUnavailable, "settings"],
    ["search_strategy_not_available", COPY.searchUnavailable, "settings"],
    ["workspace_disabled", COPY.workspaceDisabled, "settings"],
    ["workspace_model_tools_required", COPY.workspaceModel, "model"],
    ["workspace_busy", COPY.workspaceUnavailable, "settings"],
    ["workspace_secret_limit", COPY.workspaceUnavailable, "settings"],
    ["agent_model_unsupported", COPY.agentModel, "model"],
    ["agent_unavailable", COPY.agentUnavailable, "settings"],
    ["agent_context_too_large", COPY.contextTooLarge, "none"],
    ["context_too_large", COPY.contextTooLarge, "none"],
    ["mcp_approval_continuation_unavailable", TELEGRAM_COPY.approvalExpired, "none"],
    ["mcp_not_ready", COPY.toolsUnavailable, "open"],
    ["mcp_tool_access_denied", COPY.toolsUnavailable, "open"],
    ["skill_not_available", COPY.skillUnavailable, "open"],
    ["skills_budget_exceeded", COPY.skillUnavailable, "open"],
    ["assistant_not_available", COPY.assistantUnavailable, "none"],
    ["assistant_overrides_not_allowed", COPY.assistantUnavailable, "none"],
    ["knowledge_base_not_available", COPY.knowledgeUnavailable, "open"],
    ["sources_processing", COPY.knowledgeUnavailable, "open"],
    ["attachment_not_available", COPY.attachmentUnavailable, "open"],
    ["unsupported_attachment_type", COPY.attachmentUnavailable, "open"],
    ["request_body_too_large", COPY.tooLong, "none"],
    ["internal_error", COPY.generic, "open"],
    ["some_future_code", COPY.generic, "open"]
  ] as const)("answers %s with its text and recovery action", (code, text, action) => {
    expect(telegramRefusalReply({ code, status: 409 })).toMatchObject({ action, text });
  });

  it("drops a chat that can no longer take messages from the link", () => {
    for (const code of ["chat_not_found", "chat_not_created", "personal_draft_conflict", "project_not_found", "memory_temporary_chat_forbidden"]) {
      expect(telegramRefusalReply({ code, status: 404 })).toEqual({ action: "none", chatGone: true, text: COPY.chatUnavailable });
    }
  });

  it("names the usage limit and when sending works again, never the shared budget's amounts", () => {
    expect(telegramRefusalReply({
      code: "message_rate_limited", retryAfterSeconds: 720, status: 429, usageLimit: { limit: 20, window: "hour" }
    })).toEqual({ action: "none", text: "You've reached your limit of 20 messages per hour. You can send again in 12 min." });
    expect(telegramUsageLimitText({ code: "message_rate_limited", limit: 1, retryAfterSeconds: 30, window: "day" }))
      .toBe("You've reached your limit of 1 message per day. You can send again in a minute.");
    expect(telegramUsageLimitText({ code: "message_rate_limited", limit: 0, window: "hour" }))
      .toBe("Your limit is 0 messages per hour, so you can't send messages. An administrator can raise it.");
    expect(telegramUsageLimitText({ code: "usage_budget_exhausted", limit: 5_000_000, retryAfterSeconds: 5 * 86_400 }))
      .toBe("Your monthly budget is used up. You can send messages again in about 5 days.");
    expect(telegramUsageLimitText({ code: "installation_budget_exhausted", limit: null, retryAfterSeconds: 7_200 }))
      .toBe("The monthly budget shared by everyone is used up. You can send messages again in about 2 h, or sooner if an administrator raises it.");
  });

  it("registers every bridge log code among its sorted neighbours", () => {
    const registry = failureCodes as string[];
    for (const code of TELEGRAM_BRIDGE_LOG_CODES) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});
