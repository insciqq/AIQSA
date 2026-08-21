import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  getSecretEncryptionKey
} from "../../secrets/envelope";

export const MEMORY_CONSUMER_REF_TTL_MS = 24 * 60 * 60 * 1_000;
export const MEMORY_CONSUMER_REF_MAX_LENGTH = 4_096;

export const MEMORY_CONSUMER_REF_OPERATIONS = ["EDIT", "FORGET"] as const;
export type MemoryConsumerRefOperation =
  (typeof MEMORY_CONSUMER_REF_OPERATIONS)[number];

type ItemPayload = Readonly<{
  allowedOperations: readonly MemoryConsumerRefOperation[];
  expiresAt: string;
  factId: string;
  factVersionId: string;
  kind: "ITEM";
  version: 1;
}>;

type CursorPayload = Readonly<{
  cursor: string;
  expiresAt: string;
  kind: "CURSOR";
  version: 1;
}>;

export type MemoryConsumerRefService = Readonly<{
  mintCursor(userId: string, cursor: string, now?: Date): string;
  mintItem(
    userId: string,
    input: Readonly<{
      allowedOperations: readonly MemoryConsumerRefOperation[];
      factId: string;
      factVersionId: string;
    }>,
    now?: Date
  ): string;
  resolveCursor(userId: string, ref: string, now?: Date): string | null;
  resolveItem(
    userId: string,
    ref: string,
    operation: MemoryConsumerRefOperation,
    now?: Date
  ): Readonly<{ factId: string; factVersionId: string }> | null;
}>;

const TOKEN_PREFIX = "mcm1.";
const ITEM_CONTEXT = Object.freeze({
  purpose: "personal-memory-consumer-item-ref",
  valueId: "v1"
});
const CURSOR_CONTEXT = Object.freeze({
  purpose: "personal-memory-consumer-cursor-ref",
  valueId: "v1"
});
const operationSet = new Set<string>(MEMORY_CONSUMER_REF_OPERATIONS);

function boundedIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
    value.trim() !== value) return false;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x21 || point === 0x7f) return false;
  }
  return true;
}

function boundedCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validOperations(
  value: unknown
): value is readonly MemoryConsumerRefOperation[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 2 &&
    new Set(value).size === value.length &&
    value.every((entry) => typeof entry === "string" && operationSet.has(entry));
}

function validExpiry(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    Number.isFinite(Date.parse(value));
}

function decodeItemPayload(value: unknown): ItemPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 6 || payload.kind !== "ITEM" ||
    payload.version !== 1 || !validOperations(payload.allowedOperations) ||
    !validExpiry(payload.expiresAt) || !boundedIdentifier(payload.factId) ||
    !boundedIdentifier(payload.factVersionId)) return null;
  return {
    allowedOperations: Object.freeze([...payload.allowedOperations]),
    expiresAt: payload.expiresAt,
    factId: payload.factId,
    factVersionId: payload.factVersionId,
    kind: "ITEM",
    version: 1
  };
}

function decodeCursorPayload(value: unknown): CursorPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 4 || payload.kind !== "CURSOR" ||
    payload.version !== 1 || !validExpiry(payload.expiresAt) ||
    !boundedCursor(payload.cursor)) return null;
  return {
    cursor: payload.cursor,
    expiresAt: payload.expiresAt,
    kind: "CURSOR",
    version: 1
  };
}

function validRef(value: string): boolean {
  return value.length > TOKEN_PREFIX.length &&
    value.length <= MEMORY_CONSUMER_REF_MAX_LENGTH &&
    value.startsWith(TOKEN_PREFIX) &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function encrypt(
  payload: ItemPayload | CursorPayload,
  key: Buffer,
  context: typeof ITEM_CONTEXT | typeof CURSOR_CONTEXT,
  userId: string
): string {
  const ref = `${TOKEN_PREFIX}${encryptSecretEnvelope(payload, key, {
    ...context,
    ownerId: userId
  })}`;
  if (ref.length > MEMORY_CONSUMER_REF_MAX_LENGTH) {
    throw new Error("memory_consumer_ref_invalid");
  }
  return ref;
}

export function createMemoryConsumerRefService(input: Readonly<{
  encryptionKey?: () => Buffer;
}> = {}): MemoryConsumerRefService {
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;
  return Object.freeze({
    mintCursor(userId, cursor, now = new Date()) {
      if (!boundedIdentifier(userId) || !boundedCursor(cursor) ||
        !Number.isFinite(now.getTime())) throw new Error("memory_consumer_ref_invalid");
      return encrypt({
        cursor,
        expiresAt: new Date(now.getTime() + MEMORY_CONSUMER_REF_TTL_MS).toISOString(),
        kind: "CURSOR",
        version: 1
      }, encryptionKey(), CURSOR_CONTEXT, userId);
    },

    mintItem(userId, value, now = new Date()) {
      if (!boundedIdentifier(userId) || !boundedIdentifier(value.factId) ||
        !boundedIdentifier(value.factVersionId) ||
        !validOperations(value.allowedOperations) || !Number.isFinite(now.getTime())) {
        throw new Error("memory_consumer_ref_invalid");
      }
      return encrypt({
        allowedOperations: Object.freeze([...value.allowedOperations]),
        expiresAt: new Date(now.getTime() + MEMORY_CONSUMER_REF_TTL_MS).toISOString(),
        factId: value.factId,
        factVersionId: value.factVersionId,
        kind: "ITEM",
        version: 1
      }, encryptionKey(), ITEM_CONTEXT, userId);
    },

    resolveCursor(userId, ref, now = new Date()) {
      if (!boundedIdentifier(userId) || !validRef(ref) ||
        !Number.isFinite(now.getTime())) return null;
      try {
        const payload = decodeCursorPayload(decryptSecretEnvelope<unknown>(
          ref.slice(TOKEN_PREFIX.length),
          encryptionKey(),
          { ...CURSOR_CONTEXT, ownerId: userId }
        ));
        return payload && Date.parse(payload.expiresAt) > now.getTime()
          ? payload.cursor
          : null;
      } catch {
        return null;
      }
    },

    resolveItem(userId, ref, operation, now = new Date()) {
      if (!boundedIdentifier(userId) || !validRef(ref) ||
        !operationSet.has(operation) || !Number.isFinite(now.getTime())) return null;
      try {
        const payload = decodeItemPayload(decryptSecretEnvelope<unknown>(
          ref.slice(TOKEN_PREFIX.length),
          encryptionKey(),
          { ...ITEM_CONTEXT, ownerId: userId }
        ));
        return payload && Date.parse(payload.expiresAt) > now.getTime() &&
          payload.allowedOperations.includes(operation)
          ? { factId: payload.factId, factVersionId: payload.factVersionId }
          : null;
      } catch {
        return null;
      }
    }
  });
}

export const defaultMemoryConsumerRefService = createMemoryConsumerRefService();
