import type { AuthSignInMethodSetting } from "@prisma/client";
import {
  AUTH_SIGN_IN_METHOD_SCHEMAS,
  AUTH_SIGN_IN_METHODS,
  type AuthSignInMethod,
  type AuthSignInMethodConfig,
  type AuthSignInMethodSecrets
} from "@/lib/contracts/authSignInMethods";
import { readSignInSecretSlot } from "./secrets";

/** One method an administrator activated, decoded for sign-in. */
export type ActiveSignInSetting = {
  activeVersion: number;
  method: AuthSignInMethod;
  /** Null when the stored configuration or secret cannot be used: the method stays off. */
  resolved: { config: AuthSignInMethodConfig; secrets: AuthSignInMethodSecrets } | null;
};

export function isAuthSignInMethod(value: unknown): value is AuthSignInMethod {
  return typeof value === "string" && AUTH_SIGN_IN_METHODS.some((method) => method === value);
}

/** Validates a stored configuration and its secrets against the method's contract. */
export function decodeSignInSlot(input: {
  config: unknown;
  key: () => Buffer;
  method: AuthSignInMethod;
  secretEnvelope: string | null;
  secretGeneration: number | null;
}):
  | { config: AuthSignInMethodConfig; ok: true; secrets: AuthSignInMethodSecrets }
  | { code: "invalid_configuration" | "secret_unreadable"; ok: false } {
  const schemas = AUTH_SIGN_IN_METHOD_SCHEMAS[input.method];
  const config = schemas.config.safeParse(input.config);
  if (input.config === null || !config.success) return { code: "invalid_configuration", ok: false };
  let stored: Record<string, string>;
  try {
    stored = readSignInSecretSlot({
      envelope: input.secretEnvelope,
      generation: input.secretGeneration,
      key: input.key,
      method: input.method
    });
  } catch {
    return { code: "secret_unreadable", ok: false };
  }
  const secrets = schemas.secrets.safeParse(stored);
  return secrets.success
    ? { config: config.data as AuthSignInMethodConfig, ok: true, secrets: secrets.data as AuthSignInMethodSecrets }
    : { code: "invalid_configuration", ok: false };
}

export function decodeActiveSignInSetting(
  row: AuthSignInMethodSetting,
  key: () => Buffer
): ActiveSignInSetting | null {
  if (!row.enabled || !isAuthSignInMethod(row.method)) return null;
  const decoded = decodeSignInSlot({
    config: row.activeConfig,
    key,
    method: row.method,
    secretEnvelope: row.activeSecretEnvelope,
    secretGeneration: row.activeSecretGeneration
  });
  return {
    activeVersion: row.activeVersion,
    method: row.method,
    resolved: decoded.ok ? { config: decoded.config, secrets: decoded.secrets } : null
  };
}

export type ActiveSignInSettingsCache = {
  get(): Promise<readonly ActiveSignInSetting[]>;
  /** Drops the cached snapshot; activation and disabling call it after they commit. */
  invalidate(): void;
};

/**
 * A short process-local snapshot of the active methods, so every login page and sign-in does
 * not decrypt each method again. AIQSA runs one application replica; the settings service
 * invalidates it on every activation and disable, and the TTL bounds anything else.
 */
export function createActiveSignInSettingsCache(input: {
  load(): Promise<readonly ActiveSignInSetting[]>;
  now?: () => number;
  ttlMs: number;
}): ActiveSignInSettingsCache {
  const now = input.now ?? Date.now;
  let generation = 0;
  let cached: { expiresAt: number; generation: number; value: Promise<readonly ActiveSignInSetting[]> } | null = null;

  return {
    get() {
      const at = now();
      if (cached && cached.generation === generation && cached.expiresAt > at) return cached.value;
      const loadGeneration = generation;
      const value = input.load();
      const entry = { expiresAt: at + input.ttlMs, generation: loadGeneration, value };
      cached = entry;
      // A failed load is never served from the cache.
      value.catch(() => {
        if (cached === entry) cached = null;
      });
      return value;
    },
    invalidate() {
      generation += 1;
      cached = null;
    }
  };
}
