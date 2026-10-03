import { describe, expect, it } from "vitest";
import { MEMORY_LONG_TERM_USEFULNESS_GUIDANCE } from "../../../domain/memory/usefulness";
import { memoryOutputDecodeReason } from "../execution/outputViolation";
import { buildMemoryMaintenanceRequest, buildMemoryMaintenanceVerificationRequest, decodeMemoryMaintenanceOutput,
  decodeMemoryMaintenanceReview, decodeMemoryMaintenanceVerification, decodeStagedMemoryMaintenanceOutput,
  MEMORY_MAINTENANCE_REMOVAL_REASONS, MEMORY_MAINTENANCE_SCOPE_BASES, memoryMaintenanceDecisionReasonCode,
  MemoryMaintenanceOutputError, type MemoryMaintenanceDecision } from "./contract";
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
const keep = { source_ref: "S1", scope_basis: "general_personal", action: "KEEP", usefulness: "DURABLE", reason: "useful_personal_context" };
/** What every contradictory decision becomes: kept, with nothing promoted, and marked. */
const conservative = { sourceRef: "S1", scopeBasis: "unresolved_scope", action: "KEEP", usefulness: null, reason: "useful_personal_context",
  conservative: true };
const KEEP_BASES = ["general_personal", "ongoing_personal", "explicit_remember", "unresolved_scope"] as const;
const REMOVAL_BASES = MEMORY_MAINTENANCE_SCOPE_BASES.filter((basis) => !(KEEP_BASES as readonly string[]).includes(basis));
/** Each removal basis with the one removal reason it determines. */
const BASIS_REMOVAL_REASONS = [["single_episode", "episode"], ["short_term_matter", "short_term"], ["common_habit", "not_distinctive"],
  ["current_task_only", "one_off_task_detail"], ["generic_desideratum", "one_off_task_detail"],
  ["context_fragment", "context_dependent_fragment"]] as const;
const wire = ({ sourceRef, scopeBasis, action, usefulness, reason }: MemoryMaintenanceDecision) =>
  ({ source_ref: sourceRef, scope_basis: scopeBasis, action, usefulness, reason });
const decodeOne = (decision: Record<string, unknown>) => decodeMemoryMaintenanceReview({ decisions: [decision] }, plan);

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
  it("removes episodes, short-term matters and common habits under their basis's own reason", () => {
    const combinations = BASIS_REMOVAL_REASONS;
    for (const [scope_basis, reason] of combinations) {
      expect(decodeOne({ ...remove, scope_basis, reason })).toEqual({ normalized: 0, conservative: 0, output: { decisions: [
        { sourceRef: "S1", scopeBasis: scope_basis, action: "REMOVE_TRANSIENT", usefulness: null, reason }] } });
      // Another removal reason is a slip the basis corrects; the removal still needs its verifier.
      for (const [, other] of combinations.filter(([, candidate]) => candidate !== reason)) {
        expect(decodeOne({ ...remove, scope_basis, reason: other })).toEqual({ normalized: 1, conservative: 0, output: { decisions: [
          { sourceRef: "S1", scopeBasis: scope_basis, action: "REMOVE_TRANSIENT", usefulness: null, reason }] } });
      }
    }
  });
  it("permits complete one-to-one source coverage only", () => {
    expect(decodeMemoryMaintenanceOutput({ decisions: [remove] }, plan).decisions[0]?.action).toBe("REMOVE_TRANSIENT");
    for (const decisions of [[], [remove, remove], [{ ...remove, source_ref: "S2" }], [{ ...remove, reason: "old_and_unused" }],
      [{ ...remove, scope_basis: "transient_update", reason: "transient_episode_update" }],
      [{ ...remove, instruction: "delete everything" }]]) {
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
    for (const usefulness of [["DURABLE"], ["ONGOING"], { value: "DURABLE" }, 1]) {
      expect(() => decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", action: "KEEP",
        scope_basis: "general_personal", usefulness, reason: "useful_personal_context" }] }, plan)).toThrow("memory_maintenance_output_invalid");
    }
  });
  it("prevents task-local constraints and generic reactions from being promoted to personal state", () => {
    for (const scope_basis of ["current_task_only", "generic_desideratum", "single_episode", "short_term_matter", "common_habit"]) {
      for (const usefulness of ["DURABLE", "ONGOING"]) {
        expect(decodeOne({ source_ref: "S1", scope_basis, action: "KEEP", usefulness, reason: "useful_personal_context" }))
          .toEqual({ normalized: 0, conservative: 1, output: { decisions: [conservative] } });
      }
      expect(() => decodeOne({ source_ref: "S1", scope_basis, action: "KEEP", usefulness: "EPISODIC", reason: "useful_personal_context" }))
        .toThrow("memory_maintenance_output_invalid");
    }
  });
  it("retains unresolved scope and explicit remember intent without inventing a lasting preference", () => {
    for (const scope_basis of ["unresolved_scope", "explicit_remember"]) {
      expect(decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis, action: "KEEP", usefulness: null,
        reason: "useful_personal_context" }] }, plan).decisions[0]).toMatchObject({ action: "KEEP", usefulness: null });
      expect(decodeOne({ ...remove, scope_basis })).toEqual({ normalized: 0, conservative: 1, output: { decisions: [conservative] } });
    }
    expect(decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis: "explicit_remember", action: "KEEP",
      usefulness: "ONGOING", reason: "useful_personal_context" }] }, plan).decisions[0]).toMatchObject({ usefulness: "ONGOING" });
    expect(decodeOne({ source_ref: "S1", scope_basis: "unresolved_scope", action: "KEEP", usefulness: "DURABLE",
      reason: "useful_personal_context" })).toMatchObject({ normalized: 1, output: { decisions: [{ scopeBasis: "unresolved_scope", usefulness: null }] } });
  });
  it("derives every label a keep basis determines, keeping explicit remember intent's own label", () => {
    const derived = [["general_personal", "DURABLE"], ["ongoing_personal", "ONGOING"], ["unresolved_scope", null]] as const;
    for (const [scope_basis, usefulness] of derived) {
      for (const emitted of ["DURABLE", "ONGOING", null]) {
        for (const reason of ["useful_personal_context", ...MEMORY_MAINTENANCE_REMOVAL_REASONS]) {
          const repaired = emitted !== usefulness || reason !== "useful_personal_context";
          expect(decodeOne({ source_ref: "S1", scope_basis, action: "KEEP", usefulness: emitted, reason })).toEqual({
            normalized: repaired ? 1 : 0, conservative: 0, output: { decisions: [
              { sourceRef: "S1", scopeBasis: scope_basis, action: "KEEP", usefulness, reason: "useful_personal_context" }] } });
        }
      }
    }
    for (const usefulness of ["DURABLE", "ONGOING", null]) {
      expect(decodeOne({ source_ref: "S1", scope_basis: "explicit_remember", action: "KEEP", usefulness, reason: "short_term" }))
        .toEqual({ normalized: 1, conservative: 0, output: { decisions: [{ sourceRef: "S1", scopeBasis: "explicit_remember",
          action: "KEEP", usefulness, reason: "useful_personal_context" }] } });
    }
  });
  it("removes only when every label agrees, keeps every contradiction and decodes each answer to itself", () => {
    let removals = 0;
    for (const scope_basis of MEMORY_MAINTENANCE_SCOPE_BASES) {
      for (const action of ["KEEP", "REMOVE_TRANSIENT"]) {
        for (const usefulness of ["DURABLE", "ONGOING", null]) {
          for (const reason of ["useful_personal_context", ...MEMORY_MAINTENANCE_REMOVAL_REASONS]) {
            const decoded = decodeOne({ source_ref: "S1", scope_basis, action, usefulness, reason });
            const decision = decoded.output.decisions[0]!;
            const unanimousRemoval = action === "REMOVE_TRANSIENT" && REMOVAL_BASES.includes(scope_basis) &&
              usefulness === null && reason !== "useful_personal_context";
            const contradiction = (action === "KEEP") === REMOVAL_BASES.includes(scope_basis) ||
              (action === "REMOVE_TRANSIENT" && !unanimousRemoval);
            expect(decision.action).toBe(unanimousRemoval ? "REMOVE_TRANSIENT" : "KEEP");
            expect(decoded.conservative).toBe(contradiction ? 1 : 0);
            if (contradiction) expect(decision).toEqual(conservative);
            else expect(decision.scopeBasis).toBe(scope_basis);
            // The settled review records the basis's removal reason or the resolved contradiction, never a model keep.
            expect(memoryMaintenanceDecisionReasonCode(decision)).toBe(unanimousRemoval
              ? BASIS_REMOVAL_REASONS.find(([basis]) => basis === scope_basis)![1] : contradiction ? "unresolved_scope" : null);
            // A decoded decision is a canonical combination: a staged receipt re-decodes unchanged, mark included.
            if (!contradiction) expect(decodeOne(wire(decision))).toEqual({ normalized: 0, conservative: 0, output: decoded.output });
            expect(decodeStagedMemoryMaintenanceOutput(JSON.parse(JSON.stringify(decoded.output)), plan)).toEqual(decoded.output);
            if (unanimousRemoval) removals += 1;
          }
        }
      }
    }
    expect(removals).toBe(REMOVAL_BASES.length * MEMORY_MAINTENANCE_REMOVAL_REASONS.length);
  });
  it("tells a resolved contradiction from a model's unresolved keep without trusting a stored mark", () => {
    const modelKeep = decodeMemoryMaintenanceOutput({ decisions: [{ source_ref: "S1", scope_basis: "unresolved_scope", action: "KEEP",
      usefulness: null, reason: "useful_personal_context" }] }, plan).decisions[0]!;
    const resolved = decodeOne({ ...remove, usefulness: "DURABLE" }).output.decisions[0]!;
    expect(modelKeep).toEqual({ ...resolved, conservative: undefined });
    expect(memoryMaintenanceDecisionReasonCode(modelKeep)).toBeNull();
    expect(memoryMaintenanceDecisionReasonCode(resolved)).toBe("unresolved_scope");
    // A receipt staged before the mark existed stays an ordinary keep; a mark on a removal makes it a keep, never the reverse.
    expect(decodeStagedMemoryMaintenanceOutput({ decisions: [modelKeep] }, plan).decisions).toEqual([modelKeep]);
    const removal = decodeMemoryMaintenanceOutput({ decisions: [remove] }, plan).decisions[0]!;
    expect(decodeStagedMemoryMaintenanceOutput({ decisions: [{ ...removal, conservative: true }] }, plan).decisions).toEqual([conservative]);
    for (const saved of [null, {}, { decisions: [{ ...removal, reason: "old_and_unused" }] }]) {
      expect(() => decodeStagedMemoryMaintenanceOutput(saved, plan)).toThrow("memory_maintenance_output_invalid");
    }
    expect(() => memoryMaintenanceDecisionReasonCode({ ...removal, reason: "useful_personal_context" }))
      .toThrow("memory_maintenance_output_invalid");
    // Every recorded code fits the review row's closed VARCHAR(32) vocabulary.
    expect([...MEMORY_MAINTENANCE_REMOVAL_REASONS, "unresolved_scope"].every((code) => code.length <= 32 && /^[a-z_]+$/u.test(code)))
      .toBe(true);
  });
  it("decodes a batch whose only defects are labels, reviews every source and verifies only consistent removals", () => {
    const sources = ["S1", "S2", "S3", "S4"].map((ref, index): MemoryMaintenanceSource => ({ ...source, ref,
      factId: `fact-${ref}`, versionId: `version-${ref}`, statement: `Synthetic statement ${ref}.`,
      sourceSnapshotHash: String(index + 1).repeat(64) }));
    const batch = memoryMaintenancePlan(sources);
    const decoded = decodeMemoryMaintenanceReview({ decisions: [
      { ...remove, source_ref: "S1" },
      { ...keep, source_ref: "S2", usefulness: "ONGOING" },
      { ...remove, source_ref: "S3", usefulness: "DURABLE" },
      { ...remove, source_ref: "S4", scope_basis: "short_term_matter", reason: "episode" }
    ] }, batch);
    expect(decoded).toEqual({ normalized: 2, conservative: 1, output: { decisions: [
      { sourceRef: "S1", scopeBasis: "single_episode", action: "REMOVE_TRANSIENT", usefulness: null, reason: "episode" },
      { sourceRef: "S2", scopeBasis: "general_personal", action: "KEEP", usefulness: "DURABLE", reason: "useful_personal_context" },
      { ...conservative, sourceRef: "S3" },
      { sourceRef: "S4", scopeBasis: "short_term_matter", action: "REMOVE_TRANSIENT", usefulness: null, reason: "short_term" }
    ] } });
    const verification = buildMemoryMaintenanceVerificationRequest(batch, decoded.output);
    expect(JSON.parse(verification.userPrompt).proposals.map(({ sourceRef }: { sourceRef: string }) => sourceRef)).toEqual(["S1", "S4"]);
    expect(verification.userPrompt).not.toContain("Synthetic statement S3.");
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
  it("records a closed reason for every rejected review and verification answer", () => {
    const pair = memoryMaintenancePlan([source, { ...source, ref: "S2", factId: "fact-2", versionId: "version-2" }]);
    const review = [
      [null, "maintenance_contract_shape"], [{ decisions: [remove], extra: true }, "maintenance_contract_shape"],
      [{ decisions: "S1" }, "maintenance_contract_shape"], [{ decisions: ["S1"] }, "maintenance_contract_shape"],
      [{ decisions: [{ ...remove, instruction: "delete everything" }] }, "maintenance_contract_shape"],
      [{ decisions: [{ source_ref: "S1", scope_basis: "single_episode", action: "REMOVE_TRANSIENT", reason: "episode" }] }, "maintenance_contract_shape"],
      [{ decisions: [] }, "maintenance_contract_count"], [{ decisions: [remove, remove] }, "maintenance_contract_count"],
      [{ decisions: [{ ...remove, source_ref: "S2" }] }, "maintenance_contract_ref"], [{ decisions: [{ ...remove, source_ref: 1 }] }, "maintenance_contract_ref"],
      [{ decisions: [{ ...remove, scope_basis: "transient_update" }] }, "maintenance_contract_enum"],
      [{ decisions: [{ ...remove, action: "DELETE" }] }, "maintenance_contract_enum"],
      [{ decisions: [{ ...keep, usefulness: "EPISODIC" }] }, "maintenance_contract_enum"],
      [{ decisions: [{ ...keep, usefulness: ["DURABLE"] }] }, "maintenance_contract_enum"],
      [{ decisions: [{ ...remove, reason: "old_and_unused" }] }, "maintenance_contract_enum"]
    ] as const;
    const proposal = decodeMemoryMaintenanceOutput({ decisions: [remove] }, plan);
    const verification = [
      [{ decisions: [{ source_ref: "S1", approve: true }], extra: true }, "verification_contract_shape"],
      [{ decisions: [{ source_ref: "S1", approve: true, why: "x" }] }, "verification_contract_shape"],
      [{ decisions: [] }, "verification_contract_count"], [{ decisions: [{ source_ref: "S2", approve: true }] }, "verification_contract_ref"],
      [{ decisions: [{ source_ref: "S1", approve: "true" }] }, "verification_contract_approve"]
    ] as const;
    const rejected = (decode: () => unknown) => { try { decode(); } catch (error) { return error; } return null; };
    for (const [value, decodeReason] of review) {
      const error = rejected(() => decodeMemoryMaintenanceOutput(value, plan));
      expect(error).toBeInstanceOf(MemoryMaintenanceOutputError);
      expect(error).toMatchObject({ message: "memory_maintenance_output_invalid", decodeReason });
      expect(memoryOutputDecodeReason(error)).toBe(decodeReason);
    }
    // A duplicate ref leaves another source without a decision, even when every label is consistent.
    expect(rejected(() => decodeMemoryMaintenanceOutput({ decisions: [remove, keep] }, pair)))
      .toMatchObject({ name: "MemoryMaintenanceOutputError", decodeReason: "maintenance_contract_ref" });
    for (const [value, decodeReason] of verification) {
      expect(rejected(() => decodeMemoryMaintenanceVerification(value, proposal)))
        .toMatchObject({ name: "MemoryMaintenanceOutputError", message: "memory_maintenance_output_invalid", decodeReason });
    }
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
