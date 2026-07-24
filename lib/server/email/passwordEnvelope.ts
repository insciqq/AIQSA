import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  type SecretEnvelopeContext
} from "../secrets/envelope";
import { normalizeSmtpPassword } from "./definitions";

export const SMTP_CONTROL_OWNER_ID = "installation-smtp";
export const SMTP_PASSWORD_PURPOSE = "smtp_password";

const MAX_SECRET_GENERATION = 2_147_483_647;
const MAX_ENVELOPE_BYTES = 64 * 1_024;

type StoredSmtpPassword = {
  password: string;
  version: 1;
};

export type SmtpPasswordReference = {
  envelope: string;
  generation: number;
};

export type SmtpPasswordAction =
  | { kind: "clear"; confirm: true }
  | { kind: "preserve" }
  | { kind: "replace"; password: string };

export type SmtpPasswordEnvelopeErrorCode =
  | "smtp_password_action_invalid"
  | "smtp_password_reference_invalid";

export class SmtpPasswordEnvelopeError extends Error {
  readonly code: SmtpPasswordEnvelopeErrorCode;

  constructor(code: SmtpPasswordEnvelopeErrorCode) {
    super(code);
    this.code = code;
    this.name = "SmtpPasswordEnvelopeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function normalizeGeneration(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_SECRET_GENERATION) {
    throw new SmtpPasswordEnvelopeError("smtp_password_reference_invalid");
  }
  return value as number;
}

function context(generation: number): SecretEnvelopeContext {
  return {
    ownerId: SMTP_CONTROL_OWNER_ID,
    purpose: SMTP_PASSWORD_PURPOSE,
    valueId: String(normalizeGeneration(generation))
  };
}

function normalizeReference(value: SmtpPasswordReference | null): SmtpPasswordReference | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["envelope", "generation"]) ||
    typeof value.envelope !== "string" ||
    !value.envelope ||
    Buffer.byteLength(value.envelope, "utf8") > MAX_ENVELOPE_BYTES
  ) {
    throw new SmtpPasswordEnvelopeError("smtp_password_reference_invalid");
  }
  return {
    envelope: value.envelope,
    generation: normalizeGeneration(value.generation)
  };
}

export function normalizeSmtpPasswordAction(value: unknown): SmtpPasswordAction {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new SmtpPasswordEnvelopeError("smtp_password_action_invalid");
  }
  if (value.kind === "preserve" && hasOnlyKeys(value, ["kind"])) {
    return { kind: "preserve" };
  }
  if (value.kind === "clear" && value.confirm === true && hasOnlyKeys(value, ["confirm", "kind"])) {
    return { confirm: true, kind: "clear" };
  }
  if (value.kind === "replace" && hasOnlyKeys(value, ["kind", "password"])) {
    try {
      return { kind: "replace", password: normalizeSmtpPassword(value.password) };
    } catch {
      throw new SmtpPasswordEnvelopeError("smtp_password_action_invalid");
    }
  }
  throw new SmtpPasswordEnvelopeError("smtp_password_action_invalid");
}

export function encryptSmtpPassword(input: {
  generation: number;
  key: Buffer;
  password: unknown;
}): string {
  const password = normalizeSmtpPassword(input.password);
  return encryptSecretEnvelope(
    { password, version: 1 } satisfies StoredSmtpPassword,
    input.key,
    context(input.generation)
  );
}

export function decryptSmtpPassword(input: {
  envelope: string;
  generation: number;
  key: Buffer;
}): string {
  const reference = normalizeReference({
    envelope: input.envelope,
    generation: input.generation
  });
  if (!reference) {
    throw new SmtpPasswordEnvelopeError("smtp_password_reference_invalid");
  }
  const stored = decryptSecretEnvelope<StoredSmtpPassword>(
    reference.envelope,
    input.key,
    context(reference.generation)
  );
  if (!isRecord(stored) || !hasOnlyKeys(stored, ["password", "version"]) || stored.version !== 1) {
    throw new SmtpPasswordEnvelopeError("smtp_password_reference_invalid");
  }
  try {
    return normalizeSmtpPassword(stored.password);
  } catch {
    throw new SmtpPasswordEnvelopeError("smtp_password_reference_invalid");
  }
}

export function applySmtpPasswordAction(input: {
  action: unknown;
  current: SmtpPasswordReference | null;
  key?: Buffer;
  replacementGeneration?: number;
}): SmtpPasswordReference | null {
  const action = normalizeSmtpPasswordAction(input.action);
  const current = normalizeReference(input.current);

  if (action.kind === "preserve") {
    return current;
  }
  if (action.kind === "clear") {
    return null;
  }
  if (typeof input.replacementGeneration === "undefined") {
    throw new SmtpPasswordEnvelopeError("smtp_password_reference_invalid");
  }
  if (!input.key) {
    throw new SmtpPasswordEnvelopeError("smtp_password_reference_invalid");
  }
  const generation = normalizeGeneration(input.replacementGeneration);
  if (current && generation <= current.generation) {
    throw new SmtpPasswordEnvelopeError("smtp_password_reference_invalid");
  }
  return {
    envelope: encryptSmtpPassword({
      generation,
      key: input.key,
      password: action.password
    }),
    generation
  };
}
