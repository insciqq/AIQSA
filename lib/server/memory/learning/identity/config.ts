import {
  MEMORY_DEFAULT_IDENTITY_PROFILE,
  type MemoryIdentityProfile
} from "./normalization";

export const MEMORY_IDENTITY_WRITE_PROFILE_ENV =
  "AIQSA_MEMORY_IDENTITY_WRITE_PROFILE";

/** Only Unicode may be selected for future admissions. Recorded jobs retain
 * their original profile independently of this deployment setting. */
export function loadMemoryIdentityWriteProfile(
  environment: Readonly<Record<string, string | undefined>> = process.env
): MemoryIdentityProfile {
  const configured = environment[MEMORY_IDENTITY_WRITE_PROFILE_ENV]?.trim();
  if (!configured) return MEMORY_DEFAULT_IDENTITY_PROFILE;
  if (configured !== MEMORY_DEFAULT_IDENTITY_PROFILE) {
    throw new Error("memory_identity_profile_environment_invalid");
  }
  return configured as MemoryIdentityProfile;
}
