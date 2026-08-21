import { describe, expect, it } from "vitest";
import {
  boundedMemoryAdmissionDeadlineMs,
  memoryAdmissionDeadlineMsFromPolicySeconds,
  MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS,
  MEMORY_ADMISSION_MAX_TIMEOUT_MS
} from "./admissionDeadline";

describe("Memory admission timeout policy", () => {
  it("defaults to 30 seconds while allowing the administrator to change the budget", () => {
    expect(boundedMemoryAdmissionDeadlineMs(undefined))
      .toBe(MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS);
    expect(MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(memoryAdmissionDeadlineMsFromPolicySeconds(BigInt(30))).toBe(30_000);
    expect(memoryAdmissionDeadlineMsFromPolicySeconds(120))
      .toBe(MEMORY_ADMISSION_MAX_TIMEOUT_MS);
  });

  it("rejects persisted values outside the installation policy bounds", () => {
    expect(() => memoryAdmissionDeadlineMsFromPolicySeconds(0))
      .toThrow("installation_memory_admission_timeout_invalid");
    expect(() => memoryAdmissionDeadlineMsFromPolicySeconds(121))
      .toThrow("installation_memory_admission_timeout_invalid");
    expect(() => memoryAdmissionDeadlineMsFromPolicySeconds(1.5))
      .toThrow("installation_memory_admission_timeout_invalid");
  });

  it("retains millisecond-scale overrides for deterministic deadline tests", () => {
    expect(boundedMemoryAdmissionDeadlineMs(25)).toBe(25);
  });
});
