import { describe, expect, it } from "vitest";
import { deriveKnownMcpToolCount, deriveMcpUserReadiness } from "./prismaRepository";

const now = new Date("2026-07-23T00:00:00.000Z");

function readiness(preferenceUpdatedAt: Date) {
  return deriveMcpUserReadiness({
    enabled: true,
    hasInvalidValues: false,
    hasMissingValues: false,
    now,
    oauthMode: false,
    oauthState: null,
    preferenceUpdatedAt,
    runtime: null
  });
}

describe("MCP user readiness", () => {
  it("keeps an enabled runtime-less server idle until an on-demand start", () => {
    expect(readiness(new Date(now.getTime() - 30_000))).toEqual({
      errorCode: null,
      readiness: "idle",
      tools: []
    });
    expect(readiness(new Date(now.getTime() - 15 * 60_000))).toEqual({
      errorCode: null,
      readiness: "idle",
      tools: []
    });
  });

  it("uses active-revision inventory before startup and current runtime inventory afterward", () => {
    const revisionValidationEvidence = {
      evidence: {},
      testedAt: now.toISOString(),
      toolInventory: [
        { description: null, name: "revision_one" },
        { description: null, name: "revision_two" }
      ]
    };

    expect(deriveKnownMcpToolCount({
      disabledToolNames: ["revision_two", "REVISION_ONE"],
      revisionCreatedAt: now,
      revisionValidationEvidence,
      runtimeInventory: null
    })).toBe(1);
    expect(deriveKnownMcpToolCount({
      revisionCreatedAt: now,
      revisionValidationEvidence,
      runtimeInventory: { tools: [{ description: null, name: "runtime_one" }] }
    })).toBe(1);
    expect(deriveKnownMcpToolCount({
      revisionCreatedAt: now,
      revisionValidationEvidence,
      runtimeInventory: { tools: [] }
    })).toBe(0);
  });
});
