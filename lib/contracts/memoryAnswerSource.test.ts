import { describe, expect, it } from "vitest";
import {
  decodeMemoryActionFeedback,
  decodeMemoryAnswerSource,
  decodeMemorySourceActionInput,
  decodeMemorySourceActionResponse
} from "./memoryClient";

const source = {
  actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
  date: "2026-08-21T05:00:00.000Z",
  memoryRef: "opaque-memory-ref",
  sourceAvailable: true,
  sourceType: "SAVED_MEMORY",
  text: "I prefer concise answers."
} as const;

describe("Memory answer-source contracts", () => {
  it("does not carry rejected statement content into the browser", () => {
    expect(decodeMemoryActionFeedback({ operation: "SAVE", status: "REJECTED" }))
      .toMatchObject({ ok: true });
    expect(decodeMemoryActionFeedback({
      operation: "SAVE",
      statement: "content that was rejected",
      status: "REJECTED"
    })).toMatchObject({ ok: false });
  });

  it("keeps answer sources consumer-safe while retaining the opaque ref only in the decoded value", () => {
    expect(decodeMemoryAnswerSource(source)).toEqual({ ok: true, value: source });
    expect(decodeMemoryAnswerSource({ ...source, score: 0.98 })).toMatchObject({ ok: false });
    expect(decodeMemoryAnswerSource({ ...source, factId: "private-fact" })).toMatchObject({ ok: false });
    expect(decodeMemoryAnswerSource({ ...source, origin: "Server-localized copy" }))
      .toMatchObject({ ok: false });
    expect(decodeMemoryAnswerSource({ ...source, actions: ["CORRECT", "CORRECT"] })).toMatchObject({
      ok: false
    });
    const unavailable = {
      actions: [],
      date: source.date,
      sourceAvailable: false,
      sourceType: source.sourceType
    } as const;
    expect(decodeMemoryAnswerSource(unavailable)).toEqual({ ok: true, value: unavailable });
    expect(decodeMemoryAnswerSource({
      ...unavailable,
      memoryRef: source.memoryRef,
      text: "forgotten private source text"
    })).toMatchObject({ ok: false });
    expect(decodeMemoryAnswerSource({
      ...source,
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      origin: "A chat title",
      sourceType: "PAST_CHAT"
    })).toMatchObject({ ok: true });
  });

  it("accepts only the bounded source-action request and response shapes", () => {
    expect(decodeMemorySourceActionInput({
      action: "CORRECT",
      memoryRef: source.memoryRef,
      requestNonce: "request-nonce",
      statement: "A corrected statement."
    })).toMatchObject({ ok: true });
    expect(decodeMemorySourceActionInput({
      action: "FORGET",
      memoryRef: source.memoryRef,
      requestNonce: "request-nonce",
      factId: "private-fact"
    })).toMatchObject({ ok: false });
    expect(decodeMemorySourceActionResponse({ status: "COMMITTED" })).toMatchObject({ ok: true });
    expect(decodeMemorySourceActionResponse({
      href: "/api/me/memory/source-actions/open?memoryRef=opaque-memory-ref",
      status: "READY"
    }))
      .toMatchObject({ ok: true });
    expect(decodeMemorySourceActionResponse({ href: "/?chat=source", status: "READY" }))
      .toMatchObject({ ok: false });
    expect(decodeMemorySourceActionResponse({ href: "/?chat=source", status: "READY", memoryRef: source.memoryRef }))
      .toMatchObject({ ok: false });
    for (const href of [
      "https://example.com/api/me/memory/source-actions/open?memoryRef=opaque-memory-ref",
      "//example.com/api/me/memory/source-actions/open?memoryRef=opaque-memory-ref",
      "/api/me/memory/source-actions/open?memoryRef=opaque-memory-ref&debug=1",
      "/api/me/memory/source-actions/open?memoryRef=opaque-memory-ref#source"
    ]) {
      expect(decodeMemorySourceActionResponse({ href, status: "READY" }))
        .toMatchObject({ ok: false });
    }
  });
});
