// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PROJECT_RESTORE_SCRIPT } from "./projectArchive";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

type Entry = { name: string; content?: string; type?: "file" | "dir" | "link" | "fifo"; target?: string; mode?: number };
function restore(entries: Entry[], maxBytes = 1024, maxEntries = 20) {
  const directory = mkdtempSync(join(tmpdir(), "aiqsa-archive-"));
  directories.push(directory);
  const archive = join(directory, "seed.tar.gz");
  const project = join(directory, "project");
  mkdirSync(project);
  writeFileSync(join(project, "partial.txt"), "interrupted restore");
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
  const result = spawnSync("python3", ["-c", PROJECT_RESTORE_SCRIPT, archive, project, String(maxBytes), String(maxEntries)], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(readFileSync(join(directory, "outside.txt"), "utf8")).toBe("untouched");
  return { ...result, project };
}

it("restores nested, empty, executable and Unicode files and a confined symlink", () => {
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
  [{ name: "a", type: "link", target: "." }, { name: "b", type: "link", target: "a/../outside.txt" }],
  [{ name: "a", type: "link", target: "inner" }, { name: "a/file", content: "bad" }]
];
it.each(invalidArchives.map((entries) => ({ entries })))("rejects unsupported structure and removes partial files: %j", ({ entries }) => {
  const result = restore(entries);
  expect(result.status).toBe(65);
  expect(readdirSync(result.project)).toEqual([]);
});

it("bounds expanded file bytes and entry counts, and supports an empty project", () => {
  const large = restore([{ name: "large", content: "x".repeat(1025) }]);
  expect(large.status).toBe(67);
  expect(readdirSync(large.project)).toEqual([]);
  const many = restore([{ name: "a" }, { name: "b" }], 1024, 1);
  expect(many.status).toBe(67);
  expect(readdirSync(many.project)).toEqual([]);
  const empty = restore([]);
  expect(empty.status).toBe(0);
  expect(readdirSync(empty.project)).toEqual([]);
});
