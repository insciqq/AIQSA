import { describe, expect, it } from "vitest";
import { decodeToolObservationDescriptor, decodeToolObservationReadInput, decodeToolObservationSourceBinding, toolObservationCursor, type ToolObservationDescriptor } from "./contract";

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
