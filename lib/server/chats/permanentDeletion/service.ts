import { randomUUID } from "node:crypto";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryDeletionState
} from "../../../contracts/memory";
import type {
  MemoryConsumerPermanentChatDeleteInput,
  MemoryConsumerPermanentChatDeleteResponse
} from "../../../contracts/memoryClient";
import type {
  ChatPermanentDeleteAdmissionResponse,
  ChatPermanentDeleteAuthorizationRequest,
  ChatPermanentDeleteAuthorizationResponse,
  ChatPermanentDeleteRequest,
  ChatPermanentDeleteStatusResponse
} from "./internalContract";
import type {
  MemoryMutationAuthorizationMint,
  MemoryMutationAuthorizationUse
} from "../../memory/persistence/authorizations";
import {
  MEMORY_MUTATION_AUTHORIZATION_TTL_MS,
  memoryMutationNonceHash
} from "../../memory/persistence/authorizations";
import { MemoryPersistenceError } from "../../memory/persistence/errors";
import { permanentChatDeletionPayloadHash } from "./contract";

export type PermanentChatDeletionCapability = Readonly<{ enabled: boolean }>;

export type PermanentChatDeletionSnapshot = Readonly<{
  activeLeafMessageId: string | null;
  activeRunCount: number;
  memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  sourceRevision: number;
}>;

export type PermanentChatDeletionAdmission = Readonly<{
  deletionId: string;
  fencedAt: Date;
  state: MemoryDeletionState;
}>;

export type PermanentChatDeletionStatus = Readonly<{
  attemptCount: number;
  deletionId: string;
  errorCode: string | null;
  fencedAt: Date;
  lastAuditAt: Date | null;
  state: MemoryDeletionState;
  updatedAt: Date;
}>;

export type PermanentChatDeletionRepository = Readonly<{
  admit(input: Readonly<{
    alsoForgetOriginMemories: boolean;
    authorization: MemoryMutationAuthorizationUse & Readonly<{ requestId: string }>;
    chatId: string;
    expectedActiveLeafMessageId: string | null;
    expectedChatRevision: number;
    now: Date;
    userId: string;
  }>): Promise<
    | Readonly<{ kind: "active_run" | "not_found" | "stale" | "temporary" }>
    | Readonly<{ admission: PermanentChatDeletionAdmission; kind: "ok" }>
  >;
  readSnapshot(input: Readonly<{
    chatId: string;
    userId: string;
  }>): Promise<PermanentChatDeletionSnapshot | null>;
  latestStatus(input: Readonly<{
    chatId: string;
    userId: string;
  }>): Promise<PermanentChatDeletionStatus | null>;
  status(input: Readonly<{
    chatId: string;
    deletionId: string;
    userId: string;
  }>): Promise<PermanentChatDeletionStatus | null>;
}>;

export type PermanentChatDeletionAuthorizationRepository = Readonly<{
  mint(
    userId: string,
    input: MemoryMutationAuthorizationMint,
    now?: Date
  ): Promise<Readonly<{ expiresAt: Date; id: string }>>;
  resolveForUse(
    userId: string,
    input: MemoryMutationAuthorizationUse
  ): Promise<Readonly<{ confirmedAt: Date; requestId: string }>>;
}>;

export type PermanentChatDeletionErrorCode =
  | "active_run_in_progress"
  | "chat_not_found"
  | "chat_permanent_delete_authorization_invalid"
  | "chat_permanent_delete_failed"
  | "chat_permanent_delete_stale"
  | "chat_permanent_delete_temporary_forbidden"
  | "chat_permanent_delete_unavailable";

export class PermanentChatDeletionError extends Error {
  constructor(readonly code: PermanentChatDeletionErrorCode) {
    super(code);
    this.name = "PermanentChatDeletionError";
  }
}

function fail(code: PermanentChatDeletionErrorCode): never {
  throw new PermanentChatDeletionError(code);
}

function mapPersistenceError(error: unknown): never {
  if (
    error instanceof MemoryPersistenceError &&
    error.code === "memory_mutation_authorization_invalid"
  ) {
    return fail("chat_permanent_delete_authorization_invalid");
  }
  return fail("chat_permanent_delete_failed");
}

function assertCapability(capability: PermanentChatDeletionCapability): void {
  if (!capability.enabled) fail("chat_permanent_delete_unavailable");
}

function assertCurrentSnapshot(
  snapshot: PermanentChatDeletionSnapshot | null,
  input: Readonly<{
    expectedActiveLeafMessageId: string | null;
    expectedChatRevision: number;
  }>
): asserts snapshot is PermanentChatDeletionSnapshot {
  if (!snapshot) fail("chat_not_found");
  if (snapshot.memoryMode === "TEMPORARY") {
    fail("chat_permanent_delete_temporary_forbidden");
  }
  if (
    snapshot.sourceRevision !== input.expectedChatRevision ||
    snapshot.activeLeafMessageId !== input.expectedActiveLeafMessageId
  ) {
    fail("chat_permanent_delete_stale");
  }
  if (snapshot.activeRunCount > 0) fail("active_run_in_progress");
}

function serializeAdmission(
  admission: PermanentChatDeletionAdmission
): ChatPermanentDeleteAdmissionResponse {
  return {
    deletionId: admission.deletionId,
    fencedAt: admission.fencedAt.toISOString(),
    state: admission.state
  };
}

function consumerStatus(
  state: MemoryDeletionState
): MemoryConsumerPermanentChatDeleteResponse["status"] {
  if (state === "SUCCEEDED") return "COMPLETE";
  if (state === "BLOCKED_REQUIRES_ADMIN" || state === "CANCELLED") {
    return "NEEDS_ATTENTION";
  }
  return "IN_PROGRESS";
}

export function createPermanentChatDeletionService(input: Readonly<{
  authorizationRepository: PermanentChatDeletionAuthorizationRepository;
  capability: PermanentChatDeletionCapability;
  kick: () => void;
  now?: () => Date;
  repository: PermanentChatDeletionRepository;
}>) {
  const now = input.now ?? (() => new Date());
  async function admitInternal(
    userId: string,
    chatId: string,
    request: ChatPermanentDeleteRequest
  ): Promise<ChatPermanentDeleteAdmissionResponse> {
    assertCapability(input.capability);
    const authorization: MemoryMutationAuthorizationUse = {
      action: "BULK_DELETE",
      authorizationId: request.mutationAuthorizationId,
      authorizedPayloadHash: permanentChatDeletionPayloadHash({ chatId, ...request })
    };
    let resolved: Readonly<{ requestId: string }>;
    try {
      resolved = await input.authorizationRepository.resolveForUse(userId, authorization);
    } catch (error) {
      return mapPersistenceError(error);
    }
    let result: Awaited<ReturnType<PermanentChatDeletionRepository["admit"]>>;
    try {
      result = await input.repository.admit({
        alsoForgetOriginMemories: request.alsoForgetOriginMemories,
        authorization: { ...authorization, requestId: resolved.requestId },
        chatId,
        expectedActiveLeafMessageId: request.expectedActiveLeafMessageId,
        expectedChatRevision: request.expectedChatRevision,
        now: now(),
        userId
      });
    } catch (error) {
      return mapPersistenceError(error);
    }
    if (result.kind !== "ok") {
      switch (result.kind) {
        case "not_found": fail("chat_not_found");
        case "stale": fail("chat_permanent_delete_stale");
        case "temporary": fail("chat_permanent_delete_temporary_forbidden");
        case "active_run": fail("active_run_in_progress");
      }
    }
    input.kick();
    return serializeAdmission(result.admission);
  }
  return Object.freeze({
    async confirm(
      userId: string,
      chatId: string,
      request: MemoryConsumerPermanentChatDeleteInput
    ): Promise<MemoryConsumerPermanentChatDeleteResponse> {
      assertCapability(input.capability);
      const snapshot = await input.repository.readSnapshot({ chatId, userId });
      if (!snapshot) fail("chat_not_found");
      if (snapshot.memoryMode === "TEMPORARY") {
        fail("chat_permanent_delete_temporary_forbidden");
      }
      if (snapshot.activeRunCount > 0) fail("active_run_in_progress");
      const issuedAt = now();
      const authorizationRequest: ChatPermanentDeleteAuthorizationRequest = {
        alsoForgetOriginMemories: request.alsoForgetOriginMemories,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedActiveLeafMessageId: snapshot.activeLeafMessageId,
        expectedChatRevision: snapshot.sourceRevision,
        requestNonce: request.requestId
      };
      let authorization: Readonly<{ expiresAt: Date; id: string }>;
      try {
        authorization = await input.authorizationRepository.mint(userId, {
          action: "BULK_DELETE",
          authorizedPayloadHash: permanentChatDeletionPayloadHash({
            chatId,
            ...authorizationRequest
          }),
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expiresAt: new Date(issuedAt.getTime() + MEMORY_MUTATION_AUTHORIZATION_TTL_MS),
          nonceHash: memoryMutationNonceHash(userId, request.requestId),
          requestId: randomUUID()
        }, issuedAt);
      } catch (error) {
        return mapPersistenceError(error);
      }
      const admission = await admitInternal(userId, chatId, {
        alsoForgetOriginMemories: request.alsoForgetOriginMemories,
        expectedActiveLeafMessageId: snapshot.activeLeafMessageId,
        expectedChatRevision: snapshot.sourceRevision,
        mutationAuthorizationId: authorization.id
      });
      return { status: consumerStatus(admission.state) };
    },

    async mintAuthorization(
      userId: string,
      chatId: string,
      request: ChatPermanentDeleteAuthorizationRequest
    ): Promise<ChatPermanentDeleteAuthorizationResponse> {
      assertCapability(input.capability);
      const snapshot = await input.repository.readSnapshot({ chatId, userId });
      assertCurrentSnapshot(snapshot, request);
      const issuedAt = now();
      try {
        const authorization = await input.authorizationRepository.mint(userId, {
          action: "BULK_DELETE",
          authorizedPayloadHash: permanentChatDeletionPayloadHash({ chatId, ...request }),
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expiresAt: new Date(issuedAt.getTime() + MEMORY_MUTATION_AUTHORIZATION_TTL_MS),
          nonceHash: memoryMutationNonceHash(userId, request.requestNonce),
          requestId: randomUUID()
        }, issuedAt);
        return {
          expiresAt: authorization.expiresAt.toISOString(),
          mutationAuthorizationId: authorization.id
        };
      } catch (error) {
        return mapPersistenceError(error);
      }
    },

    async admit(
      userId: string,
      chatId: string,
      request: ChatPermanentDeleteRequest
    ): Promise<ChatPermanentDeleteAdmissionResponse> {
      return admitInternal(userId, chatId, request);
    },

    async status(
      userId: string,
      chatId: string,
      deletionId: string
    ): Promise<ChatPermanentDeleteStatusResponse> {
      const status = await input.repository.status({ chatId, deletionId, userId });
      if (!status) fail("chat_not_found");
      return {
        attemptCount: status.attemptCount,
        cleanupComplete: status.state === "SUCCEEDED",
        deletionId: status.deletionId,
        errorCode: status.errorCode,
        fencedAt: status.fencedAt.toISOString(),
        lastAuditAt: status.lastAuditAt?.toISOString() ?? null,
        state: status.state,
        updatedAt: status.updatedAt.toISOString()
      };
    },

    async consumerStatus(
      userId: string,
      chatId: string
    ): Promise<MemoryConsumerPermanentChatDeleteResponse> {
      const status = await input.repository.latestStatus({ chatId, userId });
      if (!status) fail("chat_not_found");
      return { status: consumerStatus(status.state) };
    }
  });
}

export type PermanentChatDeletionService = ReturnType<
  typeof createPermanentChatDeletionService
>;
