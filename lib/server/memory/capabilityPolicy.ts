export const MEMORY_DELETION_ADMISSION_POLICY_VERSION =
  "memory-deletion-admission-policy-v1";

export const MEMORY_DELETION_ADMISSION_POLICY = Object.freeze({
  accountMemoryDeletion: Object.freeze({
    enabled: true,
    reason: "OPERATIONAL_COMPOSITION_REQUIRED" as const
  }),
  permanentChatDeletion: Object.freeze({
    enabled: true,
    reason: "OPERATIONAL_COMPOSITION_REQUIRED" as const
  }),
  policyVersion: MEMORY_DELETION_ADMISSION_POLICY_VERSION
});
