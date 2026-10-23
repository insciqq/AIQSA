import { observedFailureCode } from "../lib/server/providers/providerObservability";

// Legacy maintenance guards throw Error(message). Only these exact, owned
// messages may become diagnostic codes; never accept a token-shaped message.
const guardCodes = new Set([
  "memory_restore_reconciliation_not_authorized",
  "memory_restore_reconciliation_pending",
  "memory_restore_service_identity_invalid",
  "memory_restore_endpoint_invalid",
  "memory_restore_endpoint_not_isolated",
  ...["anthropic_api_key", "custom_openai_api_key", "deepseek_api_key", "gemini_api_key",
    "google_api_key", "openai_api_key", "openrouter_api_key", "_dev_custom_openai_api_key"]
    .map(key => `memory_restore_provider_credentials_forbidden_${key}`)
]);

export function maintenanceFailureCode(error: unknown, fallback: string): string {
  const code = observedFailureCode(error);
  if (code !== "unknown") return code;
  try {
    if (!(error instanceof Error)) return fallback;
    const message = Object.getOwnPropertyDescriptor(error, "message");
    return message && "value" in message && typeof message.value === "string" && guardCodes.has(message.value)
      ? message.value : fallback;
  } catch { return fallback; }
}
