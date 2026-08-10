import type { MemoryEgressConsentMode } from "../../../contracts/memory";

export type { MemoryEgressConsentMode } from "../../../contracts/memory";

export const MEMORY_EGRESS_CONSENT_MODE_ENV = "AIQSA_MEMORY_EGRESS_CONSENT_MODE";

/**
 * ADMIN is the product default. A malformed explicit override falls back to
 * PER_USER so an operator typo cannot silently relax an intended consent
 * boundary.
 */
export function resolveMemoryEgressConsentMode(
  environment: Readonly<Record<string, string | undefined>> = process.env
): MemoryEgressConsentMode {
  const configured = environment[MEMORY_EGRESS_CONSENT_MODE_ENV]?.trim();
  if (!configured) return "ADMIN";
  return configured === "ADMIN" || configured === "PER_USER"
    ? configured
    : "PER_USER";
}
