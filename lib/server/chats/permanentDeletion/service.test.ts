import { describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import {
  createPermanentChatDeletionService,
  type PermanentChatDeletionStatus
} from "./service";

const NOW = new Date("2026-08-12T12:00:00.000Z");

function dependencies(enabled = true) {
  const authorizationRepository = {
    mint: vi.fn(async () => ({
      expiresAt: new Date("2026-08-12T12:05:00.000Z"),
      id: "authorization-1"
    })),
    resolveForUse: vi.fn(async () => ({ confirmedAt: NOW, requestId: "request-1" }))
  };
  const repository = {
    admit: vi.fn(async () => ({
      admission: { deletionId: "deletion-1", fencedAt: NOW, state: "PENDING" as const },
      kind: "ok" as const
    })),
    latestStatus: vi.fn(async (): Promise<PermanentChatDeletionStatus | null> => ({
      attemptCount: 1,
      deletionId: "deletion-1",
      errorCode: null,
      fencedAt: NOW,
      lastAuditAt: NOW,
      state: "PENDING" as const,
      updatedAt: NOW
    })),
    readSnapshot: vi.fn(async () => ({
      activeLeafMessageId: "message-1",
      activeRunCount: 0,
      memoryMode: "NORMAL" as const,
      sourceRevision: 4
    })),
    status: vi.fn(async () => ({
      attemptCount: 1,
      deletionId: "deletion-1",
      errorCode: null,
      fencedAt: NOW,
      lastAuditAt: NOW,
      state: "SUCCEEDED" as const,
      updatedAt: NOW
    }))
  };
  const kick = vi.fn();
  return {
    authorizationRepository,
    kick,
    repository,
    service: createPermanentChatDeletionService({
      authorizationRepository,
      capability: { enabled },
      kick,
      now: () => NOW,
      repository
    })
  };
}

const authorizationRequest = {
  alsoForgetOriginMemories: false,
  confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
  expectedActiveLeafMessageId: "message-1",
  expectedChatRevision: 4,
  requestNonce: "nonce-1"
} as const;

describe("permanent chat deletion service", () => {
  it("authorizes and admits a safe confirmation from an authoritative snapshot", async () => {
    const deps = dependencies();
    await expect(deps.service.confirm("user-1", "chat-1", {
      alsoForgetOriginMemories: true,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestId: "consumer-request-1"
    })).resolves.toEqual({ status: "IN_PROGRESS" });
    expect(deps.repository.readSnapshot).toHaveBeenCalledWith({
      chatId: "chat-1",
      userId: "user-1"
    });
    expect(deps.authorizationRepository.mint).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
      }),
      NOW
    );
    expect(deps.repository.admit).toHaveBeenCalledWith(expect.objectContaining({
      alsoForgetOriginMemories: true,
      chatId: "chat-1",
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4,
      userId: "user-1"
    }));
  });

  it("projects worker state to a friendly chat-keyed status", async () => {
    const deps = dependencies();
    await expect(deps.service.consumerStatus("user-1", "chat-1"))
      .resolves.toEqual({ status: "IN_PROGRESS" });
    expect(deps.repository.latestStatus).toHaveBeenCalledWith({
      chatId: "chat-1",
      userId: "user-1"
    });
    deps.repository.latestStatus.mockResolvedValueOnce({
      attemptCount: 2,
      deletionId: "deletion-private",
      errorCode: "worker-private",
      fencedAt: NOW,
      lastAuditAt: NOW,
      state: "BLOCKED_REQUIRES_ADMIN",
      updatedAt: NOW
    });
    await expect(deps.service.consumerStatus("user-1", "chat-1"))
      .resolves.toEqual({ status: "NEEDS_ATTENTION" });
  });

  it("mints a short single-use authorization bound to chat, leaf, revision, and choice", async () => {
    const deps = dependencies();
    await expect(deps.service.mintAuthorization(
      "user-1",
      "chat-1",
      authorizationRequest
    )).resolves.toEqual({
      expiresAt: "2026-08-12T12:05:00.000Z",
      mutationAuthorizationId: "authorization-1"
    });
    expect(deps.authorizationRepository.mint).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expiresAt: new Date("2026-08-12T12:05:00.000Z")
      }),
      NOW
    );
  });

  it("admits exactly the authorized choice, kicks cleanup, and exposes no text", async () => {
    const deps = dependencies();
    const request = {
      alsoForgetOriginMemories: false,
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 4,
      mutationAuthorizationId: "authorization-1"
    } as const;
    await expect(deps.service.admit("user-1", "chat-1", request)).resolves.toEqual({
      deletionId: "deletion-1",
      fencedAt: NOW.toISOString(),
      state: "PENDING"
    });
    expect(deps.repository.admit).toHaveBeenCalledWith(expect.objectContaining({
      alsoForgetOriginMemories: false,
      authorization: expect.objectContaining({ requestId: "request-1" }),
      chatId: "chat-1",
      userId: "user-1"
    }));
    expect(deps.kick).toHaveBeenCalledOnce();
    await expect(deps.service.status("user-1", "chat-1", "deletion-1"))
      .resolves.toEqual({
        attemptCount: 1,
        cleanupComplete: true,
        deletionId: "deletion-1",
        errorCode: null,
        fencedAt: NOW.toISOString(),
        lastAuditAt: NOW.toISOString(),
        state: "SUCCEEDED",
        updatedAt: NOW.toISOString()
      });
  });

  it("is feature-dark without touching repositories", async () => {
    const deps = dependencies(false);
    await expect(deps.service.mintAuthorization(
      "user-1",
      "chat-1",
      authorizationRequest
    )).rejects.toMatchObject({ code: "chat_permanent_delete_unavailable" });
    expect(deps.repository.readSnapshot).not.toHaveBeenCalled();
    expect(deps.authorizationRepository.mint).not.toHaveBeenCalled();
  });

  it("keeps accepted cleanup status inspectable after admission rollback", async () => {
    const deps = dependencies(false);
    await expect(deps.service.status("user-1", "chat-1", "deletion-1"))
      .resolves.toMatchObject({ cleanupComplete: true, state: "SUCCEEDED" });
    expect(deps.repository.status).toHaveBeenCalledOnce();
  });

  it("rejects stale snapshots and active runs before minting", async () => {
    const deps = dependencies();
    deps.repository.readSnapshot.mockResolvedValueOnce({
      activeLeafMessageId: "message-2",
      activeRunCount: 0,
      memoryMode: "NORMAL",
      sourceRevision: 4
    });
    await expect(deps.service.mintAuthorization(
      "user-1",
      "chat-1",
      authorizationRequest
    )).rejects.toMatchObject({ code: "chat_permanent_delete_stale" });
    deps.repository.readSnapshot.mockResolvedValueOnce({
      activeLeafMessageId: "message-1",
      activeRunCount: 1,
      memoryMode: "NORMAL",
      sourceRevision: 4
    });
    await expect(deps.service.mintAuthorization(
      "user-1",
      "chat-1",
      authorizationRequest
    )).rejects.toMatchObject({ code: "active_run_in_progress" });
    expect(deps.authorizationRepository.mint).not.toHaveBeenCalled();
  });
});
