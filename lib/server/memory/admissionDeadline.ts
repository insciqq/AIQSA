import { ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS } from "../../contracts/adminMemory";

/**
 * One end-to-end budget for synchronous Personal Memory admission.
 *
 * The run preparation boundary subtracts small persistence/finalization
 * reserves from this budget, while every Memory utility and controlled
 * mutation receives the same absolute deadline.
 */
export const MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS =
  ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.defaultSeconds * 1_000;
export const MEMORY_ADMISSION_MAX_TIMEOUT_MS =
  ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds * 1_000;
export const MEMORY_ADMISSION_MIN_TIMEOUT_MS =
  ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds * 1_000;

export function boundedMemoryAdmissionDeadlineMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MEMORY_ADMISSION_MAX_TIMEOUT_MS);
}

export function memoryAdmissionDeadlineMsFromPolicySeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) ||
    seconds < ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds ||
    seconds > ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds) {
    throw new Error("installation_memory_admission_timeout_invalid");
  }
  return seconds * 1_000;
}
