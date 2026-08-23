import type {
  AdminProviderCompatibilityEvidence,
  AdminProviderCompatibilityStatus
} from "../../../contracts/adminProviders";

export const ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION = 1;

const statuses = new Set<AdminProviderCompatibilityStatus>([
  "not_supported",
  "verified"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function status(value: unknown): value is AdminProviderCompatibilityStatus {
  return typeof value === "string" && statuses.has(value as AdminProviderCompatibilityStatus);
}

export function decodeAdminProviderCompatibilityEvidence(
  value: unknown
): AdminProviderCompatibilityEvidence | null {
  if (
    !isRecord(value) ||
    value.probeVersion !== ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION ||
    !status(value.modelAccess) ||
    !status(value.structuredOutput) ||
    !status(value.directPdf) ||
    !status(value.streaming) ||
    !status(value.usage)
  ) return null;

  return {
    directPdf: value.directPdf,
    modelAccess: value.modelAccess,
    probeVersion: ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION,
    streaming: value.streaming,
    structuredOutput: value.structuredOutput,
    usage: value.usage
  };
}

export function unsupportedAdminProviderCompatibilityEvidence(): AdminProviderCompatibilityEvidence {
  return {
    directPdf: "not_supported",
    modelAccess: "not_supported",
    probeVersion: ADMIN_PROVIDER_COMPATIBILITY_PROBE_VERSION,
    streaming: "not_supported",
    structuredOutput: "not_supported",
    usage: "not_supported"
  };
}
