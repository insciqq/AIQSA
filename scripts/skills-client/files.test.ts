import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillStoreDownload } from "../../lib/contracts/skillsMcp";
import { writeZip } from "../../lib/server/artifacts/zip";
import { installPackage, localDigest, manifest, readPackage, recordUploadOrigin, sha256, validatePackage, verifiedArchive } from "./files";

const fixtures = [
  { path: "SKILL.md", bytes: Buffer.from("---\nname: fixture\ndescription: A package\n---\nUse the included template.\n"), executable: false },
  { path: "templates/example.docx", bytes: Buffer.from([80, 75, 0, 255, 1, 2, 3]), executable: false },
  { path: "scripts/check.sh", bytes: Buffer.from("#!/bin/sh\nexit 0\n"), executable: true }
];
function descriptor(files = fixtures): SkillStoreDownload {
  const bytes = writeZip(files);
  return { id: "owned-skill", version: 1, name: "fixture", description: "A package", bundleDigest: "a".repeat(64), fileCount: files.length - 1, bundleByteSize: files.reduce((sum, file) => sum + file.bytes.length, 0), archived: false, enabled: true, updatedAt: new Date(0).toISOString(), files: manifest(files), archive: { path: "/mcp/skills/bundle?skillId=owned-skill&version=1", byteSize: bytes.length, sha256: sha256(bytes) } };
}
const directories: string[] = [];
const root = async () => { const value = await mkdtemp(join(tmpdir(), "aiqsa-skills-client-test-")); directories.push(value); return value; };
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("portable package verification and installation", () => {
  it("round trips binary files and executable bits without executing code", async () => {
    const detail = descriptor();
    const files = verifiedArchive(writeZip(fixtures), detail);
    const directory = join(await root(), "native", "fixture");
    const result = await installPackage({ directory, files, origin: "https://aiqsa.example", detail });
    expect(result).toEqual({ outcome: "installed", localDigest: localDigest(fixtures) });
    expect(manifest(await readPackage(directory))).toEqual(manifest(fixtures));
    expect((await stat(join(directory, "scripts/check.sh"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "templates/example.docx"))).mode & 0o777).toBe(0o600);
    const provenance = JSON.parse(await readFile(`${directory}.aiqsa.json`, "utf8"));
    expect(provenance).toMatchObject({ origin: "https://aiqsa.example", skillId: detail.id, version: 1, localDigest: result.localDigest });
    expect(await installPackage({ directory, files, origin: "https://aiqsa.example", detail })).toMatchObject({ outcome: "unchanged" });
  });

  it("preserves local edits unless their exact current digest was selected", async () => {
    const directory = join(await root(), "fixture");
    const input = { directory, files: fixtures, detail: descriptor(), origin: "https://aiqsa.example" };
    await installPackage(input);
    await writeFile(join(directory, "SKILL.md"), "Local changes that must remain");
    const digest = localDigest(await readPackage(directory));
    await expect(installPackage(input)).rejects.toThrow("local_conflict");
    await expect(installPackage({ ...input, replaceDigest: "b".repeat(64) })).rejects.toThrow("local_conflict");
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("Local changes that must remain");
    expect(await installPackage({ ...input, replaceDigest: digest })).toMatchObject({ outcome: "installed" });
    expect(localDigest(await readPackage(directory))).toBe(localDigest(fixtures));
  });

  it("rejects mismatched archive bytes, manifests, duplicate and traversing paths", () => {
    const bytes = writeZip(fixtures);
    const detail = descriptor();
    expect(() => verifiedArchive(Buffer.concat([bytes, Buffer.from([0])]), detail)).toThrow("archive_integrity_invalid");
    detail.files[1]!.checksum = "0".repeat(64);
    expect(() => verifiedArchive(bytes, detail)).toThrow("manifest_integrity_invalid");
    for (const path of ["../escape", "/escape", "A:\\escape", "file:stream", "a/../../escape", "a/CON", "a/b."]) {
      expect(() => validatePackage([...fixtures, { path, bytes: Buffer.from("x") }])).toThrow();
    }
    expect(() => validatePackage([...fixtures, { path: "skill.md", bytes: Buffer.from("x") }])).toThrow();
    expect(() => validatePackage([...fixtures, { path: "templates", bytes: Buffer.from("x") }])).toThrow();
  });

  it("refuses source and destination symlinks without following their contents", async () => {
    const directory = join(await root(), "fixture");
    await installPackage({ directory, files: fixtures, detail: descriptor(), origin: "https://aiqsa.example" });
    await symlink(join(directory, "SKILL.md"), join(directory, "secret"));
    await expect(readPackage(directory)).rejects.toThrow("package_special_file");
    const other = join(await root(), "linked");
    await symlink(directory, other);
    await expect(installPackage({ directory: other, files: fixtures, detail: descriptor(), origin: "https://aiqsa.example" })).rejects.toThrow("directory_unsafe");
  });

  it("checks provenance conflicts before changing an existing local package", async () => {
    const directory = join(await root(), "fixture");
    await installPackage({ directory, files: fixtures, detail: descriptor(), origin: "https://aiqsa.example" });
    const updated = fixtures.map(file => file.path === "SKILL.md" ? { ...file, bytes: Buffer.from("Updated") } : file);
    await writeFile(`${directory}.aiqsa.json`, "A foreign file that must be retained");
    await expect(installPackage({ directory, files: updated, detail: descriptor(updated), origin: "https://aiqsa.example", replaceDigest: localDigest(fixtures) })).rejects.toThrow("provenance_conflict");
    expect(localDigest(await readPackage(directory))).toBe(localDigest(fixtures));
    expect(await readFile(`${directory}.aiqsa.json`, "utf8")).toBe("A foreign file that must be retained");
  });

  it("records confirmed uploads without reassigning another Skill or hiding local edits", async () => {
    const directory = join(await root(), "fixture");
    const detail = descriptor();
    const origin = "https://aiqsa.example";
    await installPackage({ directory, files: fixtures, detail, origin });
    const input = { directory, origin, skillId: detail.id, version: 2, bundleDigest: "f".repeat(64), localDigest: localDigest(fixtures) };
    expect(await recordUploadOrigin(input)).toBe(true);
    expect(JSON.parse(await readFile(`${directory}.aiqsa.json`, "utf8")).version).toBe(2);
    expect(await recordUploadOrigin({ ...input, skillId: "another-skill" })).toBe(false);
    await writeFile(join(directory, "SKILL.md"), "Concurrent local edit");
    expect(await recordUploadOrigin({ ...input, version: 3 })).toBe(false);
    expect(JSON.parse(await readFile(`${directory}.aiqsa.json`, "utf8")).version).toBe(2);
  });
});
