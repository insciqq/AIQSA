import { describe, expect, it, vi } from "vitest";
import { MemoryExecutionError } from "./errors";
import {
  canonicalMemoryAdminDestinations,
  currentMemoryAdminDestinations,
  decodeMemoryAdminDestinations,
  memoryAdminDestinationsFingerprint,
  requireAdminAcceptedMemoryDestination
} from "./adminConsent";
import type { ResolvedMemoryExecutionTarget } from "./policy";

const destination = {
  destinationFingerprint: "a".repeat(64),
  role: "MEMORY_DOCUMENT_EMBED" as const
};

const target = {
  destinationFingerprint: destination.destinationFingerprint
} as ResolvedMemoryExecutionTarget;

function tx(value: unknown) {
  return {
    memoryEgressAdminPolicy: {
      findUnique: vi.fn().mockResolvedValue(value)
    }
  } as never;
}

describe("administrator-owned Memory egress consent", () => {
  it("canonicalizes exact role/destination pairs and hashes only policy evidence", () => {
    const canonical = canonicalMemoryAdminDestinations([
      destination,
      { destinationFingerprint: "b".repeat(64), role: "MEMORY_FACT_EXTRACT" },
      destination
    ]);

    expect(canonical).toEqual([
      { destinationFingerprint: "a".repeat(64), role: "MEMORY_DOCUMENT_EMBED" },
      { destinationFingerprint: "b".repeat(64), role: "MEMORY_FACT_EXTRACT" }
    ]);
    expect(memoryAdminDestinationsFingerprint(canonical)).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(canonical)).not.toContain("credential");
  });

  it("accepts only the exact current role and destination", async () => {
    const accepted = tx({
      acceptedAt: new Date("2026-08-11T10:00:00.000Z"),
      acceptedDestinations: [destination],
      acceptedPolicyVersion: "memory-utility-egress-v5"
    });

    await expect(requireAdminAcceptedMemoryDestination(accepted, {
      role: destination.role,
      target
    })).resolves.toBeUndefined();

    await expect(requireAdminAcceptedMemoryDestination(accepted, {
      role: "MEMORY_QUERY_EMBED",
      target
    })).rejects.toEqual(
      new MemoryExecutionError("memory_execution_egress_consent_required")
    );
    await expect(requireAdminAcceptedMemoryDestination(accepted, {
      role: destination.role,
      target: { ...target, destinationFingerprint: "c".repeat(64) }
    })).rejects.toEqual(
      new MemoryExecutionError("memory_execution_egress_consent_required")
    );
  });

  it("includes every dedicated reranker route target in administrator consent", () => {
    const destinations = currentMemoryAdminDestinations([{
      destinations: [],
      fingerprint: "f".repeat(64),
      policyVersion: "memory-utility-egress-v5",
      rerankerTargets: [
        { destinationFingerprint: "a".repeat(64) },
        { destinationFingerprint: "b".repeat(64) }
      ] as ResolvedMemoryExecutionTarget[],
      targets: new Map()
    }]);

    expect(destinations).toEqual([
      { destinationFingerprint: "a".repeat(64), role: "MEMORY_RERANK" },
      { destinationFingerprint: "b".repeat(64), role: "MEMORY_RERANK" }
    ]);
  });

  it("fails closed for missing, stale, or malformed installation evidence", async () => {
    for (const value of [
      null,
      {
        acceptedAt: null,
        acceptedDestinations: [],
        acceptedPolicyVersion: null
      },
      {
        acceptedAt: new Date(),
        acceptedDestinations: [{ ...destination, plaintext: "private" }],
        acceptedPolicyVersion: "memory-utility-egress-v3"
      },
      {
        acceptedAt: new Date(),
        acceptedDestinations: [destination],
        acceptedPolicyVersion: "memory-utility-egress-v0"
      }
    ]) {
      await expect(requireAdminAcceptedMemoryDestination(tx(value), {
        role: destination.role,
        target
      })).rejects.toEqual(
        new MemoryExecutionError("memory_execution_egress_consent_required")
      );
    }
    expect(decodeMemoryAdminDestinations([{ ...destination, plaintext: "private" }]))
      .toBeNull();
  });
});
