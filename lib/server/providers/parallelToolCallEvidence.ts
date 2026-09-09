import type { AdminProviderTestEvidence } from "../../contracts/adminProviders";
import { supportsForcedToolCallProbe } from "./forcedToolCallEvidence";

type Evidence = NonNullable<AdminProviderTestEvidence["parallelToolCalls"]>;

export function decodeParallelToolCallVerificationEvidence(value: unknown): Evidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.probeVersion !== 1 || candidate.verified !== true ||
    typeof candidate.adapterKind !== "string" || !supportsForcedToolCallProbe(candidate.adapterKind) ||
    typeof candidate.upstreamModelId !== "string" || !candidate.upstreamModelId.trim() ||
    candidate.upstreamModelId !== candidate.upstreamModelId.trim() || candidate.upstreamModelId.length > 512) return null;
  return { adapterKind: candidate.adapterKind, probeVersion: 1,
    upstreamModelId: candidate.upstreamModelId, verified: true };
}
