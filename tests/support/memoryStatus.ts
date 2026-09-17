import type { AdminMemoryStatus } from "../../lib/contracts/adminMemory";

export function memoryWorkerStatusFixture(
  overrides: Partial<AdminMemoryStatus["worker"]> = {}
): AdminMemoryStatus["worker"] {
  return { state: "RUNNING", reason: "IDLE", activeStages: [], observationWindowSeconds: 900,
    lastProgressAgeSeconds: null, lastSeenAgeSeconds: 1, lastSuccessAgeSeconds: null, ...overrides };
}

export function memoryRecoveryStatusFixture(
  overrides: Partial<AdminMemoryStatus["recovery"]> = {}
): AdminMemoryStatus["recovery"] {
  return { configurationRequired: 0, eligible: 0, exhausted: 0, obsolete: 0,
    permanent: 0, protected: 0, scheduled: 0, nextRetrySeconds: null, ...overrides };
}
