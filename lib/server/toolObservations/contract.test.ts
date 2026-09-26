import { describe, expect, it } from "vitest";
import { admitsToolObservationReservation, decodeToolObservationDescriptor, decodeToolObservationReadInput, decodeToolObservationSourceBinding,
  mcpObservationMaximumBytes, ObservationStoreError, observationFailure, TOOL_OBSERVATION_LIMITS, toolObservationCursor, toolObservationRunBytes,
  type ToolObservationBudgetUsage, type ToolObservationDescriptor } from "./contract";
import { DEFAULT_MCP_RESPONSE_WIRE_LIMITS, getMcpResponseWireLimits, MCP_RESPONSE_WIRE_LIMIT_CEILINGS } from "../mcp/responseLimits";
import { SEARCH_OBSERVATION_MAX_BYTES } from "./searchOriginal";

const descriptor: ToolObservationDescriptor = { version: 1, handle: `tor1_${"a".repeat(32)}`, source: "workspace",
  encoding: "json-utf8-v1", byteSize: 10000, checksum: "b".repeat(64), sourceTruncated: true, maskable: true };

describe("versioned observation lookup contract", () => {
  it("does not accept public selector fields, credentials or another source version as a private binding", () => {
    const binding = { version: 1, source: "mcp", serverId: "server", originalName: "call", revisionId: "revision", fingerprint: "a".repeat(64) };
    expect(decodeToolObservationSourceBinding(binding, "mcp")).toEqual(binding);
    for (const invalid of [{ ...binding, version: 2 }, { ...binding, storageKey: "private/path" },
      { ...binding, token: "synthetic" }, { ...binding, originalName: "bad\nname" }, { ...binding, fingerprint: "unknown" }]) {
      expect(decodeToolObservationSourceBinding(invalid, "mcp")).toBeNull();
    }
    expect(decodeToolObservationSourceBinding(binding, "search")).toBeNull();
    expect(decodeToolObservationSourceBinding({ version: 1, source: "search", sources: [] }, "search")).toBeNull();
  });
  it("retains source truncation and rejects unknown versions, storage paths and maskable instructions", () => {
    expect(decodeToolObservationDescriptor(descriptor)).toEqual(descriptor);
    for (const invalid of [{ ...descriptor, version: 2 }, { ...descriptor, storageKey: "private/path" },
      { ...descriptor, handle: "https://example.com" }, { ...descriptor, byteSize: Infinity },
      { ...descriptor, source: "image" }, { ...descriptor, source: "skill" }]) {
      expect(decodeToolObservationDescriptor(invalid)).toBeNull();
    }
    expect(decodeToolObservationDescriptor({ ...descriptor, source: "skill", maskable: false })).not.toBeNull();
  });

  it("binds a bounded continuation to the same immutable original and literal search", () => {
    const cursor = toolObservationCursor(descriptor, 4321, "rare 😀");
    expect(decodeToolObservationReadInput({ handle: descriptor.handle, query: "rare 😀", cursor, maxBytes: 512 }))
      .toEqual({ handle: descriptor.handle, expectedChecksum: descriptor.checksum,
        selector: { offset: 4321, maxBytes: 512, query: "rare 😀" } });
    for (const input of [{ handle: `tor1_${"c".repeat(32)}`, query: "rare 😀", cursor },
      { handle: descriptor.handle, query: "changed", cursor }, { handle: descriptor.handle, query: "rare 😀", cursor, offset: 0 }]) {
      expect(() => decodeToolObservationReadInput(input)).toThrow("tool_observation_selector_invalid");
    }
  });

  it.each([
    { storageKey: "x" }, { url: "https://example.com" }, { path: "../file" }, { regex: ".*" },
    { code: "1+1" }, { query: "x".repeat(257) }, { query: "\ud800" }, { cursor: "x".repeat(513) },
    { cursor: "not-json" }, { cursor: Buffer.from('{"version":2}').toString("base64url") },
    { offset: -1 }, { offset: 0.5 }, { maxBytes: 1000000 }
  ])("refuses selectors outside the bounded read protocol", extra => {
    expect(() => decodeToolObservationReadInput({ handle: descriptor.handle, ...extra }))
      .toThrow("tool_observation_selector_invalid");
  });

  it("defaults to a bounded first page without granting any source authority", () => {
    expect(decodeToolObservationReadInput({ handle: descriptor.handle })).toEqual({ handle: descriptor.handle,
      selector: { offset: 0, maxBytes: 6144 } });
  });
});

describe("store budgets bound externalized bytes, not calls", () => {
  const MiB = 1024 * 1024;
  const empty: ToolObservationBudgetUsage = { runBytes: 0n, branchBytes: 0n };
  /** Reserve sequentially as the repository does, each in-flight ceiling
   * adding to the run and branch usage of the next reservation. */
  const batch = (ceiling: number, calls: number, limits = getMcpResponseWireLimits(), usage = empty) => {
    let current = usage;
    return Array.from({ length: calls }, () => {
      const admitted = admitsToolObservationReservation(current, ceiling, limits);
      if (admitted) current = { runBytes: current.runBytes + BigInt(ceiling), branchBytes: current.branchBytes + BigInt(ceiling) };
      return admitted;
    });
  };

  it.each([
    { label: "default 8 MiB", limits: DEFAULT_MCP_RESPONSE_WIRE_LIMITS, runBytes: 64 * MiB },
    { label: "maximum 16 MiB", limits: MCP_RESPONSE_WIRE_LIMIT_CEILINGS, runBytes: 4 * (16 * MiB + 64 * 1024) }
  ])("admits a full parallel MCP batch at the $label wire cap with nothing retained", ({ limits, runBytes }) => {
    const ceiling = mcpObservationMaximumBytes(limits);
    expect(ceiling).toBe(limits.callToolResponseMaxBytes + 64 * 1024);
    expect(toolObservationRunBytes(limits)).toBe(runBytes);
    expect(batch(ceiling, TOOL_OBSERVATION_LIMITS.concurrentCalls, limits)).toEqual([true, true, true, true]);
  });

  it("keeps the per-run bound on retained bytes and the branch bound unchanged", () => {
    const limits = MCP_RESPONSE_WIRE_LIMIT_CEILINGS;
    const ceiling = mcpObservationMaximumBytes(limits);
    // A fifth call beyond the accepted concurrency waits for a publication.
    expect(batch(ceiling, 5, limits)).toEqual([true, true, true, true, false]);
    // Retained objects still exhaust the run: one more byte is refused.
    const run = BigInt(toolObservationRunBytes(limits));
    expect(admitsToolObservationReservation({ runBytes: run - 1n, branchBytes: run - 1n }, 1, limits)).toBe(true);
    expect(admitsToolObservationReservation({ runBytes: run, branchBytes: run }, 1, limits)).toBe(false);
    const branch = BigInt(TOOL_OBSERVATION_LIMITS.branchBytes);
    expect(admitsToolObservationReservation({ runBytes: 0n, branchBytes: branch - BigInt(ceiling) }, ceiling, limits)).toBe(true);
    expect(admitsToolObservationReservation({ runBytes: 0n, branchBytes: branch - BigInt(ceiling) + 1n }, ceiling, limits)).toBe(false);
    // Search and Workspace ceilings never raise the bound above four MCP calls.
    for (const other of [SEARCH_OBSERVATION_MAX_BYTES, 6 * MiB + 64 * 1024]) {
      expect(TOOL_OBSERVATION_LIMITS.concurrentCalls * other).toBeLessThanOrEqual(TOOL_OBSERVATION_LIMITS.runBytes);
    }
    expect(TOOL_OBSERVATION_LIMITS).not.toHaveProperty("runCount");
    expect(TOOL_OBSERVATION_LIMITS).not.toHaveProperty("branchCount");
  });

  it("tells the model a refused reservation started nothing, unlike a post-dispatch loss", () => {
    const refused = observationFailure(new ObservationStoreError("tool_observation_not_started"));
    expect(refused?.code).toBe("tool_observation_not_started");
    expect(refused?.message).toMatch(/not started/iu);
    expect(refused?.message).not.toMatch(/may have completed|retr(y|ied)|budget/iu);
    expect(observationFailure(new ObservationStoreError("tool_observation_unavailable"))?.message).toMatch(/may have completed/iu);
  });
});
