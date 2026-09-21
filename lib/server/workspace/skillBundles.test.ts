import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { tarEndBlocks, tarEntryBlocks, type TarEntry } from "../chats/tarArchive";
import { SKILL_FILE_MAX_BYTES } from "@/lib/contracts/skills";
import { parseSkillArchive, readSkillArchive, SKILL_RUNTIME_ARCHIVE_MAX_BYTES, SKILL_RUNTIME_CONTENT_MAX_BYTES,
  SKILL_RUNTIME_MARKDOWN_MAX_BYTES, validateSkillArchiveMetadata } from "./skillBundles";
import { WORKSPACE_SKILL_GUEST_SCRIPT } from "./skillGuest";

function tar(entries: Array<Partial<TarEntry> & { path: string }>): Buffer {
  return Buffer.concat([...entries.flatMap(entry => tarEntryBlocks({ content: "synthetic", mtime: new Date(0), ...entry })), tarEndBlocks()]);
}
function checksum(header: Buffer): void {
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
}
function mutate(change: (header: Buffer) => void): Buffer {
  const bytes = tar([{ path: "SKILL.md" }, { path: "safe.txt" }]);
  const header = bytes.subarray(1024, 1536); change(header); checksum(header); return bytes;
}
const hostile = [
  ...["1", "2", "3", "4", "6", "x", "g"].map(type => ({ name: `type-${type}`, bytes: mutate(header => { header[156] = type.charCodeAt(0); }) })),
  ...["../outside", "/absolute", "a/../outside", "a\\outside"].map(path => ({ name: path, bytes: mutate(header => { header.fill(0, 0, 100); header.write(path); }) })),
  { name: "invalid utf8", bytes: mutate(header => { header[0] = 255; }) },
  { name: "privileged mode", bytes: mutate(header => { header.write("0004755\0", 100); }) },
  { name: "duplicate case", bytes: tar([{ path: "SKILL.md" }, { path: "skill.md" }]) },
  { name: "ancestor file", bytes: tar([{ path: "SKILL.md" }, { path: "a" }, { path: "a/b" }]) },
  { name: "ancestor case", bytes: tar([{ path: "SKILL.md" }, { path: "A/b" }, { path: "a/c" }]) },
  { name: "missing root", bytes: tar([{ path: "nested/SKILL.md" }]) },
  { name: "tail payload", bytes: Buffer.concat([tar([{ path: "SKILL.md" }]), Buffer.from([1])]) }
];

async function guestFixture() {
  const directory = await mkdtemp(join(tmpdir(), "aiqsa-skill-guest-"));
  const script = WORKSPACE_SKILL_GUEST_SCRIPT.replaceAll("/tmp", `${directory}/tmp`)
    .replaceAll("/workspace", `${directory}/workspace`).replaceAll("/root", `${directory}/root`);
  const root = join(directory, "workspace/.aiqsa/skills");
  const discovery = join(directory, "root/.agents/skills");
  const run = (value: unknown) => spawnSync("python3", ["-I", "-c", script], {
    input: JSON.stringify(value), encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024
  }).status;
  await mkdir(join(directory, "tmp"), { recursive: true });
  return {
    directory, root, discovery, run,
    async install(raw: Uint8Array, alias = "example") {
      const archive = gzipSync(raw);
      const archivePath = join(directory, `tmp/aiqsa-skill-${randomUUID()}.tar.gz`);
      await writeFile(archivePath, archive);
      return run({ action: "install", alias, archivePath, byteSize: archive.length, checksum: createHash("sha256").update(archive).digest("hex") });
    },
    async cleanup() { await rm(directory, { force: true, recursive: true }); }
  };
}

describe("bounded Skill ustar receiver", () => {
  it.each(hostile)("rejects $name before publishing files", ({ bytes }) => {
    expect(() => parseSkillArchive(gzipSync(bytes))).toThrow("workspace_skill_bundle_invalid");
  });

  it("preserves exact UTF-8 boundary paths, modes and empty files", () => {
    const path = `${"я".repeat(77)}x/${"界".repeat(33)}x`;
    const entries = parseSkillArchive(gzipSync(tar([{ path: "SKILL.md" }, { path, mode: 0o755, content: "" }])));
    expect(entries[1]).toMatchObject({ path, mode: 0o755, directory: false });
    expect(entries[1]!.content.length).toBe(0);
  });

  it("enforces file/content boundaries including generated Markdown overhead", () => {
    const markdown = Buffer.alloc(64 * 1024, 109);
    const file = Buffer.alloc(SKILL_FILE_MAX_BYTES, 97);
    const entries = [{ path: "SKILL.md", content: markdown }, ...["a", "b", "c"].map(path => ({ path, content: file }))];
    expect(entries.reduce((sum, entry) => sum + entry.content.length, 0)).toBe(SKILL_RUNTIME_CONTENT_MAX_BYTES);
    expect(parseSkillArchive(gzipSync(tar(entries)))).toHaveLength(4);
    expect(() => parseSkillArchive(gzipSync(tar([...entries, { path: "extra", content: "x" }])))).toThrow("workspace_skill_bundle_limit_exceeded");
    expect(() => parseSkillArchive(gzipSync(tar([{ path: "SKILL.md" }, { path: "oversize", content: Buffer.alloc(SKILL_FILE_MAX_BYTES + 1) }])))).toThrow("workspace_skill_bundle_limit_exceeded");
    expect(() => parseSkillArchive(gzipSync(tar([{ path: "SKILL.md", content: Buffer.alloc(SKILL_RUNTIME_MARKDOWN_MAX_BYTES + 1) }])))).toThrow("workspace_skill_bundle_limit_exceeded");
  });

  it("bounds compressed transport and verifies exact bytes and checksum", async () => {
    expect(() => validateSkillArchiveMetadata({ byteSize: SKILL_RUNTIME_ARCHIVE_MAX_BYTES + 1, checksum: "a".repeat(64) })).toThrow("workspace_skill_bundle_limit_exceeded");
    const bytes = gzipSync(tar([{ path: "SKILL.md" }]));
    const base = { sessionId: "session", modelRunId: "run", runtimeSandboxId: "guest", manifestHash: "a".repeat(64),
      bundle: { alias: "example", revisionId: "revision", bundleDigest: "b".repeat(64), discover: false },
      checksum: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
    const stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    await expect(readSkillArchive({ ...base, archive: stream() })).resolves.toEqual(bytes);
    await expect(readSkillArchive({ ...base, checksum: "c".repeat(64), archive: stream() })).rejects.toThrow("workspace_skill_bundle_invalid");
    await expect(readSkillArchive({ ...base, byteSize: bytes.length - 1, archive: stream() })).rejects.toThrow("workspace_skill_bundle_limit_exceeded");
  });

  it("independently rejects every hostile archive inside the real Python extractor without changing an existing alias", async () => {
    const guest = await guestFixture();
    try {
      expect(guest.run({ action: "reset" })).toBe(0);
      expect(await guest.install(tar([{ path: "SKILL.md", content: "old owned bytes" }]))).toBe(0);
      for (const value of hostile) {
        expect(await guest.install(value.bytes), value.name).toBe(65);
        expect(await readFile(join(guest.root, "example/SKILL.md"), "utf8")).toBe("old owned bytes");
      }
    } finally { await guest.cleanup(); }
  });

  it("atomically replaces complete aliases, fixes modes, publishes only available links and resets stale names", async () => {
    const guest = await guestFixture();
    try {
      expect(guest.run({ action: "reset" })).toBe(0);
      expect(await guest.install(tar([{ path: "SKILL.md" }, { path: "old.txt" }]))).toBe(0);
      expect(await guest.install(tar([{ path: "SKILL.md" }, { path: "scripts/run", mode: 0o755 }]))).toBe(0);
      expect(await readdir(join(guest.root, "example"))).toEqual(["SKILL.md", "scripts"]);
      expect((await stat(join(guest.root, "example/scripts/run"))).mode & 0o777).toBe(0o755);
      expect((await stat(join(guest.root, "example/SKILL.md"))).mode & 0o777).toBe(0o644);
      expect((await stat(join(guest.root, "example/scripts"))).mode & 0o777).toBe(0o755);
      expect(await guest.install(tar([{ path: "SKILL.md" }]), "pinned")).toBe(0);
      expect(guest.run({ action: "links", aliases: ["example"] })).toBe(0);
      expect(await readdir(guest.discovery)).toEqual(["example"]);
      expect(await readlink(join(guest.discovery, "example"))).toBe(join(guest.root, "example"));
      expect(guest.run({ action: "reset" })).toBe(0);
      expect(await readdir(guest.root)).toEqual([]);
      expect(await readdir(guest.discovery)).toEqual([]);
    } finally { await guest.cleanup(); }
  });

  it("rejects symlinked fixed ancestors without following them", async () => {
    const guest = await guestFixture();
    try {
      await mkdir(join(guest.directory, "outside"));
      await symlink(join(guest.directory, "outside"), join(guest.directory, "workspace"));
      expect(guest.run({ action: "reset" })).toBe(65);
      expect(await readdir(join(guest.directory, "outside"))).toEqual([]);
    } finally { await guest.cleanup(); }
  });
});
