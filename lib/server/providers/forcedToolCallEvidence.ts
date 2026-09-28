import type { CatalogAdapterKind } from "../../domain/catalog";
import { resolveProviderToolChoice } from "./providerToolChoice";

export const FORCED_TOOL_CALL_PROBE_VERSION = 2 as const;
export type VerifiedToolChoiceMode = "native" | "validated_auto";

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
  verifiedModes: readonly VerifiedToolChoiceMode[];
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
  upstreamModelId: string,
  verifiedModes: readonly VerifiedToolChoiceMode[] = ["native"]
): ForcedToolCallVerificationEvidence | null {
  return supportsForcedToolCallProbe(adapterKind) && upstreamModelId.trim() &&
    verifiedModes.length > 0 && new Set(verifiedModes).size === verifiedModes.length &&
    verifiedModes.every((mode) => mode === "native" || mode === "validated_auto")
    ? {
        adapterKind,
        probeVersion: FORCED_TOOL_CALL_PROBE_VERSION,
        upstreamModelId: upstreamModelId.trim(),
        verified: true,
        verifiedModes: [...verifiedModes]
      }
    : null;
}

export function decodeForcedToolCallVerificationEvidence(
  value: unknown
): ForcedToolCallVerificationEvidence | null {
  if (
    !isRecord(value) ||
    value.verified !== true ||
    value.probeVersion !== 1 && value.probeVersion !== FORCED_TOOL_CALL_PROBE_VERSION ||
    typeof value.adapterKind !== "string" ||
    !supportsForcedToolCallProbe(value.adapterKind) ||
    typeof value.upstreamModelId !== "string" ||
    !value.upstreamModelId.trim() ||
    value.upstreamModelId.length > 512 ||
    (value.probeVersion === 1
      ? value.verifiedModes !== undefined
      : !Array.isArray(value.verifiedModes) || value.verifiedModes.length < 1 ||
        value.verifiedModes.length > 2 ||
        new Set(value.verifiedModes).size !== value.verifiedModes.length ||
        value.verifiedModes.some((mode) => mode !== "native" && mode !== "validated_auto"))
  ) return null;
  return {
    adapterKind: value.adapterKind,
    probeVersion: FORCED_TOOL_CALL_PROBE_VERSION,
    upstreamModelId: value.upstreamModelId,
    verified: true,
    verifiedModes: value.probeVersion === 1 ? ["native"] : [...value.verifiedModes as VerifiedToolChoiceMode[]]
  };
}

export function hasVerifiedToolChoiceMode(
  evidence: unknown,
  model: Readonly<{ adapterKind: CatalogAdapterKind | string; upstreamModelId: string }>,
  mode: VerifiedToolChoiceMode
): boolean {
  if (!isRecord(evidence)) return false;
  const verification = decodeForcedToolCallVerificationEvidence(evidence.forcedToolCall);
  return verification?.adapterKind === model.adapterKind &&
    verification.upstreamModelId === model.upstreamModelId &&
    verification.verifiedModes.includes(mode);
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
    capabilities: Readonly<{ toolCalling?: boolean; nativeForcedToolChoice?: boolean }>;
    defaultParams?: Record<string, unknown>;
    upstreamModelId: string;
  }>
): ForcedToolCallVerificationStatus {
  if (
    model.capabilities.toolCalling !== true ||
    !supportsForcedToolCallProbe(model.adapterKind)
  ) return "unsupported";
  const mode = resolveProviderToolChoice({ adapterKind: model.adapterKind, modelId: model.upstreamModelId,
    modelCapabilities: model.capabilities, params: model.defaultParams ?? {}, toolChoice: "required" }).requirementMode;
  if (hasVerifiedToolChoiceMode(evidence, model, mode)) return "verified";
  // A legacy native-only result (positive or negative) cannot qualify the
  // automatic route. Explicit rechecks must be allowed to obtain its proof.
  if (mode === "validated_auto" || hasVerifiedForcedToolCall(evidence, model)) return "not_verified";
  if (
    isRecord(evidence) &&
    isRecord(evidence.compatibility) &&
    evidence.compatibility.forcedToolCall === "not_supported"
  ) return "unsupported";
  return "not_verified";
}
