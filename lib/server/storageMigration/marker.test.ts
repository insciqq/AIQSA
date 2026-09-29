import { describe, expect, it } from "vitest";
import {
  assertStorageMarkerBinding,
  createStorageMarker,
  parseStorageMarker,
  serializeStorageMarker,
  STORAGE_MARKER_KEY,
  storageIdentity
} from "./marker";

const identity = { bucket: "aiqsa-uploads", composeProject: "aiqsa" };
const now = new Date("2026-09-29T12:00:00.000Z");
const migration = { completedAt: now.toISOString(), missingReferenceCount: 0, objectCount: 3, totalBytes: 42 };

describe("storage marker", () => {
  it("round-trips fresh and migrated markers with a random storage identity", () => {
    const fresh = createStorageMarker(identity, { migration: null, now });
    const migrated = createStorageMarker(identity, { migration, now });
    expect(parseStorageMarker(serializeStorageMarker(fresh))).toEqual(fresh);
    expect(parseStorageMarker(serializeStorageMarker(migrated))).toEqual(migrated);
    expect(fresh.source).toBe("fresh");
    expect(migrated.source).toBe("migrated");
    expect(fresh.storageId).not.toBe(migrated.storageId);
    expect(STORAGE_MARKER_KEY.startsWith("_aiqsa/")).toBe(true);
  });

  it.each([
    ["unknown version", (marker: Record<string, unknown>) => ({ ...marker, version: 2 })],
    ["unknown format", (marker: Record<string, unknown>) => ({ ...marker, format: "other" })],
    ["migrated without counts", (marker: Record<string, unknown>) => ({ ...marker, source: "migrated", migration: null })],
    ["fresh with counts", (marker: Record<string, unknown>) => ({ ...marker, migration })],
    ["an invalid storage id", (marker: Record<string, unknown>) => ({ ...marker, storageId: "x" })],
    ["an invalid project", (marker: Record<string, unknown>) => ({ ...marker, composeProject: "Bad Name" })]
  ])("rejects %s", (_name, mutate) => {
    const marker = JSON.parse(serializeStorageMarker(createStorageMarker(identity, { migration: null, now })).toString());
    expect(() => parseStorageMarker(Buffer.from(JSON.stringify(mutate(marker)))))
      .toThrow(expect.objectContaining({ code: "storage_marker_invalid" }));
  });

  it("rejects unreadable and oversized content", () => {
    for (const bytes of [Buffer.from("{"), Buffer.from([0xff, 0xfe]), Buffer.alloc(17 * 1024, 32)]) {
      expect(() => parseStorageMarker(bytes)).toThrow(expect.objectContaining({ code: "storage_marker_invalid" }));
    }
  });

  it("binds a marker to its bucket and Compose project", () => {
    const marker = createStorageMarker(identity, { migration: null, now });
    expect(() => assertStorageMarkerBinding(marker, identity)).not.toThrow();
    for (const other of [{ ...identity, bucket: "other-bucket" }, { ...identity, composeProject: "aiqsa-second" }]) {
      expect(() => assertStorageMarkerBinding(marker, other)).toThrow(expect.objectContaining({ code: "storage_marker_foreign" }));
    }
  });

  it("requires a valid bucket and project identity", () => {
    expect(storageIdentity({ AIQSA_STORAGE_PROJECT: "aiqsa", S3_BUCKET: "aiqsa-uploads" })).toEqual(identity);
    expect(() => storageIdentity({ AIQSA_STORAGE_PROJECT: "", S3_BUCKET: "aiqsa-uploads" }))
      .toThrow(expect.objectContaining({ code: "storage_project_identity_invalid" }));
    expect(() => storageIdentity({ AIQSA_STORAGE_PROJECT: "aiqsa", S3_BUCKET: "../x" }))
      .toThrow(expect.objectContaining({ code: "storage_bucket_invalid" }));
  });
});
