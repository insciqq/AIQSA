import { describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_RESUME_DISCLOSURE_COPY_VERSION,
  MEMORY_RETIRED_RESUME_DISCLOSURE_COPY_VERSION,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
  decodeMemoryConsumerChatModePatch,
  decodeMemoryConsumerChatModeResponse,
  decodeMemoryInitialChatMode,
  decodeMemoryConsumerPermanentChatDeleteInput,
  decodeMemoryConsumerPermanentChatDeleteResponse
} from "./memoryClient";

describe("chat Memory-mode client contracts", () => {
  it("accepts a locked chat mode only as Excluded without a Resume action", () => {
    const locked = { allowedActions: [], archived: false, lockedReason: "IMPORTED", mode: "EXCLUDED", temporaryRetentionDeadline: null };
    expect(decodeMemoryConsumerChatModeResponse(locked)).toEqual({ ok: true, value: locked });
    expect(decodeMemoryConsumerChatModeResponse({ ...locked, allowedActions: ["RESUME"] })).toMatchObject({ ok: false });
    expect(decodeMemoryConsumerChatModeResponse({ ...locked, allowedActions: ["EXCLUDE"], mode: "NORMAL" }))
      .toMatchObject({ ok: false });
    expect(decodeMemoryConsumerChatModeResponse({ ...locked, lockedReason: "OTHER" })).toMatchObject({ ok: false });
    const { lockedReason: _lockedReason, ...unlocked } = locked;
    expect(decodeMemoryConsumerChatModeResponse(unlocked)).toMatchObject({ ok: false });
    expect(decodeMemoryConsumerChatModeResponse({ ...unlocked, allowedActions: ["RESUME"] })).toMatchObject({ ok: true });
  });

  it("keeps permanent chat deletion confirmation and status consumer-safe", () => {
    const confirmation = {
      alsoForgetOriginMemories: false,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestId: "request-1"
    };
    expect(decodeMemoryConsumerPermanentChatDeleteInput(confirmation))
      .toEqual({ ok: true, value: confirmation });
    expect(decodeMemoryConsumerPermanentChatDeleteInput({
      ...confirmation,
      expectedChatRevision: 4
    })).toMatchObject({ ok: false });
    expect(decodeMemoryConsumerPermanentChatDeleteInput({
      ...confirmation,
      mutationAuthorizationId: "private-authorization"
    })).toMatchObject({ ok: false });

    expect(decodeMemoryConsumerPermanentChatDeleteResponse({ status: "IN_PROGRESS" }))
      .toMatchObject({ ok: true });
    for (const internal of [
      { deletionId: "private-deletion", status: "IN_PROGRESS" },
      { attemptCount: 1, status: "IN_PROGRESS" },
      { errorCode: "private-worker-error", status: "NEEDS_ATTENTION" },
      { state: "RUNNING", status: "IN_PROGRESS" }
    ]) {
      expect(decodeMemoryConsumerPermanentChatDeleteResponse(internal))
        .toMatchObject({ ok: false });
    }
  });

  it("decodes a Resume under the current or the retired disclosure, so the retired one can be refused visibly", () => {
    expect(decodeMemoryConsumerChatModePatch({ mode: "NORMAL", resumeDisclosureCopyVersion: MEMORY_RESUME_DISCLOSURE_COPY_VERSION }))
      .toEqual({ ok: true, value: { mode: "NORMAL", resumeDisclosureCopyVersion: MEMORY_RESUME_DISCLOSURE_COPY_VERSION } });
    // What a v0.4.43 page sends: it promised only new messages, and the server refuses it before changing the chat.
    expect(decodeMemoryConsumerChatModePatch({ mode: "NORMAL", resumeDisclosureCopyVersion: "memory-confirmation-v1" }))
      .toEqual({ ok: true, value: { mode: "NORMAL", resumeDisclosureCopyVersion: MEMORY_RETIRED_RESUME_DISCLOSURE_COPY_VERSION } });
    expect(MEMORY_RESUME_DISCLOSURE_COPY_VERSION).not.toBe(MEMORY_RETIRED_RESUME_DISCLOSURE_COPY_VERSION);
    for (const invalid of [
      { mode: "NORMAL" },
      { mode: "NORMAL", resumeDisclosureCopyVersion: "memory-resume-later" },
      { mode: "EXCLUDED", resumeDisclosureCopyVersion: MEMORY_RESUME_DISCLOSURE_COPY_VERSION },
      { mode: "TEMPORARY" }
    ]) {
      expect(decodeMemoryConsumerChatModePatch(invalid)).toMatchObject({ ok: false });
    }
    expect(decodeMemoryConsumerChatModePatch({ mode: "EXCLUDED" })).toEqual({ ok: true, value: { mode: "EXCLUDED" } });
  });

  it("accepts a new chat's Temporary mode only under the current retention policy", () => {
    expect(decodeMemoryInitialChatMode({ chatMode: "NORMAL" })).toMatchObject({ ok: true });
    expect(decodeMemoryInitialChatMode({
      chatMode: "TEMPORARY",
      temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
    })).toMatchObject({ ok: true });
    expect(decodeMemoryInitialChatMode({
      chatMode: "TEMPORARY",
      temporaryRetentionPolicyVersion: "temporary-later"
    })).toMatchObject({ ok: false });
    expect(decodeMemoryInitialChatMode({ chatMode: "EXCLUDED" })).toMatchObject({ ok: false });
  });
});
