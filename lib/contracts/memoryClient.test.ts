import { describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  decodeMemoryAnswerSource,
  decodeMemoryConsumerPermanentChatDeleteInput,
  decodeMemoryConsumerPermanentChatDeleteResponse
} from "./memoryClient";

describe("Memory client-only contracts", () => {
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

  it("requires the complete source-action set for an available past-chat source", () => {
    const source = {
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      date: "2026-08-21T05:00:00.000Z",
      memoryRef: "opaque-ref",
      origin: "Previous discussion",
      sourceAvailable: true,
      sourceType: "PAST_CHAT",
      text: "The earlier discussion chose the cedar deployment."
    } as const;

    expect(decodeMemoryAnswerSource(source)).toEqual({ ok: true, value: source });
    expect(decodeMemoryAnswerSource({
      ...source,
      actions: ["NOT_RELEVANT", "OPEN_SOURCE"]
    })).toMatchObject({ ok: false });
  });
});
