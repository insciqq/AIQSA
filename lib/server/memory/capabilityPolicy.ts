export const MEMORY_PHASE7_CAPABILITY_POLICY_VERSION =
  "memory-phase7-capability-policy-v1";

export type MemoryPhase7CapabilityDecision = Readonly<{
  enabled: boolean;
  reason: "OFF_COST_UNVERIFIED" | "OFF_NO_MEASURED_LIFT";
}>;

export const MEMORY_PHASE7_CAPABILITY_POLICY = Object.freeze({
  policyVersion: MEMORY_PHASE7_CAPABILITY_POLICY_VERSION,
  profileWorkingSet: Object.freeze({
    enabled: false,
    reason: "OFF_COST_UNVERIFIED"
  } satisfies MemoryPhase7CapabilityDecision),
  queryExpansion: Object.freeze({
    enabled: false,
    reason: "OFF_NO_MEASURED_LIFT"
  } satisfies MemoryPhase7CapabilityDecision),
  remoteReranker: Object.freeze({
    enabled: false,
    reason: "OFF_NO_MEASURED_LIFT"
  } satisfies MemoryPhase7CapabilityDecision)
});

export const MEMORY_PHASE8_CAPABILITY_POLICY_VERSION =
  "memory-phase8-capability-policy-v2";

export const MEMORY_PHASE8_CAPABILITY_POLICY = Object.freeze({
  accountMemoryDeletion: Object.freeze({
    enabled: true,
    reason: "ON_OPERATIONAL_COMPOSITION_REQUIRED" as const
  }),
  permanentChatDeletion: Object.freeze({
    enabled: true,
    reason: "ON_OPERATIONAL_COMPOSITION_REQUIRED" as const
  }),
  policyVersion: MEMORY_PHASE8_CAPABILITY_POLICY_VERSION
});

export const MEMORY_GA_ROLLOUT_MANIFEST_VERSION =
  "memory-ga-rollout-manifest-v2";

export const MEMORY_GA_ROLLOUT_MANIFEST = Object.freeze({
  defaults: Object.freeze({
    learnAutomatically: true,
    referenceChatHistory: true,
    useMemoryFacts: true
  }),
  manifestVersion: MEMORY_GA_ROLLOUT_MANIFEST_VERSION,
  phase7PolicyVersion: MEMORY_PHASE7_CAPABILITY_POLICY_VERSION,
  phase8PolicyVersion: MEMORY_PHASE8_CAPABILITY_POLICY_VERSION,
  publication: "NOT_PERFORMED" as const,
  rollback: Object.freeze({
    acceptedDeletionObligations: "CONTINUE" as const,
    automaticBackfill: "DO_NOT_ENQUEUE" as const,
    retainedData: "KEEP" as const
  }),
  stages: Object.freeze([
    Object.freeze({
      id: "EXPLICIT_MEMORY" as const,
      rollback: "FACT_INJECTION_OFF_MANAGEMENT_AVAILABLE" as const,
      state: "RELEASED" as const
    }),
    Object.freeze({
      id: "HISTORY_RECALL" as const,
      rollback: "RECALL_AND_INDEXING_OFF" as const,
      state: "RELEASED_DEFAULT_ON" as const
    }),
    Object.freeze({
      id: "AUTOMATIC_LEARNING" as const,
      rollback: "LEARNING_AND_PROVIDER_CALLS_OFF" as const,
      state: "RELEASED_DEFAULT_ON" as const
    }),
    Object.freeze({
      id: "PHASE7_OPTIONAL_COMPONENTS" as const,
      rollback: "OPTIONAL_PROVIDER_CALLS_OFF" as const,
      state: "EVIDENCE_HELD" as const
    }),
    Object.freeze({
      id: "HARD_DELETION" as const,
      rollback: "NEW_ADMISSION_OFF_ACCEPTED_OBLIGATIONS_CONTINUE" as const,
      state: "COMPOSITION_GATED" as const
    }),
    Object.freeze({
      id: "OPERATIONAL_GA" as const,
      rollback: "RETURN_TO_PRIOR_STAGE_GATES" as const,
      state: "RELEASED" as const
    })
  ])
});
