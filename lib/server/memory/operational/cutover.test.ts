import { describe, expect, it } from "vitest";
import {
  decideMemorySemanticCutover,
  MEMORY_SEMANTIC_CUTOVER_INVENTORY_VERSION,
  type MemorySemanticCutoverInventory
} from "./cutover";

function inventory(
  overrides: Partial<MemorySemanticCutoverInventory> = {}
): MemorySemanticCutoverInventory {
  const base = {
    activeCurrentMissingExactAuthority: 0,
    aliasesWithoutAdmissibleSupport: 0,
    automaticEvidenceMissingExactProvenance: 0,
    automaticMissingIngestionFingerprint: 0,
    contextVersionsWithInvalidDependencies: 0,
    duplicateCurrentSemanticIdentities: 0,
    legacyCandidates: 0,
    legacyDecisions: 0,
    legacyNonterminalJobs: 0,
    total: 0,
    unsupportedAutomaticPipelineVersions: 0,
    version: MEMORY_SEMANTIC_CUTOVER_INVENTORY_VERSION
  } as const;
  return { ...base, ...overrides };
}

describe("Memory semantic cutover decision", () => {
  it("requires an explicit zero/no-op disposition for an empty inventory", () => {
    expect(decideMemorySemanticCutover(inventory(), null)).toMatchObject({
      reason: "explicit_disposition_required",
      status: "BLOCKED"
    });
    expect(decideMemorySemanticCutover(inventory(), "ZERO_NOOP")).toEqual({
      blockingCount: 0,
      disposition: "ZERO_NOOP",
      reason: "zero_inventory_noop",
      status: "READY"
    });
  });

  it("permits retained rows only through an explicit dormant disposition", () => {
    const retained = inventory({
      activeCurrentMissingExactAuthority: 2,
      total: 4,
      unsupportedAutomaticPipelineVersions: 2
    });
    expect(decideMemorySemanticCutover(retained, "ZERO_NOOP").status)
      .toBe("BLOCKED");
    expect(decideMemorySemanticCutover(
      retained,
      "RETAINED_DORMANT_EXCLUDED"
    )).toEqual({
      blockingCount: 0,
      disposition: "RETAINED_DORMANT_EXCLUDED",
      reason: "retained_legacy_is_dormant",
      status: "READY"
    });
  });

  it("never treats duplicate authority or nonterminal legacy work as dormant", () => {
    const unsafe = inventory({
      duplicateCurrentSemanticIdentities: 1,
      legacyNonterminalJobs: 2,
      total: 3
    });
    expect(decideMemorySemanticCutover(
      unsafe,
      "RETAINED_DORMANT_EXCLUDED"
    )).toEqual({
      blockingCount: 3,
      disposition: "RETAINED_DORMANT_EXCLUDED",
      reason: "retained_inventory_not_dormant",
      status: "BLOCKED"
    });
  });
});
