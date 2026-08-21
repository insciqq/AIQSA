import { describe, expect, it } from "vitest";
import {
  decodeChatPermanentDeleteAdmissionResponse,
  decodeChatPermanentDeleteAuthorizationRequest,
  decodeChatPermanentDeleteAuthorizationResponse,
  decodeChatPermanentDeleteRequest,
  decodeChatPermanentDeleteStatusResponse
} from "./internalContract";

describe("server-only permanent chat deletion contract", () => {
  it("strictly decodes internal authorization and admission values", () => {
    const authorizationRequest = {
      alsoForgetOriginMemories: false,
      confirmationCopyVersion: "memory-confirmation-v1",
      expectedActiveLeafMessageId: "message-1",
      expectedChatRevision: 7,
      requestNonce: "nonce-1"
    };
    expect(decodeChatPermanentDeleteAuthorizationRequest(authorizationRequest))
      .toEqual(authorizationRequest);
    expect(decodeChatPermanentDeleteAuthorizationRequest({
      ...authorizationRequest,
      eraseBackups: true
    })).toBeNull();

    const admissionRequest = {
      alsoForgetOriginMemories: true,
      expectedActiveLeafMessageId: null,
      expectedChatRevision: 0,
      mutationAuthorizationId: "authorization-1"
    };
    expect(decodeChatPermanentDeleteRequest(admissionRequest)).toEqual(admissionRequest);
    expect(decodeChatPermanentDeleteRequest({
      ...admissionRequest,
      expectedChatRevision: -1
    })).toBeNull();

    expect(decodeChatPermanentDeleteAuthorizationResponse({
      expiresAt: "2026-08-12T12:05:00.000Z",
      mutationAuthorizationId: "authorization-1"
    })).not.toBeNull();
    expect(decodeChatPermanentDeleteAdmissionResponse({
      deletionId: "deletion-1",
      fencedAt: "2026-08-12T12:00:00.000Z",
      state: "PENDING"
    })).not.toBeNull();
  });

  it("keeps internal worker status strict and content-free", () => {
    const status = {
      attemptCount: 2,
      cleanupComplete: true,
      deletionId: "deletion-1",
      errorCode: null,
      fencedAt: "2026-08-12T12:00:00.000Z",
      lastAuditAt: "2026-08-12T12:01:00.000Z",
      state: "SUCCEEDED",
      updatedAt: "2026-08-12T12:01:00.000Z"
    };
    expect(decodeChatPermanentDeleteStatusResponse(status)).toEqual(status);
    expect(decodeChatPermanentDeleteStatusResponse({
      ...status,
      cleanupComplete: false
    })).toBeNull();
    expect(decodeChatPermanentDeleteStatusResponse({
      ...status,
      privateText: "must never be returned"
    })).toBeNull();
  });
});
