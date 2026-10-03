import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../../observability";
import { executeGovernedMemoryStructuredOutput, type GovernedMemoryStructuredOutputInput } from "../execution";
import { memoryMaintenancePlan, type MemoryMaintenanceSource } from "./policy";
import { createPrismaMemoryMaintenanceProvider } from "./provider";

vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(),
  logEvent: vi.fn()
}));
vi.mock("../execution", async (importOriginal) => ({
  ...await importOriginal<typeof import("../execution")>(),
  executeGovernedMemoryStructuredOutput: vi.fn()
}));

function source(ref: string): MemoryMaintenanceSource {
  return { ref, factId: `fact-${ref}`, versionId: `version-${ref}`, statement: `Synthetic statement ${ref}.`, category: "other",
    modality: "STATE", confidence: 0.6, usefulness: null, observedAt: new Date("2026-09-01"), evidence: [],
    evidenceThrough: new Date("2026-09-01"), sourceSnapshotHash: ref.at(-1)!.repeat(64) };
}
const plan = memoryMaintenancePlan(["S1", "S2", "S3"].map(source));
const owner = { userId: "owner", jobId: "job-1" };
const signal = new AbortController().signal;
const decision = (source_ref: string, scope_basis: string, action: string, usefulness: string | null, reason: string,
  contradicted_by: string | null = null) => ({ source_ref, scope_basis, action, usefulness, reason, contradicted_by });
const exactRemoval = decision("S1", "single_episode", "REMOVE_TRANSIENT", null, "episode");
/** Offers each answer in turn to the call's own decoder until one decodes, as
 * the governed executor's validation retries do, and accepts that one. */
function answers(...outputs: unknown[]): void {
  vi.mocked(executeGovernedMemoryStructuredOutput).mockImplementation((async (input: GovernedMemoryStructuredOutputInput<unknown>) => {
    let rejected: unknown = new Error("no_answer");
    for (const output of outputs) {
      try {
        const value = input.decode(output);
        return { acceptedOutputHash: "a".repeat(64), bindingId: "binding", classifiedAt: new Date(), inputHash: input.inputHash,
          modelId: "model", policyVersion: input.versions.policyVersion, providerId: "provider", value };
      } catch (error) { rejected = error; }
    }
    throw rejected;
  }) as typeof executeGovernedMemoryStructuredOutput);
}
const relatedMemory = { ref: "S2M1", factId: "fact-explicit", versionId: "version-explicit",
  statement: "I always want complete code with every fix applied.", observedAt: new Date("2026-09-15") };
/** `related` attaches related memories by source ref; `statements` holds the
 * current statement of each related version, as revalidation reads it. */
function provider(options: Readonly<{ related?: ReadonlyMap<string, readonly (typeof relatedMemory)[]>;
  statements?: ReadonlyMap<string, Readonly<{ factId: string; versionId: string; statement: string; observedAt: Date | null }>> }> = {}) {
  const loaded = { sources: new Map(plan.sources.map((item) => [item.versionId, item])), blockers: new Map() };
  return createPrismaMemoryMaintenanceProvider({} as PrismaClient, { provider: { run: vi.fn() }, sources: async () => loaded,
    related: async () => options.related ?? new Map(), relatedStatements: async () => options.statements ?? new Map() });
}

beforeEach(() => { vi.mocked(logEvent).mockReset(); });

describe("maintenance review repair counters", () => {
  it("logs content-free counts of the accepted answer's repaired decisions only", async () => {
    answers(
      // Rejected: its normalized first decision must not be counted.
      { decisions: [decision("S1", "general_personal", "KEEP", "ONGOING", "useful_personal_context"),
        decision("S2", "general_personal", "KEEP", "EPISODIC", "useful_personal_context"), exactRemoval] },
      { decisions: [exactRemoval, decision("S2", "general_personal", "KEEP", null, "useful_personal_context"),
        decision("S3", "general_personal", "REMOVE_TRANSIENT", null, "short_term")] });
    const review = await provider().review(plan, signal, owner);
    expect(review.output.decisions.map(({ sourceRef, action, usefulness }) => [sourceRef, action, usefulness]))
      .toEqual([["S1", "REMOVE_TRANSIENT", null], ["S2", "KEEP", "DURABLE"], ["S3", "KEEP", null]]);
    expect(vi.mocked(logEvent).mock.calls).toEqual([
      ["service_operation", { subsystem: "memory", stage: "validate", outcome: "completed",
        code: "memory_maintenance_labels_normalized", count: 1, job_id: "job-1" }],
      ["service_operation", { subsystem: "memory", stage: "validate", outcome: "degraded",
        code: "memory_maintenance_contradictions_kept", count: 1, job_id: "job-1" }]
    ]);
  });
  it("logs nothing for an exact review, a rejected one or the verifier", async () => {
    const exact = { decisions: [exactRemoval, decision("S2", "general_personal", "KEEP", "DURABLE", "useful_personal_context"),
      decision("S3", "unresolved_scope", "KEEP", null, "useful_personal_context")] };
    answers(exact);
    const review = await provider().review(plan, signal, owner);
    answers({ decisions: [] });
    await expect(provider().review(plan, signal, owner)).rejects.toThrow("memory_maintenance_output_invalid");
    answers({ decisions: [{ source_ref: "S1", approve: true }] });
    await provider().verify(plan, [plan.sources[0]!], { decisions: review.output.decisions.slice(0, 1) }, signal, owner);
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("maintenance review with related memories", () => {
  const current = new Map([[relatedMemory.versionId, { ...relatedMemory }]]);
  const contradiction = decision("S2", "general_personal", "REMOVE_TRANSIENT", null, "contradicted", "S2M1");
  it("shows each source's related memories and binds a contradiction to the exact memory it names", async () => {
    answers({ decisions: [exactRemoval, contradiction, decision("S3", "unresolved_scope", "KEEP", null, "useful_personal_context")] });
    const review = await provider({ related: new Map([["S2", [relatedMemory]]]), statements: current }).review(plan, signal, owner);
    const input = vi.mocked(executeGovernedMemoryStructuredOutput).mock.calls.at(-1)![0];
    expect(JSON.parse(input.request.userPrompt).sources[1].related_memories).toEqual([{ ref: "S2M1",
      statement: relatedMemory.statement, observed_at: "2026-09-15T00:00:00.000Z" }]);
    expect(input.request.userPrompt).not.toContain("version-explicit");
    // The related memories stay outside the reviewed plan's identity.
    expect(input.inputHash).toBe(review.inputHash);
    expect(review.output.decisions[1]).toEqual({ sourceRef: "S2", scopeBasis: "general_personal", action: "REMOVE_TRANSIENT",
      usefulness: null, reason: "contradicted", contradictedBy: { ref: "S2M1", factId: "fact-explicit", versionId: "version-explicit" } });
  });
  it("discloses no related memory that changed, was forgotten or lost its authority since it was read", async () => {
    for (const statements of [new Map(), new Map([[relatedMemory.versionId, { ...relatedMemory, statement: "Edited." }]]),
      new Map([[relatedMemory.versionId, { ...relatedMemory, factId: "fact-other" }]])]) {
      vi.mocked(executeGovernedMemoryStructuredOutput).mockClear();
      await expect(provider({ related: new Map([["S2", [relatedMemory]]]), statements }).review(plan, signal, owner))
        .rejects.toThrow(expect.objectContaining({ name: "MemoryJobFencedError", code: "memory_maintenance_dispatch_stale" }));
      expect(executeGovernedMemoryStructuredOutput).not.toHaveBeenCalled();
      // The verifier revalidates the related memory disclosed with a contradiction the same way.
      const disclosed = [{ ...plan.sources[1]!, related: [relatedMemory] }];
      await expect(provider({ statements }).verify(plan, disclosed, { decisions: [] }, signal, owner))
        .rejects.toThrow(expect.objectContaining({ name: "MemoryJobFencedError", code: "memory_maintenance_dispatch_stale" }));
      expect(executeGovernedMemoryStructuredOutput).not.toHaveBeenCalled();
    }
  });
});
