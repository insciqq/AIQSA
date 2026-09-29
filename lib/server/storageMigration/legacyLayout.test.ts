import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLegacyLayout, measureLegacyUsage } from "./legacyLayout";

const roots: string[] = [];

function root(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "aiqsa-legacy-layout-"));
  roots.push(directory);
  return directory;
}

function write(base: string, relative: string, content = "x"): void {
  mkdirSync(path.dirname(path.join(base, relative)), { recursive: true });
  writeFileSync(path.join(base, relative), content);
}

function minio(base: string, format = '{"version":"1","format":"xl-single","id":"x"}'): void {
  write(base, ".minio.sys/format.json", format);
  write(base, ".minio.sys/buckets/aiqsa-uploads/.metadata.bin/xl.meta");
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("legacy MinIO layout", () => {
  it("treats a missing or empty volume as empty", async () => {
    await expect(inspectLegacyLayout(path.join(root(), "missing"), "aiqsa-uploads")).resolves.toEqual({ kind: "empty" });
    const empty = root();
    mkdirSync(path.join(empty, "lost+found"));
    await expect(inspectLegacyLayout(empty, "aiqsa-uploads")).resolves.toEqual({ kind: "empty" });
  });

  it("recognizes objects only below the configured bucket", async () => {
    const base = root();
    minio(base);
    await expect(inspectLegacyLayout(base, "aiqsa-uploads")).resolves.toEqual({ hasObjects: false, kind: "minio" });
    mkdirSync(path.join(base, "aiqsa-uploads", "prefix"), { recursive: true });
    await expect(inspectLegacyLayout(base, "aiqsa-uploads")).resolves.toEqual({ hasObjects: false, kind: "minio" });
    write(base, "other-bucket/key/xl.meta");
    await expect(inspectLegacyLayout(base, "aiqsa-uploads")).resolves.toEqual({ hasObjects: false, kind: "minio" });
    write(base, "aiqsa-uploads/prefix/deep/key/xl.meta");
    await expect(inspectLegacyLayout(base, "aiqsa-uploads")).resolves.toEqual({ hasObjects: true, kind: "minio" });
  });

  it.each([
    ["unrelated files", (base: string) => write(base, "data.bin")],
    ["a non-MinIO directory", (base: string) => write(base, ".minio.sys/other")],
    ["another MinIO format", (base: string) => minio(base, '{"version":"1","format":"fs"}')],
    ["an unreadable format", (base: string) => minio(base, "{")],
    ["a bucket file", (base: string) => { minio(base); write(base, "aiqsa-uploads"); }]
  ])("refuses %s", async (_name, arrange) => {
    const base = root();
    arrange(base);
    await expect(inspectLegacyLayout(base, "aiqsa-uploads")).rejects.toMatchObject({ code: "storage_legacy_layout_unknown" });
  });

  it("measures apparent file sizes without reading data", async () => {
    const base = root();
    write(base, "a/b", "12345");
    write(base, "c", "123");
    await expect(measureLegacyUsage(base)).resolves.toEqual({ bytes: 8, files: 2 });
  });
});
