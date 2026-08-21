import type { MemorySearchItemType } from "@prisma/client";
import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  getSecretEncryptionKey
} from "../../secrets/envelope";

export const MEMORY_CLIENT_REF_TTL_MS = 24 * 60 * 60 * 1_000;
export const MEMORY_CLIENT_REF_MAX_LENGTH = 2_048;

export const MEMORY_CLIENT_REF_OPERATIONS = [
  "EDIT",
  "FORGET",
  "NOT_RELEVANT",
  "OPEN_SOURCE"
] as const;

export type MemoryClientRefOperation =
  (typeof MEMORY_CLIENT_REF_OPERATIONS)[number];

export type MemoryClientRefTarget = Readonly<{
  exactItemId: string;
  factId: string | null;
  factVersionId: string | null;
  itemType: MemorySearchItemType;
  recallChunkId: string | null;
  sourceChatId: string | null;
  sourceMessageIds: readonly string[];
}>;

export type MemoryClientRefPayload = Readonly<{
  allowedOperations: readonly MemoryClientRefOperation[];
  expiresAt: string;
  originatingRunId: string;
  target: MemoryClientRefTarget;
  version: 1;
}>;

export type MemoryClientRefService = Readonly<{
  mint(
    userId: string,
    input: Readonly<{
      allowedOperations: readonly MemoryClientRefOperation[];
      originatingRunId: string;
      target: MemoryClientRefTarget;
    }>,
    now?: Date
  ): string;
  resolve(
    userId: string,
    ref: string,
    operation: MemoryClientRefOperation,
    now?: Date
  ): MemoryClientRefPayload | null;
}>;

const TOKEN_PREFIX = "mr1.";
const ENVELOPE_CONTEXT = Object.freeze({
  purpose: "personal-memory-client-ref",
  valueId: "v1"
});
const operationSet = new Set<string>(MEMORY_CLIENT_REF_OPERATIONS);

function boundedIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
    value.trim() !== value) return false;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x21 || point === 0x7f) return false;
  }
  return true;
}

function validOperations(
  value: unknown
): value is readonly MemoryClientRefOperation[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 4 &&
    new Set(value).size === value.length && value.every((entry) =>
      typeof entry === "string" && operationSet.has(entry));
}

function validTarget(value: unknown): value is MemoryClientRefTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  if (Object.keys(target).length !== 7 ||
    !boundedIdentifier(target.exactItemId) ||
    (target.itemType !== "FACT_VERSION" && target.itemType !== "RECALL_CHUNK") ||
    !(target.factVersionId === null || boundedIdentifier(target.factVersionId)) ||
    !(target.factId === null || boundedIdentifier(target.factId)) ||
    !(target.recallChunkId === null || boundedIdentifier(target.recallChunkId)) ||
    !(target.sourceChatId === null || boundedIdentifier(target.sourceChatId)) ||
    !Array.isArray(target.sourceMessageIds) || target.sourceMessageIds.length > 50 ||
    !target.sourceMessageIds.every(boundedIdentifier)) return false;
  return target.itemType === "FACT_VERSION"
    ? target.factId !== null && target.factVersionId === target.exactItemId &&
      target.recallChunkId === null
    : target.factId === null && target.recallChunkId === target.exactItemId &&
      target.factVersionId === null;
}

function decodePayload(value: unknown): MemoryClientRefPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 5 || payload.version !== 1 ||
    !validOperations(payload.allowedOperations) ||
    typeof payload.expiresAt !== "string" || payload.expiresAt.length > 64 ||
    !Number.isFinite(Date.parse(payload.expiresAt)) ||
    !boundedIdentifier(payload.originatingRunId) || !validTarget(payload.target)) {
    return null;
  }
  return {
    allowedOperations: Object.freeze([...payload.allowedOperations]),
    expiresAt: payload.expiresAt,
    originatingRunId: payload.originatingRunId,
    target: Object.freeze({
      ...payload.target,
      sourceMessageIds: Object.freeze([...payload.target.sourceMessageIds])
    }),
    version: 1
  };
}

export function createMemoryClientRefService(input: Readonly<{
  encryptionKey?: () => Buffer;
}> = {}): MemoryClientRefService {
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;
  return Object.freeze({
    mint(userId, value, now = new Date()) {
      if (!boundedIdentifier(userId) || !boundedIdentifier(value.originatingRunId) ||
        !validOperations(value.allowedOperations) || !validTarget(value.target) ||
        !Number.isFinite(now.getTime())) throw new Error("memory_client_ref_invalid");
      const payload: MemoryClientRefPayload = {
        allowedOperations: Object.freeze([...value.allowedOperations]),
        expiresAt: new Date(now.getTime() + MEMORY_CLIENT_REF_TTL_MS).toISOString(),
        originatingRunId: value.originatingRunId,
        target: value.target,
        version: 1
      };
      const envelope = encryptSecretEnvelope(payload, encryptionKey(), {
        ...ENVELOPE_CONTEXT,
        ownerId: userId
      });
      const ref = `${TOKEN_PREFIX}${envelope}`;
      if (ref.length > MEMORY_CLIENT_REF_MAX_LENGTH) {
        throw new Error("memory_client_ref_invalid");
      }
      return ref;
    },

    resolve(userId, ref, operation, now = new Date()) {
      if (!boundedIdentifier(userId) || typeof ref !== "string" ||
        ref.length > MEMORY_CLIENT_REF_MAX_LENGTH || !ref.startsWith(TOKEN_PREFIX) ||
        !operationSet.has(operation) || !Number.isFinite(now.getTime())) return null;
      try {
        const payload = decodePayload(decryptSecretEnvelope<unknown>(
          ref.slice(TOKEN_PREFIX.length),
          encryptionKey(),
          { ...ENVELOPE_CONTEXT, ownerId: userId }
        ));
        return payload && Date.parse(payload.expiresAt) > now.getTime() &&
          payload.allowedOperations.includes(operation)
          ? payload
          : null;
      } catch {
        return null;
      }
    }
  });
}

export const defaultMemoryClientRefService = createMemoryClientRefService();
