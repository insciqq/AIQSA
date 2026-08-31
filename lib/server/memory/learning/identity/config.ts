import {
  MEMORY_IDENTITY_PROFILES,
  type MemoryIdentityProfile
} from "./normalization";

export const MEMORY_IDENTITY_WRITE_PROFILE_ENV =
  "AIQSA_MEMORY_IDENTITY_WRITE_PROFILE";

/** Deployment-scoped activation switch. The selected profile is captured in
 * every extraction input, while both namespaces remain readable. */
export function loadMemoryIdentityWriteProfile(
  environment: Readonly<Record<string, string | undefined>> = process.env
): MemoryIdentityProfile {
  const configured = environment[MEMORY_IDENTITY_WRITE_PROFILE_ENV]?.trim();
  if (!configured) return "LEGACY_V1";
  if (!(MEMORY_IDENTITY_PROFILES as readonly string[]).includes(configured)) {
    throw new Error("memory_identity_profile_environment_invalid");
  }
  return configured as MemoryIdentityProfile;
}
