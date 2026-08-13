import { describe, expect, it } from "vitest";
import {
  MEMORY_GA_ROLLOUT_MANIFEST,
  MEMORY_GA_ROLLOUT_MANIFEST_VERSION,
  MEMORY_PHASE7_CAPABILITY_POLICY,
  MEMORY_PHASE7_CAPABILITY_POLICY_VERSION,
  MEMORY_PHASE8_CAPABILITY_POLICY,
  MEMORY_PHASE8_CAPABILITY_POLICY_VERSION
} from "./capabilityPolicy";

describe("Memory GA rollout manifest", () => {
  it("pins released default-on learning and non-destructive rollback", () => {
    expect(MEMORY_GA_ROLLOUT_MANIFEST).toEqual({
      defaults: {
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true
      },
      manifestVersion: MEMORY_GA_ROLLOUT_MANIFEST_VERSION,
      phase7PolicyVersion: MEMORY_PHASE7_CAPABILITY_POLICY_VERSION,
      phase8PolicyVersion: MEMORY_PHASE8_CAPABILITY_POLICY_VERSION,
      publication: "NOT_PERFORMED",
      rollback: {
        acceptedDeletionObligations: "CONTINUE",
        automaticBackfill: "DO_NOT_ENQUEUE",
        retainedData: "KEEP"
      },
      stages: [
        {
          id: "EXPLICIT_MEMORY",
          rollback: "FACT_INJECTION_OFF_MANAGEMENT_AVAILABLE",
          state: "RELEASED"
        },
        {
          id: "HISTORY_RECALL",
          rollback: "RECALL_AND_INDEXING_OFF",
          state: "RELEASED_DEFAULT_ON"
        },
        {
          id: "AUTOMATIC_LEARNING",
          rollback: "LEARNING_AND_PROVIDER_CALLS_OFF",
          state: "RELEASED_DEFAULT_ON"
        },
        {
          id: "PHASE7_OPTIONAL_COMPONENTS",
          rollback: "OPTIONAL_PROVIDER_CALLS_OFF",
          state: "EVIDENCE_HELD"
        },
        {
          id: "HARD_DELETION",
          rollback: "NEW_ADMISSION_OFF_ACCEPTED_OBLIGATIONS_CONTINUE",
          state: "COMPOSITION_GATED"
        },
        {
          id: "OPERATIONAL_GA",
          rollback: "RETURN_TO_PRIOR_STAGE_GATES",
          state: "RELEASED"
        }
      ]
    });
    expect(MEMORY_GA_ROLLOUT_MANIFEST_VERSION)
      .toBe("memory-ga-rollout-manifest-v2");
    expect(MEMORY_PHASE7_CAPABILITY_POLICY).toMatchObject({
      profileWorkingSet: { enabled: false },
      queryExpansion: { enabled: false },
      remoteReranker: { enabled: false }
    });
    expect(MEMORY_PHASE8_CAPABILITY_POLICY).toMatchObject({
      accountMemoryDeletion: { enabled: true },
      permanentChatDeletion: { enabled: true }
    });
  });
});

describe("Phase 7 Memory capability policy", () => {
  it("keeps every non-lifting or operationally unqualified component off", () => {
    expect(MEMORY_PHASE7_CAPABILITY_POLICY).toEqual({
      policyVersion: MEMORY_PHASE7_CAPABILITY_POLICY_VERSION,
      profileWorkingSet: {
        enabled: false,
        reason: "OFF_COST_UNVERIFIED"
      },
      queryExpansion: {
        enabled: false,
        reason: "OFF_NO_MEASURED_LIFT"
      },
      remoteReranker: {
        enabled: false,
        reason: "OFF_NO_MEASURED_LIFT"
      }
    });
    expect(MEMORY_PHASE7_CAPABILITY_POLICY_VERSION)
      .toBe("memory-phase7-capability-policy-v1");
  });
});

describe("Phase 8 Memory capability policy", () => {
  it("requires exact operational composition before either admission path opens", () => {
    expect(MEMORY_PHASE8_CAPABILITY_POLICY).toEqual({
      accountMemoryDeletion: {
        enabled: true,
        reason: "ON_OPERATIONAL_COMPOSITION_REQUIRED"
      },
      permanentChatDeletion: {
        enabled: true,
        reason: "ON_OPERATIONAL_COMPOSITION_REQUIRED"
      },
      policyVersion: MEMORY_PHASE8_CAPABILITY_POLICY_VERSION
    });
    expect(MEMORY_PHASE8_CAPABILITY_POLICY_VERSION)
      .toBe("memory-phase8-capability-policy-v2");
  });
});
