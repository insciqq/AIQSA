import { describe, expect, it } from "vitest";
import {
  createKnowledgeFocusedRequest,
  decodeKnowledgeFocusedRequest,
  KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS
} from "./focusedRequest";

describe("KnowledgeFocusedRequestV1", () => {
  it("preserves RU/EN Unicode, quoted spans, filenames, identifiers, numbers, and dates", () => {
    const request = createKnowledgeFocusedRequest({
      currentUserMessage:
        "Что сказано в «Договор-№42.pdf» про API_ID=abc-7 на 2026-08-21?",
      previousUserMessage: "Compare the value 12.50% with разделом A/B."
    });

    expect(request).toEqual({
      candidateLimit: 40,
      fusion: "weighted_rrf_v2",
      neighborWindow: 1,
      originalQuery:
        "Что сказано в «Договор-№42.pdf» про API_ID=abc-7 на 2026-08-21?",
      resultLimit: 8,
      retrievalQuery:
        "Что сказано в «Договор-№42.pdf» про API_ID=abc-7 на 2026-08-21?\n\n" +
        "Compare the value 12.50% with разделом A/B.",
      version: 1
    });
  });

  it("keeps the current message first and appends only a bounded prefix of one previous message", () => {
    const request = createKnowledgeFocusedRequest({
      currentUserMessage: "current-marker",
      previousUserMessage: `old-marker-${"я".repeat(4_000)}`
    });

    expect(request).not.toBeNull();
    expect([...(request?.retrievalQuery ?? "")]).toHaveLength(
      KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS
    );
    expect(request?.retrievalQuery.startsWith("current-marker\n\nold-marker-")).toBe(true);
  });

  it("normalizes controls without translation, stemming, or stopword deletion", () => {
    const request = createKnowledgeFocusedRequest({
      currentUserMessage: "  The\tcontracts\u0000 и документы  "
    });

    expect(request?.retrievalQuery).toBe("The contracts и документы");
  });

  it("fails closed for an empty or mutated persisted request", () => {
    expect(createKnowledgeFocusedRequest({ currentUserMessage: "\u0000\t" })).toBeNull();
    const request = createKnowledgeFocusedRequest({ currentUserMessage: "question" });
    expect(decodeKnowledgeFocusedRequest(request)).toEqual(request);
    expect(decodeKnowledgeFocusedRequest({ ...request, resultLimit: 7 })).toBeNull();
    expect(decodeKnowledgeFocusedRequest({ ...request, extra: true })).toBeNull();
  });
});
