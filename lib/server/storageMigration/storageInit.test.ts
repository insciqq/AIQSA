import { describe, expect, it, vi } from "vitest";
import { createMemoryMigrationBucket } from "@/tests/support/migrationBucket";
import type { LegacyLayout } from "./legacyLayout";
import {
  createStorageMarker,
  parseStorageMarker,
  serializeStorageMarker,
  STORAGE_MARKER_KEY,
  StorageMigrationError
} from "./marker";
import { isBundledStorageEndpoint, runStorageInit, type StorageInitInput } from "./storageInit";

const identity = { bucket: "aiqsa-uploads", composeProject: "aiqsa" };
const now = new Date("2026-09-29T12:00:00.000Z");

function setup(options: { legacy?: LegacyLayout | Error; references?: boolean; exists?: boolean } = {}) {
  const target = createMemoryMigrationBucket({}, options.exists ?? false);
  const databaseHasReferences = vi.fn(async () => options.references ?? false);
  const legacyLayout = vi.fn(async () => {
    if (options.legacy instanceof Error) throw options.legacy;
    return options.legacy ?? { kind: "empty" as const };
  });
  const input: StorageInitInput = {
    databaseHasReferences,
    endpoint: "http://minio:9000",
    identity: () => identity,
    legacyLayout,
    now: () => now,
    target: () => target
  };
  return { databaseHasReferences, input, legacyLayout, target };
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

  it("treats a MinIO layout without objects and without references as fresh", async () => {
    const { input } = setup({ legacy: { hasObjects: false, kind: "minio" } });
    await expect(runStorageInit(input)).resolves.toMatchObject({ outcome: "fresh_marker_created" });
  });

  it.each([
    ["legacy objects", { legacy: { hasObjects: true, kind: "minio" } as LegacyLayout }],
    ["database references with an empty legacy volume", { references: true }],
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

  it("passes a valid marker without consulting the legacy volume or the database", async () => {
    const { databaseHasReferences, input, legacyLayout, target } = setup({ exists: true, references: true });
    target.objects.set(STORAGE_MARKER_KEY, markerObject());
    await expect(runStorageInit(input)).resolves.toMatchObject({ outcome: "marker_valid" });
    expect(legacyLayout).not.toHaveBeenCalled();
    expect(databaseHasReferences).not.toHaveBeenCalled();
  });

  it("propagates an unknown legacy layout", async () => {
    const { input, target } = setup({ legacy: new StorageMigrationError("storage_legacy_layout_unknown") });
    await expect(runStorageInit(input)).rejects.toMatchObject({ code: "storage_legacy_layout_unknown" });
    expect(target.calls).toEqual([]);
  });
});
