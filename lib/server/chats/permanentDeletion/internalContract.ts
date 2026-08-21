import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_DELETION_STATES,
  type MemoryDeletionState
} from "../../../contracts/memory";

export type ChatPermanentDeleteAuthorizationRequest = Readonly<{
  alsoForgetOriginMemories: boolean;
  confirmationCopyVersion: typeof MEMORY_CONFIRMATION_COPY_VERSION;
  expectedActiveLeafMessageId: string | null;
  expectedChatRevision: number;
  requestNonce: string;
}>;

export type ChatPermanentDeleteAuthorizationResponse = Readonly<{
  expiresAt: string;
  mutationAuthorizationId: string;
}>;

export type ChatPermanentDeleteRequest = Readonly<{
  alsoForgetOriginMemories: boolean;
  expectedActiveLeafMessageId: string | null;
  expectedChatRevision: number;
  mutationAuthorizationId: string;
}>;

export type ChatPermanentDeleteAdmissionResponse = Readonly<{
  deletionId: string;
  fencedAt: string;
  state: MemoryDeletionState;
}>;

export type ChatPermanentDeleteStatusResponse = Readonly<{
  attemptCount: number;
  cleanupComplete: boolean;
  deletionId: string;
  errorCode: string | null;
  fencedAt: string;
  lastAuditAt: string | null;
  state: MemoryDeletionState;
  updatedAt: string;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function nullableLeaf(value: unknown): string | null | undefined {
  return value === null ? null : boundedString(value, 256) ?? undefined;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function deletionState(value: unknown): MemoryDeletionState | null {
  return typeof value === "string" &&
    (MEMORY_DELETION_STATES as readonly string[]).includes(value)
    ? value as MemoryDeletionState
    : null;
}

export function decodeChatPermanentDeleteAuthorizationRequest(
  value: unknown
): ChatPermanentDeleteAuthorizationRequest | null {
  if (!record(value) || !exactKeys(value, [
    "alsoForgetOriginMemories",
    "confirmationCopyVersion",
    "expectedActiveLeafMessageId",
    "expectedChatRevision",
    "requestNonce"
  ])) return null;
  const expectedActiveLeafMessageId = nullableLeaf(value.expectedActiveLeafMessageId);
  const expectedChatRevision = nonNegativeInteger(value.expectedChatRevision);
  const requestNonce = boundedString(value.requestNonce, 256);
  if (
    typeof value.alsoForgetOriginMemories !== "boolean" ||
    value.confirmationCopyVersion !== MEMORY_CONFIRMATION_COPY_VERSION ||
    expectedActiveLeafMessageId === undefined ||
    expectedChatRevision === null ||
    !requestNonce
  ) return null;
  return {
    alsoForgetOriginMemories: value.alsoForgetOriginMemories,
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    expectedActiveLeafMessageId,
    expectedChatRevision,
    requestNonce
  };
}

export function decodeChatPermanentDeleteRequest(
  value: unknown
): ChatPermanentDeleteRequest | null {
  if (!record(value) || !exactKeys(value, [
    "alsoForgetOriginMemories",
    "expectedActiveLeafMessageId",
    "expectedChatRevision",
    "mutationAuthorizationId"
  ])) return null;
  const expectedActiveLeafMessageId = nullableLeaf(value.expectedActiveLeafMessageId);
  const expectedChatRevision = nonNegativeInteger(value.expectedChatRevision);
  const mutationAuthorizationId = boundedString(value.mutationAuthorizationId, 256);
  if (
    typeof value.alsoForgetOriginMemories !== "boolean" ||
    expectedActiveLeafMessageId === undefined ||
    expectedChatRevision === null ||
    !mutationAuthorizationId
  ) return null;
  return {
    alsoForgetOriginMemories: value.alsoForgetOriginMemories,
    expectedActiveLeafMessageId,
    expectedChatRevision,
    mutationAuthorizationId
  };
}

export function decodeChatPermanentDeleteAuthorizationResponse(
  value: unknown
): ChatPermanentDeleteAuthorizationResponse | null {
  if (!record(value) || !exactKeys(value, ["expiresAt", "mutationAuthorizationId"])) {
    return null;
  }
  const expiresAt = isoTimestamp(value.expiresAt);
  const mutationAuthorizationId = boundedString(value.mutationAuthorizationId, 256);
  return expiresAt && mutationAuthorizationId
    ? { expiresAt, mutationAuthorizationId }
    : null;
}

export function decodeChatPermanentDeleteAdmissionResponse(
  value: unknown
): ChatPermanentDeleteAdmissionResponse | null {
  if (!record(value) || !exactKeys(value, ["deletionId", "fencedAt", "state"])) {
    return null;
  }
  const deletionId = boundedString(value.deletionId, 256);
  const fencedAt = isoTimestamp(value.fencedAt);
  const state = deletionState(value.state);
  return deletionId && fencedAt && state ? { deletionId, fencedAt, state } : null;
}

export function decodeChatPermanentDeleteStatusResponse(
  value: unknown
): ChatPermanentDeleteStatusResponse | null {
  if (!record(value) || !exactKeys(value, [
    "attemptCount",
    "cleanupComplete",
    "deletionId",
    "errorCode",
    "fencedAt",
    "lastAuditAt",
    "state",
    "updatedAt"
  ])) return null;
  const attemptCount = nonNegativeInteger(value.attemptCount);
  const deletionId = boundedString(value.deletionId, 256);
  const errorCode = value.errorCode === null
    ? null
    : boundedString(value.errorCode, 64) ?? undefined;
  const fencedAt = isoTimestamp(value.fencedAt);
  const lastAuditAt = value.lastAuditAt === null
    ? null
    : isoTimestamp(value.lastAuditAt) ?? undefined;
  const state = deletionState(value.state);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (
    attemptCount === null || !deletionId || errorCode === undefined || !fencedAt ||
    lastAuditAt === undefined || !state || !updatedAt ||
    typeof value.cleanupComplete !== "boolean" ||
    value.cleanupComplete !== (state === "SUCCEEDED")
  ) return null;
  return {
    attemptCount,
    cleanupComplete: value.cleanupComplete,
    deletionId,
    errorCode,
    fencedAt,
    lastAuditAt,
    state,
    updatedAt
  };
}
