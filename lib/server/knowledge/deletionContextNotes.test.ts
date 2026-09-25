import { describe, expect, it } from "vitest";
import type { ContextSummary } from "../../contracts/contextCompaction";
import { decodeConversationContextPolicy } from "../runs/contextCompactionContract";
import { parseToolLoopCheckpoint } from "../runs/toolLoopPersistence";
import {
  contextNotesDescendantRunIds,
  withoutCarriedContextNotes,
  withoutCheckpointContextNotes,
  type ContextNotesRun
} from "./deletionContextNotes";

const digest = (seed: string) => seed.repeat(64).slice(0, 64);
const notes: ContextSummary = { formatVersion: 1, id: `cs1_${"a".repeat(32)}`,
  notes: "Private excerpt digest.", sourceDigest: digest("b"), sourceRefs: [`tor1_${"c".repeat(32)}`] };
const policy = { mode: "hybrid", source: { digest: digest("d"), leafMessageId: "u2", messageCount: 3 }, version: 1 };
const checkpoint = {
  answerRoundUsage: [],
  contextCompaction: {
    branchId: "u2", followupDigest: digest("e"), followupRevision: 0,
    measurement: { afterTokens: 10, beforeTokens: 20, budgetTokens: 100, legacyFallback: false,
      maskedBatches: 0, maskedObservations: 0, outcome: "already_fits", version: 1 },
    observationRefs: [`tor1_${"c".repeat(32)}`], ownerId: "user-1", pinDigest: digest("f"),
    policyRevision: "hybrid-v1", providerProjectionRevision: 1, recentTailCallIds: [], runId: "run-1",
    sourceDigest: digest("d"), summary: notes,
    summaryAttempts: [{ attempt: 1, bindingDigest: digest("1"), id: "csa1_x", sourceDigest: notes.sourceDigest,
      state: "committed", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }],
    version: 1
  },
  phase: "provider_running",
  providerContinuation: { providerResponseId: null, providerToolMessages: [] },
  providerCursor: null,
  roundIndex: 1,
  version: 2
};

describe("Knowledge deletion context notes scrub", () => {
  it("drops carried and committed notes, keeps content-free receipts, and still decodes", () => {
    const request = { contextCompactionPolicy: { ...policy, reuse: { coveredMessageId: "u1", runId: "run-0", summary: notes } },
      modelId: "model" };
    const scrubbedRequest = withoutCarriedContextNotes(request) as typeof request;
    expect(JSON.stringify(scrubbedRequest)).not.toContain("Private excerpt digest");
    expect(scrubbedRequest.modelId).toBe("model");
    expect(decodeConversationContextPolicy(scrubbedRequest.contextCompactionPolicy)).toEqual(policy);

    const scrubbedState = withoutCheckpointContextNotes(checkpoint);
    expect(JSON.stringify(scrubbedState)).not.toContain("Private excerpt digest");
    const decoded = parseToolLoopCheckpoint(scrubbedState);
    // An absent summary decodes as "no summary"; usage receipts remain.
    expect(decoded?.contextCompaction?.summary).toBeUndefined();
    expect(decoded?.contextCompaction?.summaryAttempts).toEqual(checkpoint.contextCompaction.summaryAttempts);
    expect(decoded?.contextCompaction?.measurement).toEqual(checkpoint.contextCompaction.measurement);
  });

  it("is idempotent and leaves values without notes untouched", () => {
    const once = withoutCheckpointContextNotes(checkpoint);
    expect(withoutCheckpointContextNotes(once)).toBe(once);
    expect(withoutCarriedContextNotes({ contextCompactionPolicy: policy })).toEqual({ contextCompactionPolicy: policy });
    for (const value of [null, "text", [], { contextCompaction: null }]) {
      expect(withoutCheckpointContextNotes(value)).toBe(value);
      expect(withoutCarriedContextNotes(value)).toBe(value);
    }
  });

  it("follows carried and re-summarized notes to descendant runs only", () => {
    const run = (id: string, reuseRunId: string | null, reuseSummaryId: string | null, summaryId: string | null): ContextNotesRun =>
      ({ id, reuseRunId, reuseSummaryId, summaryId });
    const runs = [
      // An unrelated earlier run whose notes the affected run merely carried.
      run("earlier", null, null, "n-earlier"),
      run("affected", "earlier", "n-earlier", "n-affected"),
      // Carried the affected run's notes, then bought notes derived from them.
      run("child", "affected", "n-affected", "n-child"),
      // Carried the child's derived notes.
      run("grandchild", "child", "n-child", "n-child"),
      // Holds the same derived notes without a recorded reuse link.
      run("copy", null, null, "n-child"),
      // Carried only the unrelated earlier notes.
      run("sibling", "earlier", "n-earlier", "n-earlier")
    ];
    expect(contextNotesDescendantRunIds({ affectedRunIds: ["affected"], runs })).toEqual(["child", "copy", "grandchild"]);
    // A pass-through of carried notes adds no derived identity.
    expect(contextNotesDescendantRunIds({ affectedRunIds: ["affected"],
      runs: [run("earlier", null, null, "n-earlier"), run("affected", "earlier", "n-earlier", "n-earlier"),
        run("sibling", "earlier", "n-earlier", "n-earlier")] })).toEqual([]);
    expect(contextNotesDescendantRunIds({ affectedRunIds: [], runs })).toEqual([]);
  });
});
