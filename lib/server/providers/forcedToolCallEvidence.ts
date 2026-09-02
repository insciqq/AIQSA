import type { CatalogAdapterKind } from "../../domain/catalog";

export const FORCED_TOOL_CALL_PROBE_VERSION = 1 as const;

const supportedAdapterKinds = [
  "anthropic_messages",
  "deepseek_responses_native",
  "gemini_interactions_native",
  "openai_chat_completions_compatible",
  "openai_responses_compatible",
  "openai_responses_native",
  "openrouter_chat_completions"
] as const satisfies readonly CatalogAdapterKind[];

export type ForcedToolCallAdapterKind = typeof supportedAdapterKinds[number];

const supportedAdapters = new Set<ForcedToolCallAdapterKind>(supportedAdapterKinds);

export type ForcedToolCallVerificationEvidence = Readonly<{
  adapterKind: ForcedToolCallAdapterKind;
  probeVersion: typeof FORCED_TOOL_CALL_PROBE_VERSION;
  upstreamModelId: string;
  verified: true;
}>;

export type ForcedToolCallVerificationStatus =
  | "not_verified"
  | "unsupported"
  | "verified";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsForcedToolCallProbe(
  adapterKind: CatalogAdapterKind | string
): adapterKind is ForcedToolCallAdapterKind {
  return supportedAdapters.has(adapterKind as ForcedToolCallAdapterKind);
}

export function forcedToolCallVerificationEvidence(
  adapterKind: CatalogAdapterKind | string,
  upstreamModelId: string
): ForcedToolCallVerificationEvidence | null {
  return supportsForcedToolCallProbe(adapterKind) && upstreamModelId.trim()
    ? {
        adapterKind,
        probeVersion: FORCED_TOOL_CALL_PROBE_VERSION,
        upstreamModelId: upstreamModelId.trim(),
        verified: true
      }
    : null;
}

export function decodeForcedToolCallVerificationEvidence(
  value: unknown
): ForcedToolCallVerificationEvidence | null {
  if (
    !isRecord(value) ||
    value.verified !== true ||
    value.probeVersion !== FORCED_TOOL_CALL_PROBE_VERSION ||
    typeof value.adapterKind !== "string" ||
    !supportsForcedToolCallProbe(value.adapterKind) ||
    typeof value.upstreamModelId !== "string" ||
    !value.upstreamModelId.trim() ||
    value.upstreamModelId.length > 512
  ) return null;
  return {
    adapterKind: value.adapterKind,
    probeVersion: FORCED_TOOL_CALL_PROBE_VERSION,
    upstreamModelId: value.upstreamModelId,
    verified: true
  };
}

export function hasVerifiedForcedToolCall(
  evidence: unknown,
  model: Readonly<{
    adapterKind: CatalogAdapterKind | string;
    upstreamModelId: string;
  }>
): boolean {
  if (!isRecord(evidence)) return false;
  const verification = decodeForcedToolCallVerificationEvidence(
    evidence.forcedToolCall
  );
  return verification?.adapterKind === model.adapterKind &&
    verification.upstreamModelId === model.upstreamModelId;
}

export function forcedToolCallVerificationStatus(
  evidence: unknown,
  model: Readonly<{
    adapterKind: CatalogAdapterKind | string;
    capabilities: Readonly<{ toolCalling?: boolean }>;
    upstreamModelId: string;
  }>
): ForcedToolCallVerificationStatus {
  if (
    model.capabilities.toolCalling !== true ||
    !supportsForcedToolCallProbe(model.adapterKind)
  ) return "unsupported";
  if (hasVerifiedForcedToolCall(evidence, model)) return "verified";
  if (
    isRecord(evidence) &&
    isRecord(evidence.compatibility) &&
    evidence.compatibility.forcedToolCall === "not_supported"
  ) return "unsupported";
  return "not_verified";
}
