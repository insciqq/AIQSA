import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryClientRefService, MEMORY_CLIENT_REF_TTL_MS } from "./clientRef";

const key = randomBytes(32);
const service = createMemoryClientRefService({ encryptionKey: () => key });
const now = new Date("2026-08-21T05:00:00.000Z");

describe("Memory client refs", () => {
  it("round-trips an owner-bound fact target without exposing raw identifiers", () => {
    const ref = service.mint("user-1", {
      allowedOperations: ["EDIT", "FORGET"],
      originatingRunId: "run-1",
      target: {
        exactItemId: "version-private-1",
        factId: "fact-private-1",
        factVersionId: "version-private-1",
        itemType: "FACT_VERSION",
        recallChunkId: null,
        recallRoundId: null,
        sourceChatId: null,
        sourceMessageIds: []
      }
    }, now);
    expect(ref).not.toContain("version-private-1");
    expect(service.resolve("user-1", ref, "EDIT", now)).toMatchObject({
      originatingRunId: "run-1",
      target: { factVersionId: "version-private-1" }
    });
    expect(service.resolve("other-user", ref, "EDIT", now)).toBeNull();
    expect(service.resolve("user-1", ref, "NOT_RELEVANT", now)).toBeNull();
  });

  it("expires and rejects tampered refs", () => {
    const ref = service.mint("user-1", {
      allowedOperations: ["NOT_RELEVANT", "OPEN_SOURCE"],
      originatingRunId: "run-1",
      target: {
        exactItemId: "chunk-1",
        factId: null,
        factVersionId: null,
        itemType: "RECALL_CHUNK",
        recallChunkId: "chunk-1",
        recallRoundId: null,
        sourceChatId: "chat-1",
        sourceMessageIds: ["message-1"]
      }
    }, now);
    expect(service.resolve("user-1", `${ref.slice(0, -1)}x`, "OPEN_SOURCE", now))
      .toBeNull();
    expect(service.resolve("user-1", ref, "OPEN_SOURCE",
      new Date(now.getTime() + MEMORY_CLIENT_REF_TTL_MS))).toBeNull();
  });
});
