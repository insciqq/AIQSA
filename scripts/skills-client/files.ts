import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { SKILL_ARCHIVE_MAX_ENTRIES, SKILL_FILE_MAX_BYTES, SKILL_MAX_FILES } from "../../lib/contracts/skills";
import { SKILLS_MCP_PACKAGE_MAX_BYTES, type SkillStoreDownload, type SkillStoreManifestFile } from "../../lib/contracts/skillsMcp";
import { isSafeWorkspaceRelativePath } from "../../lib/domain/workspace";
import { readSkillZip, type SkillImportFile } from "../../lib/server/skills/zipReader";

export class ClientError extends Error {}
export function fail(code: string): never { throw new ClientError(code); }
export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function validatePackage(files: readonly SkillImportFile[]): void {
  if (files.length < 1 || files.length > SKILL_MAX_FILES + 1 || !files.some(file => file.path === "SKILL.md")) fail("package_invalid");
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!isSafeWorkspaceRelativePath(file.path) || /[:\\]/u.test(file.path) || file.path.split("/").some(part => /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail("package_path_invalid");
    const key = file.path.toLowerCase();
    if (paths.has(key) || file.bytes.length > SKILL_FILE_MAX_BYTES) fail("package_invalid");
    paths.add(key);
    total += file.bytes.length;
  }
  if (total > SKILLS_MCP_PACKAGE_MAX_BYTES) fail("package_too_large");
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) if (paths.has(parts.slice(0, i).join("/"))) fail("package_path_invalid");
  }
}

export function manifest(files: readonly SkillImportFile[]): SkillStoreManifestFile[] {
  return files.map(file => ({ path: file.path, checksum: sha256(file.bytes), byteSize: file.bytes.length, executable: file.executable === true }))
    .sort((a, b) => compare(a.path, b.path));
}

export const localDigest = (files: readonly SkillImportFile[]): string => sha256(JSON.stringify(manifest(files)));

export async function recordUploadOrigin(input: {
  directory: string; origin: string; skillId: string; version: number; bundleDigest: string; localDigest: string;
}): Promise<boolean> {
  const destination = resolve(input.directory);
  const path = `${destination}.aiqsa.json`;
  const temporary = `${path}.${randomUUID()}`;
  const lockPath = `${destination}.aiqsa-lock`;
  const lock = await open(lockPath, "wx", 0o600).catch(() => null);
  if (!lock) return false;
  try {
    if (localDigest(await readPackage(destination)) !== input.localDigest) return false;
    const previous = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (previous) {
      if (!previous.isFile() || previous.isSymbolicLink() || previous.size > 16_384) return false;
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.format !== 1 || value.origin !== input.origin || value.skillId !== input.skillId) return false;
    }
    const { directory: _directory, ...origin } = input;
    await writeFile(temporary, JSON.stringify({ format: 1, ...origin }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    return true;
  } catch { return false; /* The remote mutation is already confirmed; local metadata failure cannot undo it. */ }
  finally {
    // Metadata cleanup cannot turn a confirmed remote mutation into a reported failure.
    await rm(temporary, { force: true }).catch(() => undefined);
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/** Refuse symlink traversal in either selected packages or destination ancestors. */
export async function safeAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    const entry = await lstat(cursor).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) fail("directory_unsafe");
  }
}

export async function readPackage(directory: string): Promise<SkillImportFile[]> {
  const root = resolve(directory);
  await safeAncestors(root);
  const files: SkillImportFile[] = [];
  let total = 0;
  let entryCount = 0;
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    if (entries.length > SKILL_MAX_FILES + 1) fail("package_too_large");
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      entryCount += 1;
      if (entryCount > SKILL_ARCHIVE_MAX_ENTRIES) fail("package_too_large");
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail("package_special_file");
      if (path.split("/").length > 32 || Buffer.byteLength(path) > 512) fail("package_path_invalid");
      if (entry.isDirectory()) { await walk(path); continue; }
      const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > SKILL_FILE_MAX_BYTES || before.size + total > SKILLS_MCP_PACKAGE_MAX_BYTES || files.length >= SKILL_MAX_FILES + 1) fail("package_too_large");
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) fail("local_changed");
        files.push({ path, bytes, executable: (before.mode & 0o111) !== 0 });
        total += bytes.length;
      } finally { await handle.close(); }
    }
  }
  await walk("");
  validatePackage(files);
  return files;
}

export function verifiedArchive(bytes: Buffer, detail: SkillStoreDownload): SkillImportFile[] {
  if (!detail.archive || detail.archive.byteSize !== bytes.length || detail.archive.sha256 !== sha256(bytes)) fail("archive_integrity_invalid");
  const files = readSkillZip(bytes);
  validatePackage(files);
  const expected = [...detail.files].sort((a, b) => compare(a.path, b.path));
  const actual = manifest(files);
  if (expected.length !== actual.length || actual.some((file, index) => {
    const value = expected[index];
    return !value || file.path !== value.path || file.byteSize !== value.byteSize || file.checksum !== value.checksum || file.executable !== value.executable;
  })) fail("manifest_integrity_invalid");
  return files;
}

export async function installPackage(input: {
  directory: string; files: SkillImportFile[]; origin: string; detail: SkillStoreDownload; replaceDigest?: string;
}): Promise<{ localDigest: string; outcome: "installed" | "unchanged" }> {
  validatePackage(input.files);
  const destination = resolve(input.directory);
  const parent = dirname(destination);
  await safeAncestors(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = `${destination}.aiqsa-lock`;
  const lock = await open(lockPath, "wx", 0o600).catch(() => fail("destination_busy"));
  const staging = join(parent, `.aiqsa-stage-${randomUUID()}`);
  const backup = join(parent, `.aiqsa-backup-${randomUUID()}`);
  const provenancePath = `${destination}.aiqsa.json`;
  const provenanceTemporary = `${provenancePath}.${randomUUID()}`;
  let moved = false;
  let published = false;
  try {
    await safeAncestors(destination);
    const exists = await stat(destination).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    const digest = localDigest(input.files);
    const before = exists ? localDigest(await readPackage(destination)) : null;
    if (exists && before !== digest && (!input.replaceDigest || before !== input.replaceDigest)) fail("local_conflict");
    if (!exists && input.replaceDigest) fail("local_conflict");
    const provenanceStat = await lstat(provenancePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (provenanceStat && (!provenanceStat.isFile() || provenanceStat.isSymbolicLink() || provenanceStat.size > 16_384)) fail("provenance_conflict");
    const existing = provenanceStat ? await readFile(provenancePath, "utf8") : null;
    if (existing) {
      let owned = false;
      try {
        const value = JSON.parse(existing);
        owned = value.format === 1 && typeof value.localDigest === "string";
        if (owned && (value.origin !== input.origin || value.skillId !== input.detail.id) && input.replaceDigest !== before) fail("provenance_identity_conflict");
      } catch (error) { if (error instanceof ClientError) throw error; /* preserve foreign files */ }
      if (!owned) fail("provenance_conflict");
    }
    const provenance = { format: 1, origin: input.origin, skillId: input.detail.id, version: input.detail.version, bundleDigest: input.detail.bundleDigest, localDigest: digest };
    // Prepare metadata before changing the package. It is never part of uploaded content.
    await writeFile(provenanceTemporary, JSON.stringify(provenance, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (before === digest) {
      if (localDigest(await readPackage(destination)) !== before) fail("local_changed");
      await rename(provenanceTemporary, provenancePath);
      return { localDigest: digest, outcome: "unchanged" };
    }
    await mkdir(staging, { mode: 0o700 });
    for (const file of input.files) {
      const path = join(staging, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    }
    if (exists) {
      if (localDigest(await readPackage(destination)) !== before) fail("local_changed");
      await rename(destination, backup);
      moved = true;
      // Recheck after rename so a concurrent edit before the move is retained.
      if (localDigest(await readPackage(backup)) !== before) fail("local_changed");
    } else if (await lstat(destination).then(() => true, () => false)) fail("local_changed");
    await rename(staging, destination);
    published = true;
    await rename(provenanceTemporary, provenancePath);
    moved = false;
    published = false;
    if (exists) await rm(backup, { recursive: true });
    return { localDigest: digest, outcome: "installed" };
  } finally {
    if (published) await rm(destination, { recursive: true });
    if (moved) await rename(backup, destination);
    await rm(staging, { recursive: true, force: true });
    await rm(provenanceTemporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
