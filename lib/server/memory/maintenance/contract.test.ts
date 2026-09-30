import { describe, expect, it } from "vitest";
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
const remove = { source_ref: "S1", scope_basis: "transient_update", action: "REMOVE_TRANSIENT", usefulness: null, reason: "transient_episode_update" };

describe("governed automatic Memory maintenance", () => {
  it("keeps ongoing and historical utility independent of confidence", () => {
    for (const [usefulness, scope_basis] of [["DURABLE", "general_personal"], ["ONGOING", "ongoing_personal"], ["EPISODIC", "significant_episode"]]) {
      expect(decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "KEEP", usefulness, reason: "useful_personal_context" }] }, plan)
        .decisions[0]).toMatchObject({ action: "KEEP", usefulness });
    }
  });
  it("permits only the narrow transient reasons, with complete one-to-one source coverage", () => {
    expect(decodeMemoryMaintenanceOutput({ decisions: [remove] }, plan).decisions[0]?.action).toBe("REMOVE_TRANSIENT");
    for (const decisions of [[], [remove, remove], [{ ...remove, source_ref: "S2" }], [{ ...remove, reason: "old_and_unused" }],
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
    for (const usefulness of [["DURABLE"], ["ONGOING"], { value: "EPISODIC" }, null, 1]) {
      expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", action: "KEEP",
        scope_basis: "general_personal", usefulness, reason: "useful_personal_context" }] }, plan)).toThrow("memory_maintenance_output_invalid");
    }
  });
  it("prevents task-local constraints and generic reactions from being promoted to personal state", () => {
    for (const scope_basis of ["current_task_only", "generic_desideratum"]) {
      for (const usefulness of ["DURABLE", "ONGOING", "EPISODIC"]) {
        expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "KEEP",
          usefulness, reason: "useful_personal_context" }] }, plan)).toThrow("memory_maintenance_output_invalid");
      }
      expect(decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "REMOVE_TRANSIENT",
        usefulness: null, reason: "one_off_task_detail" }] }, plan).decisions[0]).toMatchObject({ action: "REMOVE_TRANSIENT", scopeBasis: scope_basis });
    }
  });
  it("retains unresolved scope and explicit remember intent without inventing a lasting preference", () => {
    for (const scope_basis of ["unresolved_scope", "explicit_remember"]) {
      expect(decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "KEEP", usefulness: null,
        reason: "useful_personal_context" }] }, plan).decisions[0]).toMatchObject({ action: "KEEP", usefulness: null });
      expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ ...remove, scope_basis }] }, plan)).toThrow();
    }
    expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis: "unresolved_scope", action: "KEEP",
      usefulness: "DURABLE", reason: "useful_personal_context" }] }, plan)).toThrow();
  });
  it("exposes bounded source evidence, not database identity or model mutation authority", () => {
    const request = buildMemoryMaintenanceRequest(plan);
    expect(request.userPrompt).toContain(source.statement);
    expect(request.userPrompt).not.toMatch(/fact-1|version-1|chat-1|messageId|sourceTextHash/u);
    expect(request.systemPrompt).toContain("Old age, lack of use");
    const verification = buildMemoryMaintenanceVerificationRequest(plan, decodeMemoryMaintenanceOutput({ decisions: [remove] }, plan));
    expect(verification.systemPrompt).toContain("independent useful personal assertion");
  });
});
