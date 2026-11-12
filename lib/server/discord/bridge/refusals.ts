import { isUsageLimitRefusalCode } from "../../../contracts/usageLimits";
import type { ConnectorSendRefusal } from "../../connectors/runAdmission";
import { DISCORD_BRIDGE_COPY, DISCORD_COPY } from "../copy";
import type { DiscordLimitKind } from "../store/replies";

/**
 * What a Discord question that got no answer shows and records (PRD §10,
 * D-13, D-35): the short reason people read beside ❌ (null: only ❌, as for
 * the kill switch), the code and kind of failure its journal row keeps, and,
 * for the model key's own limit, the limit kind. Codes map by family, so a
 * code added later still gets its family's text and an unknown one the
 * generic "Something went wrong".
 */

export type DiscordFailureKind = "setup" | "limit" | "busy" | "context" | "admission" | "run" | "delivery" | "stopped";

export type DiscordFailure = Readonly<{
  code: string;
  text: string | null;
  failureKind: DiscordFailureKind;
  limitKind?: DiscordLimitKind;
}>;

/**
 * The provider failures a run ends with when the Discord model key reached its
 * limit (PRD D-35). Codex LB enforces a key's daily limit upstream: a 429 the
 * engine's retries could not get past ends the run as `provider_rate_limited`,
 * and a quota or balance identity (402, or `insufficient_quota` and its
 * family in the error body) as `provider_quota_exhausted`
 * (`lib/server/providers/providerObservability.ts`, `responseFailure.ts`).
 */
export const DISCORD_KEY_LIMIT_PROVIDER_CODES: ReadonlySet<string> = new Set(["provider_quota_exhausted", "provider_rate_limited"]);

const MODEL_CODES = new Set([
  "model_unavailable", "model_not_available", "provider_not_available", "provider_unavailable", "provider_admission_changed",
  "model_cannot_report", "model_adapter_unsupported", "model_tool_calling_required", "no_model", "openrouter_routing_unavailable",
  "openrouter_required_parameters_unavailable", "provider_auth_rejected", "provider_model_not_found"
]);
const CONTEXT_CODES = new Set([
  "context_too_large", "assistant_instructions_expansion_too_large", "instruction_preset_expansion_too_large"
]);
const SETUP_CODES = new Set(["unauthorized", "forbidden", "user_not_available", "user_not_found"]);

function failure(code: string, text: string | null, failureKind: DiscordFailureKind, limitKind?: DiscordLimitKind): DiscordFailure {
  return limitKind ? { code, failureKind, limitKind, text } : { code, failureKind, text };
}

/** A failure code shared by admission refusals and failed runs: usage budgets, the model key, the model, tools and context. */
function familyFailure(code: string, failureKind: "admission" | "run"): DiscordFailure | null {
  if (isUsageLimitRefusalCode(code) || code === "usage_limits_unavailable") return failure(code, DISCORD_COPY.usageLimit, failureKind);
  if (DISCORD_KEY_LIMIT_PROVIDER_CODES.has(code)) return failure("discord_key_limit", DISCORD_COPY.keyLimit, failureKind, "key");
  if (MODEL_CODES.has(code) || code.startsWith("credential_")) return failure(code, DISCORD_BRIDGE_COPY.modelUnavailable, failureKind);
  if (CONTEXT_CODES.has(code)) return failure(code, DISCORD_BRIDGE_COPY.contextTooLarge, failureKind);
  if (code.startsWith("mcp_") || code.startsWith("search_") || code === "unsupported_search_strategy") {
    return failure(code, DISCORD_BRIDGE_COPY.toolsUnavailable, failureKind);
  }
  return null;
}

/** The send handler's refusal of a Discord question. */
export function discordSendRefusalFailure(refusal: Pick<ConnectorSendRefusal, "code">): DiscordFailure {
  const { code } = refusal;
  if (SETUP_CODES.has(code) || code.startsWith("assistant_")) return failure(code, DISCORD_COPY.notSetUp, "setup");
  const family = familyFailure(code, "admission");
  if (family) return family;
  if (code === "active_run_in_progress") return failure("discord_busy", DISCORD_COPY.busy, "busy");
  if (code.startsWith("attachment_") || code.startsWith("pdf_") || code.startsWith("chat_pdf_") || code === "unsupported_attachment_type" ||
    code === "image_attachment_not_supported") return failure(code, DISCORD_BRIDGE_COPY.attachmentUnavailable, "admission");
  if (code === "request_body_too_large") return failure(code, DISCORD_BRIDGE_COPY.tooLong, "admission");
  return failure(code, DISCORD_COPY.somethingWrong, "admission");
}

/** A run that ended without an answer, by its failure code (null when none could be read). */
export function discordRunFailure(code: string | null): DiscordFailure {
  if (!code) return failure("run_failed", DISCORD_COPY.somethingWrong, "run");
  return familyFailure(code, "run") ?? failure(code, DISCORD_COPY.somethingWrong, "run");
}
