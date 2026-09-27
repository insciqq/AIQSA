// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PROJECT_RESTORE_SCRIPT } from "./projectArchive";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

type Entry = { name: string; content?: string; type?: "file" | "dir" | "link" | "fifo"; target?: string; mode?: number };
type Mode = "verify" | "restore" | "recover";
const SIBLINGS = ["outside.txt", "project", "seed.tar.gz"];

function workspace(entries: Entry[]) {
  const directory = mkdtempSync(join(tmpdir(), "aiqsa-archive-"));
  directories.push(directory);
  const archive = join(directory, "seed.tar.gz");
  const project = join(directory, "project");
  mkdirSync(project);
  writeFileSync(join(project, "existing.txt"), "existing tree");
  writeFileSync(join(directory, "outside.txt"), "untouched");
  execFileSync("python3", ["-c", `
import io, json, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as tar:
    for entry in json.loads(sys.argv[2]):
        member = tarfile.TarInfo(entry['name'])
        member.mode = entry.get('mode', 0o644)
        member.type = {'file': tarfile.REGTYPE, 'dir': tarfile.DIRTYPE, 'link': tarfile.SYMTYPE, 'fifo': tarfile.FIFOTYPE}[entry.get('type', 'file')]
        member.linkname = entry.get('target', '')
        data = entry.get('content', '').encode()
        member.size = len(data)
        tar.addfile(member, io.BytesIO(data))
`, archive, JSON.stringify(entries)]);
  return { archive, directory, project };
}

function run(target: ReturnType<typeof workspace>, mode: Mode, maxBytes = 1024, maxEntries = 20) {
  const result = spawnSync("python3", ["-c", PROJECT_RESTORE_SCRIPT, target.archive, target.project, String(maxBytes), String(maxEntries), mode], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(readFileSync(join(target.directory, "outside.txt"), "utf8")).toBe("untouched");
  return result;
}

function restore(entries: Entry[], maxBytes = 1024, maxEntries = 20, mode: Mode = "restore") {
  const target = workspace(entries);
  const result = run(target, mode, maxBytes, maxEntries);
  // Staging and the swapped-out tree never outlive a settled invocation.
  expect(readdirSync(target.directory).sort()).toEqual(SIBLINGS);
  return { ...result, project: target.project };
}

function expectUntouched(project: string) {
  expect(readdirSync(project)).toEqual(["existing.txt"]);
  expect(readFileSync(join(project, "existing.txt"), "utf8")).toBe("existing tree");
}

it("replaces the tree with nested, empty, executable and Unicode files and a confined symlink", () => {
  const result = restore([
    { name: "./", type: "dir", mode: 0o755 },
    { name: "./nested/путь с пробелами.sh", content: "echo exact\n", mode: 0o755 },
    { name: "./empty", content: "" },
    { name: "./alias", type: "link", target: "nested/путь с пробелами.sh" }
  ]);
  expect(result.status).toBe(0);
  expect(readFileSync(join(result.project, "alias"), "utf8")).toBe("echo exact\n");
  expect(readlinkSync(join(result.project, "alias"))).toBe("nested/путь с пробелами.sh");
  expect(statSync(join(result.project, "nested/путь с пробелами.sh")).mode & 0o777).toBe(0o755);
  expect(statSync(join(result.project, "empty")).size).toBe(0);
  expect(readdirSync(result.project).sort()).toEqual(["alias", "empty", "nested"]);
});

const invalidArchives: Entry[][] = [
  [{ name: "../outside.txt", content: "bad" }],
  [{ name: "/absolute.txt", content: "bad" }],
  [{ name: "pipe", type: "fifo" }],
  [{ name: "escape", type: "link", target: "../outside.txt" }],
  [{ name: "absolute", type: "link", target: "/etc/passwd" }],
  // Detected only after extraction into staging, before the swap.
  [{ name: "a", type: "link", target: "." }, { name: "b", type: "link", target: "a/../outside.txt" }],
  [{ name: "a", type: "link", target: "inner" }, { name: "a/file", content: "bad" }],
  [{ name: "twice", content: "a" }, { name: "twice", content: "b" }]
];
it.each(invalidArchives.map((entries) => ({ entries })))("rejects unsupported structure and keeps the existing tree: %j", ({ entries }) => {
  const result = restore(entries);
  expect(result.status).toBe(65);
  expectUntouched(result.project);
});

it("bounds expanded file bytes and entry counts at their exact limits without touching the tree", () => {
  const exactBytes = restore([{ name: "a", content: "x".repeat(512) }, { name: "b", content: "y".repeat(512) }]);
  expect(exactBytes.status).toBe(0);
  expect(readdirSync(exactBytes.project).sort()).toEqual(["a", "b"]);
  const large = restore([{ name: "a", content: "x".repeat(512) }, { name: "b", content: "y".repeat(513) }]);
  expect(large.status).toBe(67);
  expectUntouched(large.project);
  expect(restore([{ name: "a" }, { name: "b" }], 1024, 2).status).toBe(0);
  const many = restore([{ name: "a" }, { name: "b" }, { name: "c" }], 1024, 2);
  expect(many.status).toBe(67);
  expectUntouched(many.project);
  const empty = restore([]);
  expect(empty.status).toBe(0);
  expect(readdirSync(empty.project)).toEqual([]);
});

it("verifies the same structure and bounds without writing anything", () => {
  const valid = restore([{ name: "a", content: "x" }], 1024, 20, "verify");
  expect(valid.status).toBe(0);
  expectUntouched(valid.project);
  const many = restore([{ name: "a" }, { name: "b" }], 1024, 1, "verify");
  expect(many.status).toBe(67);
  expectUntouched(many.project);
  expect(restore([{ name: "large", content: "x".repeat(1025) }], 1024, 20, "verify").status).toBe(67);
  expect(restore([{ name: "escape", type: "link", target: "../outside.txt" }], 1024, 20, "verify").status).toBe(65);
});

it("rolls an interrupted swap back to the previous tree and removes staging", () => {
  const target = workspace([{ name: "new.txt", content: "new" }]);
  // Crash between the two commit renames: the old tree is only at `previous`.
  renameSync(target.project, join(target.directory, ".project.previous"));
  mkdirSync(join(target.directory, ".project.restore"));
  writeFileSync(join(target.directory, ".project.restore", "partial.txt"), "partial");
  expect(run(target, "recover").status).toBe(0);
  expect(readdirSync(target.directory).sort()).toEqual(SIBLINGS);
  expectUntouched(target.project);
});

it("keeps a committed tree and sweeps leftovers before the next restore", () => {
  const target = workspace([{ name: "new.txt", content: "new" }]);
  mkdirSync(join(target.directory, ".project.previous"));
  writeFileSync(join(target.directory, ".project.previous", "old.txt"), "old");
  mkdirSync(join(target.directory, ".project.restore"));
  expect(run(target, "recover").status).toBe(0);
  expect(readdirSync(target.directory).sort()).toEqual(SIBLINGS);
  expectUntouched(target.project);
  mkdirSync(join(target.directory, ".project.restore"));
  writeFileSync(join(target.directory, ".project.restore", "stale.txt"), "stale");
  expect(run(target, "restore").status).toBe(0);
  expect(readdirSync(target.directory).sort()).toEqual(SIBLINGS);
  expect(readdirSync(target.project)).toEqual(["new.txt"]);
  expect(readFileSync(join(target.project, "new.txt"), "utf8")).toBe("new");
});
