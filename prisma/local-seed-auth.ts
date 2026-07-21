import { hashPassword, verifyPassword } from "../lib/server/auth/password";

export const LOCAL_OPERATOR_EMAIL = "operator@aiqsa.local";
export const LOCAL_OPERATOR_PASSWORD = "AIQSA-local-2026!";

type LocalSeedEnvironment = {
  APP_ENV?: string;
  NODE_ENV?: string;
};

export function isLocalSeedRuntime(env: LocalSeedEnvironment = process.env): boolean {
  return env.APP_ENV === "local" && env.NODE_ENV?.trim().toLowerCase() !== "production";
}

export function assertLocalSeedRuntime(env: LocalSeedEnvironment = process.env): void {
  if (!isLocalSeedRuntime(env)) {
    throw new Error("AIQSA demo seed requires APP_ENV=local and refuses NODE_ENV=production");
  }
}

export async function ensureLocalOperatorPasswordHash(existingHash: string | null | undefined): Promise<string> {
  if (existingHash) {
    try {
      if (await verifyPassword(LOCAL_OPERATOR_PASSWORD, existingHash)) {
        return existingHash;
      }
    } catch {
      // Replace malformed or obsolete local hashes with the documented local credential.
    }
  }

  return hashPassword(LOCAL_OPERATOR_PASSWORD);
}
