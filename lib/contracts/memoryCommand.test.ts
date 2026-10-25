import { describe, expect, it } from "vitest";
import {
  decodeMemoryCommandFeedback, decodeMemoryCommandListResponse, memoryCommandIsPending, memoryCommandSaveNotCommitted
} from "./memoryCommand";

const feedback = { commandRef: "opaque-command-ref", operation: "UNKNOWN", status: "PENDING", updatedAt: "2026-09-28T12:00:00.000Z" } as const;

describe("background Memory command projection", () => {
  it("accepts content-free progress independently of an answer", () => {
    expect(decodeMemoryCommandFeedback(feedback)).toEqual(feedback);
    expect(memoryCommandIsPending(feedback)).toBe(true);
    expect(decodeMemoryCommandListResponse({ commands: [{ feedback, messageId: "message-1" }] })).not.toBeNull();
  });

  it.each(["PENDING", "RUNNING", "COMMITTED", "REJECTED", "AMBIGUOUS", "FAILED", "UNKNOWN", "STALE"])(
    "never exposes proposed or previous content for %s", (status) => {
      const current = { ...feedback, operation: "UPDATE", status };
      expect(decodeMemoryCommandFeedback(current)).not.toBeNull();
      for (const key of ["statement", "candidate", "memoryRef", "targetId", "error", "providerOutput"]) {
        expect(decodeMemoryCommandFeedback({ ...current, [key]: "private-sentinel" })).toBeNull();
      }
    }
  );

  it("requires a known mutation for a committed outcome", () => {
    expect(decodeMemoryCommandFeedback({ ...feedback, status: "COMMITTED" })).toBeNull();
    expect(decodeMemoryCommandFeedback({ ...feedback, operation: "SAVE", status: "AMBIGUOUS" })).toBeNull();
    expect(decodeMemoryCommandFeedback({ ...feedback, status: "SUCCEEDED" })).toBeNull();
  });

  it("derives a save that committed nothing only from a resolved SAVE", () => {
    for (const status of ["REJECTED", "FAILED", "UNKNOWN", "STALE"] as const) {
      expect(memoryCommandSaveNotCommitted({ ...feedback, operation: "SAVE", status })).toBe(true);
      for (const operation of ["UNKNOWN", "UPDATE", "FORGET"] as const) {
        expect(memoryCommandSaveNotCommitted({ ...feedback, operation, status })).toBe(false);
      }
    }
    for (const status of ["PENDING", "RUNNING", "COMMITTED"] as const) {
      expect(memoryCommandSaveNotCommitted({ ...feedback, operation: "SAVE", status })).toBe(false);
    }
  });
});
