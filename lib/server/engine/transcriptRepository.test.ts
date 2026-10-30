import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createTranscriptRepository } from "./transcriptRepository";
import { unknownEffectsOf } from "./unknownEffects";

const at = (ms: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, 0, ms));

describe("transcript hydration for the unknown-effect fence", () => {
  it("hydrate a resultless continuation's attempt: its in-flight marker is fenced from the continuation's durable attempt", async () => {
    // The earlier run's call (recorded at 0) and the approval continuation's in-flight marker (100) in its own run; the
    // continuation sent the call at 200 and ended at 300 with no result saved.
    const findAttempts = vi.fn(async () => [{ completedAt: at(300), modelRunId: "continuation-run", providerCallId: "call-1",
      startedAt: at(200) }]);
    const client = {
      modelRunToolCall: { findMany: findAttempts },
      runTranscriptItem: { findMany: vi.fn(async () => [
        { body: { arguments: '{"title":"x"}', name: "create" }, callId: "call-1", createdAt: at(0), id: "call", kind: "tool_call",
          modelRunId: "earlier-run" },
        { body: { inFlight: true, name: "create", outcome: "unknown", output: "Sent after the approval." }, callId: "call-1",
          createdAt: at(100), id: "marker", kind: "tool_result", modelRunId: "continuation-run" }
      ]) }
    } as unknown as PrismaClient;
    const loaded = await createTranscriptRepository(client).loadRuns({ chatId: "chat", runIds: ["earlier-run", "continuation-run"],
      userId: "user" });
    expect(findAttempts).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ providerCallId: { in: ["call-1"] },
      subagentThreadId: null }) }));
    const items = [...loaded.get("earlier-run")!, ...loaded.get("continuation-run")!];
    expect(items[1]).toMatchObject({ inFlight: true, recordedAt: at(300) });
    // An exact approval decided at 150 is older than the fence, so it cannot authorize another dispatch.
    expect(unknownEffectsOf(items, () => false).find({ arguments: { title: "x" }, name: "create" })?.after).toEqual(at(300));
  });
});
