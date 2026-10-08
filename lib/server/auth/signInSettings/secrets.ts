import {
  AUTH_SIGN_IN_METHOD_SCHEMAS,
  type AuthSignInMethod
} from "@/lib/contracts/authSignInMethods";
import type { AdminSignInSecretAction } from "@/lib/contracts/adminSignIn";
import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  type SecretEnvelopeContext
} from "../../secrets/envelope";

export const SIGN_IN_SECRET_OWNER_ID = "installation-auth-sign-in";

const MAX_SECRET_GENERATION = 2_147_483_647;
const MAX_SECRET_VALUE_LENGTH = 65_536;
const MAX_ENVELOPE_BYTES = 256 * 1_024;

type StoredSignInSecrets = {
  secrets: Record<string, string>;
  version: 1;
};

export type SignInSecretReference = {
  envelope: string;
  generation: number;
};

export class SignInSecretError extends Error {
  constructor(readonly code: "secret_action_invalid" | "secret_reference_invalid") {
    super(code);
    this.name = "SignInSecretError";
  }
}

/** Each method's secret envelope has its own purpose, so one method's ciphertext never opens as another's. */
export function signInSecretPurpose(method: AuthSignInMethod): string {
  return `auth-sign-in:${method}`;
}

/** The write-only fields a method keeps in its secret envelope. */
export function signInSecretFields(method: AuthSignInMethod): string[] {
  return Object.keys(AUTH_SIGN_IN_METHOD_SCHEMAS[method].secrets.shape).sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function generation(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_SECRET_GENERATION) {
    throw new SignInSecretError("secret_reference_invalid");
  }
  return value as number;
}

function context(method: AuthSignInMethod, valueGeneration: number): SecretEnvelopeContext {
  return {
    ownerId: SIGN_IN_SECRET_OWNER_ID,
    purpose: signInSecretPurpose(method),
    valueId: String(generation(valueGeneration))
  };
}

function secretAction(value: unknown): AdminSignInSecretAction {
  if (!isRecord(value) || typeof value.kind !== "string") throw new SignInSecretError("secret_action_invalid");
  if (value.kind === "preserve" && hasOnlyKeys(value, ["kind"])) return { kind: "preserve" };
  if (value.kind === "clear" && value.confirm === true && hasOnlyKeys(value, ["confirm", "kind"])) {
    return { confirm: true, kind: "clear" };
  }
  if (
    value.kind === "replace" &&
    hasOnlyKeys(value, ["kind", "value"]) &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    value.value.length <= MAX_SECRET_VALUE_LENGTH
  ) {
    return { kind: "replace", value: value.value };
  }
  throw new SignInSecretError("secret_action_invalid");
}

/** Validates the per-field actions of a draft save; fields the method has no secret for are refused. */
export function normalizeSignInSecretActions(
  method: AuthSignInMethod,
  value: unknown
): Record<string, AdminSignInSecretAction> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new SignInSecretError("secret_action_invalid");
  const fields = new Set(signInSecretFields(method));
  const actions: Record<string, AdminSignInSecretAction> = {};
  for (const [field, action] of Object.entries(value)) {
    if (!fields.has(field)) throw new SignInSecretError("secret_action_invalid");
    actions[field] = secretAction(action);
  }
  return actions;
}

/** The stored secrets after the actions: replace sets, clear removes, preserve or absence keeps. */
export function applySignInSecretActions(
  current: Readonly<Record<string, string>>,
  actions: Readonly<Record<string, AdminSignInSecretAction>>
): { changed: boolean; secrets: Record<string, string> } {
  const secrets = { ...current };
  let changed = false;
  for (const [field, action] of Object.entries(actions)) {
    if (action.kind === "replace") {
      changed ||= secrets[field] !== action.value;
      secrets[field] = action.value;
    } else if (action.kind === "clear" && field in secrets) {
      changed = true;
      delete secrets[field];
    }
  }
  return { changed, secrets };
}

export function encryptSignInSecrets(input: {
  generation: number;
  key: Buffer;
  method: AuthSignInMethod;
  secrets: Record<string, string>;
}): string {
  return encryptSecretEnvelope(
    { secrets: input.secrets, version: 1 } satisfies StoredSignInSecrets,
    input.key,
    context(input.method, input.generation)
  );
}

export function decryptSignInSecrets(input: {
  envelope: string;
  generation: number;
  key: Buffer;
  method: AuthSignInMethod;
}): Record<string, string> {
  if (!input.envelope || Buffer.byteLength(input.envelope, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new SignInSecretError("secret_reference_invalid");
  }
  const stored = decryptSecretEnvelope<StoredSignInSecrets>(
    input.envelope,
    input.key,
    context(input.method, input.generation)
  );
  if (!isRecord(stored) || !hasOnlyKeys(stored, ["secrets", "version"]) || stored.version !== 1 || !isRecord(stored.secrets)) {
    throw new SignInSecretError("secret_reference_invalid");
  }
  const fields = new Set(signInSecretFields(input.method));
  const secrets: Record<string, string> = {};
  for (const [field, value] of Object.entries(stored.secrets)) {
    if (!fields.has(field) || typeof value !== "string") throw new SignInSecretError("secret_reference_invalid");
    secrets[field] = value;
  }
  return secrets;
}

/** Reads a stored slot's secrets; an empty slot has none. */
export function readSignInSecretSlot(input: {
  envelope: string | null;
  generation: number | null;
  key: () => Buffer;
  method: AuthSignInMethod;
}): Record<string, string> {
  if (input.envelope === null && input.generation === null) return {};
  if (input.envelope === null || input.generation === null) throw new SignInSecretError("secret_reference_invalid");
  return decryptSignInSecrets({
    envelope: input.envelope,
    generation: input.generation,
    key: input.key(),
    method: input.method
  });
}
