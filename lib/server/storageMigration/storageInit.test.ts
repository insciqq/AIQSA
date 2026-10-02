import { describe, expect, it, vi } from "vitest";
import { createMemoryMigrationBucket } from "@/tests/support/migrationBucket";
import {
  createStorageMarker,
  parseStorageMarker,
  serializeStorageMarker,
  STORAGE_MARKER_KEY
} from "./marker";
import {
  isBundledStorageEndpoint,
  runStorageInit,
  STORAGE_INIT_GUIDANCE,
  type StorageInitInput
} from "./storageInit";

const identity = { bucket: "aiqsa-uploads", composeProject: "aiqsa" };
const now = new Date("2026-09-29T12:00:00.000Z");

function setup(options: { references?: boolean; exists?: boolean } = {}) {
  const target = createMemoryMigrationBucket({}, options.exists ?? false);
  const databaseHasReferences = vi.fn(async () => options.references ?? false);
  const input: StorageInitInput = {
    databaseHasReferences,
    endpoint: "http://minio:9000",
    identity: () => identity,
    now: () => now,
    target: () => target
  };
  return { databaseHasReferences, input, target };
}

function markerObject(project = "aiqsa") {
  return {
    bytes: serializeStorageMarker(createStorageMarker({ ...identity, composeProject: project }, { migration: null, now })),
    contentType: "application/json"
  };
}

describe("storage-init guard", () => {
  it("does nothing for an external endpoint", async () => {
    const { input, target } = setup();
    await expect(runStorageInit({ ...input, endpoint: "https://s3.example.test" }))
      .resolves.toEqual({ marker: null, outcome: "external_endpoint" });
    expect(target.calls).toEqual([]);
    expect(isBundledStorageEndpoint("http://minio:9000/")).toBe(true);
    expect(isBundledStorageEndpoint("http://minio:9001")).toBe(false);
  });

  it("creates the private bucket and a fresh marker once, then passes on the marker", async () => {
    const { input, target } = setup();
    await expect(runStorageInit(input)).resolves.toMatchObject({ outcome: "fresh_marker_created" });
    expect(target.calls).toEqual(["createBucket", "put"]);
    expect(parseStorageMarker(target.objects.get(STORAGE_MARKER_KEY)!.bytes)).toMatchObject({
      bucket: "aiqsa-uploads", composeProject: "aiqsa", migration: null, source: "fresh"
    });
    await expect(runStorageInit(input)).resolves.toMatchObject({ outcome: "marker_valid" });
    expect(target.calls).toEqual(["createBucket", "put"]);
  });

  it.each([
    ["database references without a bucket", { references: true }],
    ["database references with an existing empty bucket", { exists: true, references: true }]
  ])("requires the migration for %s without touching storage", async (_name, options) => {
    const { input, target } = setup(options);
    await expect(runStorageInit(input)).rejects.toMatchObject({ code: "storage_migration_required" });
    expect(target.calls).toEqual([]);
  });

  it("refuses a target that holds objects without a marker", async () => {
    const { databaseHasReferences, input, target } = setup({ exists: true });
    target.objects.set("u1/object", { bytes: Buffer.from("x"), contentType: "text/plain" });
    await expect(runStorageInit(input)).rejects.toMatchObject({ code: "storage_target_unmarked" });
    expect(databaseHasReferences).not.toHaveBeenCalled();
  });

  it("refuses a foreign or invalid marker even when data looks fresh", async () => {
    const foreign = setup({ exists: true });
    foreign.target.objects.set(STORAGE_MARKER_KEY, markerObject("other-project"));
    await expect(runStorageInit(foreign.input)).rejects.toMatchObject({ code: "storage_marker_foreign" });
    const invalid = setup({ exists: true });
    invalid.target.objects.set(STORAGE_MARKER_KEY, { bytes: Buffer.from('{"version":2}'), contentType: "application/json" });
    await expect(runStorageInit(invalid.input)).rejects.toMatchObject({ code: "storage_marker_invalid" });
    expect(foreign.target.calls).toEqual([]);
    expect(invalid.target.calls).toEqual([]);
  });

  it("passes a valid marker without consulting the database", async () => {
    const { databaseHasReferences, input, target } = setup({ exists: true, references: true });
    target.objects.set(STORAGE_MARKER_KEY, markerObject());
    await expect(runStorageInit(input)).resolves.toMatchObject({ outcome: "marker_valid" });
    expect(databaseHasReferences).not.toHaveBeenCalled();
  });

  it("sends an unmigrated installation back through the last release with the migration", () => {
    expect(Object.keys(STORAGE_INIT_GUIDANCE).sort()).toEqual([
      "storage_marker_foreign", "storage_marker_invalid", "storage_migration_required", "storage_target_unmarked"
    ]);
    for (const code of ["storage_migration_required", "storage_target_unmarked"]) {
      const guidance = STORAGE_INIT_GUIDANCE[code]!;
      expect(guidance).toContain("Nothing was changed in object storage");
      expect(guidance).toContain("Restore the PostgreSQL backup taken before this upgrade");
      expect(guidance).toContain("check out v0.2.34 and follow its UPGRADING_FROM_MINIO.md, then upgrade again");
      expect(guidance).not.toContain("migrate-minio-to-seaweedfs");
      expect(guidance).not.toContain("/legacy");
    }
  });
});
