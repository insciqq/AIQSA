import { describe, expect, it } from "vitest";
import { MEMORY_LONG_TERM_USEFULNESS_GUIDANCE } from "../../../domain/memory/usefulness";
import { buildMemoryMaintenanceRequest, buildMemoryMaintenanceVerificationRequest,
  decodeMemoryMaintenanceOutput, decodeMemoryMaintenanceVerification } from "./contract";
import { memoryMaintenancePlan, type MemoryMaintenanceSource } from "./policy";

export const source: MemoryMaintenanceSource = {
  ref: "S1", factId: "fact-1", versionId: "version-1", statement: "The appointment is tomorrow.",
  category: "goals", modality: "PLAN", confidence: 0.6, usefulness: null,
  observedAt: new Date("2026-09-01"), evidenceThrough: new Date("2026-09-01"), sourceSnapshotHash: "a".repeat(64),
  evidence: [{ id: "e1", chatId: "chat-1", messageId: "m1", branchGeneration: 1, sourceTextHash: "b".repeat(64),
    startOffset: 0, endOffset: 32, quote: "The appointment is tomorrow.", observedAt: new Date("2026-09-01"), createdAt: new Date("2026-09-01") }]
};
const plan = memoryMaintenancePlan([source]);
const remove = { source_ref: "S1", scope_basis: "single_episode", action: "REMOVE_TRANSIENT", usefulness: null, reason: "episode" };

describe("governed automatic Memory maintenance", () => {
  it("keeps lasting utility independent of confidence and never keeps an episode", () => {
    for (const [usefulness, scope_basis] of [["DURABLE", "general_personal"], ["ONGOING", "ongoing_personal"]]) {
      expect(decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "KEEP", usefulness, reason: "useful_personal_context" }] }, plan)
        .decisions[0]).toMatchObject({ action: "KEEP", usefulness });
    }
    for (const scope_basis of ["significant_episode", "general_personal", "ongoing_personal", "explicit_remember", "unresolved_scope"]) {
      expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "KEEP",
        usefulness: "EPISODIC", reason: "useful_personal_context" }] }, plan)).toThrow("memory_maintenance_output_invalid");
    }
  });
  it("removes episodes, short-term matters and common habits only with their own reason", () => {
    const combinations = [["single_episode", "episode"], ["short_term_matter", "short_term"], ["common_habit", "not_distinctive"],
      ["current_task_only", "one_off_task_detail"], ["generic_desideratum", "one_off_task_detail"],
      ["context_fragment", "context_dependent_fragment"]] as const;
    for (const [scope_basis, reason] of combinations) {
      expect(decodeMemoryMaintenanceOutput({ decisions: [{ ...remove, scope_basis, reason }] }, plan).decisions[0])
        .toMatchObject({ action: "REMOVE_TRANSIENT", scopeBasis: scope_basis, reason, usefulness: null });
      for (const [, other] of combinations.filter(([, candidate]) => candidate !== reason)) {
        expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ ...remove, scope_basis, reason: other }] }, plan))
          .toThrow("memory_maintenance_output_invalid");
      }
    }
  });
  it("permits complete one-to-one source coverage only", () => {
    expect(decodeMemoryMaintenanceOutput({ decisions: [remove] }, plan).decisions[0]?.action).toBe("REMOVE_TRANSIENT");
    for (const decisions of [[], [remove, remove], [{ ...remove, source_ref: "S2" }], [{ ...remove, reason: "old_and_unused" }],
      [{ ...remove, scope_basis: "transient_update", reason: "transient_episode_update" }],
      [{ ...remove, usefulness: "DURABLE" }], [{ ...remove, instruction: "delete everything" }]]) {
      expect(() => decodeMemoryMaintenanceOutput({ decisions }, plan)).toThrow("memory_maintenance_output_invalid");
    }
  });
  it("requires independent explicit verification of each removal", () => {
    const output = decodeMemoryMaintenanceOutput({ decisions: [remove] }, plan);
    expect(decodeMemoryMaintenanceVerification({ decisions: [{ source_ref: "S1", approve: false }] }, output).decisions)
      .toEqual([{ sourceRef: "S1", approve: false }]);
    for (const decisions of [[], [{ source_ref: "S2", approve: true }], [{ source_ref: "S1", approve: "true" }]]) {
      expect(() => decodeMemoryMaintenanceVerification({ decisions }, output)).toThrow();
    }
  });
  it("rejects non-string usefulness instead of coercing malformed JSON", () => {
    for (const usefulness of [["DURABLE"], ["ONGOING"], { value: "DURABLE" }, null, 1]) {
      expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", action: "KEEP",
        scope_basis: "general_personal", usefulness, reason: "useful_personal_context" }] }, plan)).toThrow("memory_maintenance_output_invalid");
    }
  });
  it("prevents task-local constraints and generic reactions from being promoted to personal state", () => {
    for (const scope_basis of ["current_task_only", "generic_desideratum", "single_episode", "short_term_matter", "common_habit"]) {
      for (const usefulness of ["DURABLE", "ONGOING", "EPISODIC"]) {
        expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "KEEP",
          usefulness, reason: "useful_personal_context" }] }, plan)).toThrow("memory_maintenance_output_invalid");
      }
    }
  });
  it("retains unresolved scope and explicit remember intent without inventing a lasting preference", () => {
    for (const scope_basis of ["unresolved_scope", "explicit_remember"]) {
      expect(decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "KEEP", usefulness: null,
        reason: "useful_personal_context" }] }, plan).decisions[0]).toMatchObject({ action: "KEEP", usefulness: null });
      expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ ...remove, scope_basis }] }, plan)).toThrow();
    }
    expect(decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis: "explicit_remember", action: "KEEP",
      usefulness: "ONGOING", reason: "useful_personal_context" }] }, plan).decisions[0]).toMatchObject({ usefulness: "ONGOING" });
    expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis: "unresolved_scope", action: "KEEP",
      usefulness: "DURABLE", reason: "useful_personal_context" }] }, plan)).toThrow();
  });
  it("applies the long-term criterion without protecting episodes or shared excerpts", () => {
    const request = buildMemoryMaintenanceRequest(plan);
    expect(request.name).toBe("review_memory_usefulness_v3");
    expect(request.userPrompt).toContain(source.statement);
    expect(request.userPrompt).not.toMatch(/fact-1|version-1|chat-1|messageId|sourceTextHash/u);
    expect(request.systemPrompt).toContain(MEMORY_LONG_TERM_USEFULNESS_GUIDANCE);
    expect(request.systemPrompt).not.toMatch(/never justify deletion|significant_episode|KEEP EPISODIC/u);
    expect(JSON.stringify(request.schema)).not.toContain("EPISODIC");
    const verification = buildMemoryMaintenanceVerificationRequest(plan, decodeMemoryMaintenanceOutput({ decisions: [remove] }, plan));
    expect(verification.name).toBe("verify_memory_cleanup_v3");
    expect(verification.systemPrompt).toContain(MEMORY_LONG_TERM_USEFULNESS_GUIDANCE);
    expect(verification.systemPrompt).not.toMatch(/independent useful personal assertion|active plans, significant historical events/u);
    expect(verification.systemPrompt).toContain("not a reason to reject");
  });
  it("discloses to the verifier only the proposed removals", () => {
    const kept: MemoryMaintenanceSource = { ...source, ref: "S2", factId: "fact-2", versionId: "version-2",
      statement: "I have kept a vegetarian diet for ten years.", sourceSnapshotHash: "c".repeat(64) };
    const pair = memoryMaintenancePlan([source, kept]);
    const output = decodeMemoryMaintenanceOutput({ decisions: [remove, { source_ref: "S2", scope_basis: "general_personal",
      action: "KEEP", usefulness: "DURABLE", reason: "useful_personal_context" }] }, pair);
    const request = buildMemoryMaintenanceVerificationRequest(pair,
      { decisions: output.decisions.filter(({ action }) => action === "REMOVE_TRANSIENT") });
    expect(request.userPrompt).toContain(source.statement);
    expect(request.userPrompt).not.toContain(kept.statement);
    expect(JSON.parse(request.userPrompt).proposals).toEqual([expect.objectContaining({ sourceRef: "S1" })]);
  });
});
