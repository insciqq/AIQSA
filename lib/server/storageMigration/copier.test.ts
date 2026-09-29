import { describe, expect, it, vi } from "vitest";
import { createMemoryMigrationBucket, type MemoryObject } from "@/tests/support/migrationBucket";
import { migrateBucket, type CopyProgress, type MigrationInput } from "./copier";
import {
  createStorageMarker,
  parseStorageMarker,
  serializeStorageMarker,
  STORAGE_MARKER_KEY
} from "./marker";

const identity = { bucket: "aiqsa-uploads", composeProject: "aiqsa" };
const now = new Date("2026-09-29T12:00:00.000Z");

function object(text: string, contentType = "text/plain"): MemoryObject {
  return { bytes: Buffer.from(text), contentType };
}

function sourceObjects(): Record<string, MemoryObject> {
  return {
    "u1/one.txt": object("first object"),
    "u1/two.json": object('{"a":1}', "application/json"),
    "knowledge/objects/zero": { bytes: Buffer.alloc(0), contentType: "application/octet-stream" },
    "big/object": { bytes: Buffer.alloc(40, 7), contentType: "application/pdf" }
  };
}

function setup(options: { references?: string[]; source?: ReturnType<typeof createMemoryMigrationBucket> } = {}) {
  const source = options.source ?? createMemoryMigrationBucket(sourceObjects());
  const target = createMemoryMigrationBucket({}, false);
  const events: CopyProgress[] = [];
  const references = options.references ?? ["u1/one.txt", "missing/key"];
  const settleUploads = vi.fn(async () => 2);
  const input: MigrationInput = {
    concurrency: 2,
    identity,
    listPageSize: 2,
    multipartPartBytes: 16,
    now: () => now,
    progress: (event) => events.push(event),
    references: {
      durablePage: async (after, limit) => references.filter((key) => after === null || key > after).sort().slice(0, limit),
      hasAny: async () => references.length > 0
    },
    settleUploads,
    singlePutMaxBytes: 32,
    source,
    target
  };
  return { events, input, settleUploads, source, target };
}

describe("MinIO bucket migration", () => {
  it("copies exact bytes and ContentType, splits large objects and writes the marker last", async () => {
    const { events, input, settleUploads, source, target } = setup();
    const summary = await migrateBucket(input);

    expect(summary).toMatchObject({
      copied: 4,
      missingReferenceCount: 1,
      objectCount: 4,
      settledUploads: 2,
      totalBytes: 12 + 7 + 0 + 40,
      verifiedExisting: 0
    });
    expect(settleUploads).toHaveBeenCalledTimes(1);
    for (const [key, value] of source.objects) {
      expect(target.objects.get(key)).toEqual({ bytes: value.bytes, contentType: value.contentType });
    }
    expect(target.calls.filter((call) => call === "uploadPart")).toHaveLength(3);
    expect(target.calls.at(-1)).toBe("put");
    const marker = parseStorageMarker(target.objects.get(STORAGE_MARKER_KEY)!.bytes);
    expect(marker).toMatchObject({
      bucket: "aiqsa-uploads",
      composeProject: "aiqsa",
      migration: { missingReferenceCount: 1, objectCount: 4, totalBytes: 59 },
      source: "migrated"
    });
    expect(JSON.stringify(events)).not.toMatch(/u1|knowledge|big|txt/u);
  });

  it("resumes after an interruption without recopying verified objects", async () => {
    const { input, target } = setup();
    let writes = 0;
    target.beforePut = () => {
      writes += 1;
      if (writes === 2) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    };
    await expect(migrateBucket(input)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(target.objects.has(STORAGE_MARKER_KEY)).toBe(false);

    target.beforePut = undefined;
    target.calls.length = 0;
    const summary = await migrateBucket(input);
    expect(summary.verifiedExisting).toBeGreaterThan(0);
    expect(summary.copied).toBeLessThan(4);
    expect(summary.copied + summary.verifiedExisting).toBe(4);
    expect(target.objects.has(STORAGE_MARKER_KEY)).toBe(true);
  });

  it("recopies a target object whose content differs and refuses a mismatched copy", async () => {
    const { input, target } = setup();
    target.exists_ = true;
    target.objects.set("u1/one.txt", object("first objecX"));
    const summary = await migrateBucket(input);
    expect(summary.copied).toBe(4);
    expect(target.objects.get("u1/one.txt")!.bytes.toString()).toBe("first object");

    const corrupted = setup();
    corrupted.target.corrupt = (key, bytes) => key === "u1/two.json" ? Buffer.from("{}xxxxx") : bytes;
    await expect(migrateBucket(corrupted.input)).rejects.toMatchObject({ code: "storage_migrate_verification_failed" });
    expect(corrupted.target.objects.has(STORAGE_MARKER_KEY)).toBe(false);
  });

  it("refuses a target holding objects the source does not have before settling uploads", async () => {
    const { input, settleUploads, target } = setup();
    target.exists_ = true;
    target.objects.set("unrelated/key", object("x"));
    await expect(migrateBucket(input)).rejects.toMatchObject({ code: "storage_migrate_target_unexpected_objects" });
    expect(settleUploads).not.toHaveBeenCalled();
  });

  it("refuses when a marker is already present and never recopies over it", async () => {
    const { input, settleUploads, target } = setup();
    const marker = serializeStorageMarker(createStorageMarker(identity, { migration: null, now }));
    target.exists_ = true;
    target.objects.set(STORAGE_MARKER_KEY, { bytes: marker, contentType: "application/json" });
    await expect(migrateBucket(input)).rejects.toMatchObject({ code: "storage_migrate_marker_present" });
    const foreign = serializeStorageMarker(createStorageMarker({ ...identity, composeProject: "other" }, { migration: null, now }));
    target.objects.set(STORAGE_MARKER_KEY, { bytes: foreign, contentType: "application/json" });
    await expect(migrateBucket(input)).rejects.toMatchObject({ code: "storage_marker_foreign" });
    expect(settleUploads).not.toHaveBeenCalled();
    expect(target.calls).toEqual([]);
  });

  it.each([
    ["versioning", "storage_migrate_source_versioned"],
    ["encryption", "storage_migrate_source_encrypted"],
    ["objectLock", "storage_migrate_source_object_lock"],
    ["policy", "storage_migrate_source_not_private"]
  ] as const)("refuses a source bucket with %s", async (setting, code) => {
    const { input, settleUploads, source, target } = setup();
    source.settings_ = { encryption: false, objectLock: false, policy: false, versioning: false, [setting]: true };
    await expect(migrateBucket(input)).rejects.toMatchObject({ code });
    expect(settleUploads).not.toHaveBeenCalled();
    expect(target.calls).toEqual([]);
  });

  it("refuses an encrypted object", async () => {
    const source = createMemoryMigrationBucket({ key: { ...object("x"), encrypted: true } });
    await expect(migrateBucket(setup({ source }).input)).rejects.toMatchObject({ code: "storage_migrate_source_encrypted" });
  });

  it("refuses an empty source while the database references objects, and migrates a truly empty one", async () => {
    for (const source of [createMemoryMigrationBucket({}), createMemoryMigrationBucket({}, false)]) {
      const { input, target } = setup({ source });
      await expect(migrateBucket(input)).rejects.toMatchObject({ code: "storage_migrate_source_empty_with_references" });
      expect(target.calls).toEqual([]);
    }
    const { input, target } = setup({ references: [], source: createMemoryMigrationBucket({}, false) });
    await expect(migrateBucket(input)).resolves.toMatchObject({ objectCount: 0, totalBytes: 0 });
    expect(parseStorageMarker(target.objects.get(STORAGE_MARKER_KEY)!.bytes).migration?.objectCount).toBe(0);
  });

  it("aborts stale target multipart uploads left by an interrupted run", async () => {
    const { input, target } = setup();
    target.exists_ = true;
    target.uploads.set("stale", { contentType: "x", key: "big/object", parts: new Map() });
    await expect(migrateBucket(input)).resolves.toMatchObject({ abortedTargetUploads: 1 });
  });
});
