// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

function run(target: ReturnType<typeof workspace>, mode: Mode, maxBytes = 1024, maxEntries = 20, injection = "") {
  const result = spawnSync("python3", ["-c", `${injection}\n${PROJECT_RESTORE_SCRIPT}`, target.archive, target.project, String(maxBytes), String(maxEntries), mode], { encoding: "utf8" });
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

// Faults run in a separate process against owned temp directories. They prove
// the on-disk recovery protocol independently of the TypeScript runtime mocks.
const injectionPrelude = `
import errno, json, os, shutil, sys
project_path = sys.argv[2]
parent_path = os.path.dirname(project_path)
staging_path = os.path.join(parent_path, '.project.restore')
previous_path = os.path.join(parent_path, '.project.previous')
journal_path = os.path.join(parent_path, '.project.restore-state')
`;

function oldTree(target: ReturnType<typeof workspace>) {
  mkdirSync(join(target.project, "lower-directory"));
  writeFileSync(join(target.project, "lower-directory", "old.txt"), "nested old bytes");
  symlinkSync("../outside.txt", join(target.project, "old-link"));
}

function expectOldTree(target: ReturnType<typeof workspace>, inode: number) {
  expect(statSync(target.project).ino).toBe(inode);
  expect(readdirSync(target.project).sort()).toEqual(["existing.txt", "lower-directory", "old-link"]);
  expect(readFileSync(join(target.project, "existing.txt"), "utf8")).toBe("existing tree");
  expect(readFileSync(join(target.project, "lower-directory", "old.txt"), "utf8")).toBe("nested old bytes");
  expect(readlinkSync(join(target.project, "old-link"))).toBe("../outside.txt");
  expect(readdirSync(target.directory).sort()).toEqual(SIBLINGS);
}

const replacement: Entry[] = [
  { name: "new.txt", content: "new bytes" },
  { name: "new-directory/nested.txt", content: "nested new bytes" }
];

function expectNewTree(target: ReturnType<typeof workspace>, inode: number) {
  expect(statSync(target.project).ino).toBe(inode);
  expect(readdirSync(target.project).sort()).toEqual(["new-directory", "new.txt"]);
  expect(readFileSync(join(target.project, "new.txt"), "utf8")).toBe("new bytes");
  expect(readFileSync(join(target.project, "new-directory", "nested.txt"), "utf8")).toBe("nested new bytes");
  expect(readdirSync(target.directory).sort()).toEqual(SIBLINGS);
}

it("keeps the project root when overlayfs refuses renaming old lower/merged directories", () => {
  const target = workspace(replacement);
  oldTree(target);
  const inode = statSync(target.project).ino;
  const injected = `${injectionPrelude}
rename = os.rename
def refuse_lower(source, destination):
    if source == project_path or source.startswith(project_path + '/'):
        raise OSError(errno.EXDEV, 'synthetic lower layer')
    return rename(source, destination)
os.rename = refuse_lower
`;
  expect(run(target, "restore", 1024, 20, injected).status).toBe(0);
  expectNewTree(target, inode);
});

it("keeps the original tree if the rollback snapshot runs out of space", () => {
  const target = workspace(replacement);
  oldTree(target);
  const inode = statSync(target.project).ino;
  const injected = `${injectionPrelude}
copyfile = shutil.copyfile
def fail_backup(source, destination, **kwargs):
    result = copyfile(source, destination, **kwargs)
    if destination.startswith(previous_path + '/'):
        raise OSError(errno.ENOSPC, 'synthetic capacity failure')
    return result
shutil.copyfile = fail_backup
`;
  expect(run(target, "restore", 1024, 20, injected).status).toBe(68);
  expectOldTree(target, inode);
});

const crashDuringInstall = `${injectionPrelude}
rename = os.rename
def crash_install(source, destination):
    result = rename(source, destination)
    if source.startswith(staging_path + '/'): os._exit(91)
    return result
os.rename = crash_install
`;

const interruptions = [
  ["while copying the rollback snapshot", `${injectionPrelude}
copyfile = shutil.copyfile
def crash_backup(source, destination, **kwargs):
    result = copyfile(source, destination, **kwargs)
    if destination.startswith(previous_path + '/'): os._exit(91)
    return result
shutil.copyfile = crash_backup
`, false],
  ["after recording replacement intent", `${injectionPrelude}
replace = os.replace
def crash_intent(source, destination):
    result = replace(source, destination)
    if destination == journal_path: os._exit(91)
    return result
os.replace = crash_intent
`, false],
  ["while clearing old entries", `${injectionPrelude}
rmtree = shutil.rmtree
def crash_clear(path, *args, **kwargs):
    result = rmtree(path, *args, **kwargs)
    if path.startswith(project_path + '/'): os._exit(91)
    return result
shutil.rmtree = crash_clear
`, false],
  ["while installing new entries", crashDuringInstall, false],
  ["before recording commit", `${injectionPrelude}
replace = os.replace
def crash_before_commit(source, destination):
    if destination == journal_path:
        with open(source) as state:
            if json.load(state)['phase'] == 'committed': os._exit(91)
    return replace(source, destination)
os.replace = crash_before_commit
`, false],
  ["after recording commit", `${injectionPrelude}
replace = os.replace
def crash_after_commit(source, destination):
    result = replace(source, destination)
    if destination == journal_path:
        with open(destination) as state:
            if json.load(state)['phase'] == 'committed': os._exit(91)
    return result
os.replace = crash_after_commit
`, true]
] as const;

it.each(interruptions)("recovers interruption %s", (_label, injected, committed) => {
  const target = workspace(replacement);
  oldTree(target);
  const inode = statSync(target.project).ino;
  expect(run(target, "restore", 1024, 20, injected).status).toBe(91);
  expect(run(target, "recover").status).toBe(0);
  (committed ? expectNewTree : expectOldTree)(target, inode);
  // No journal or snapshot remains; a repeated recovery has no side effects.
  expect(run(target, "recover").status).toBe(0);
  (committed ? expectNewTree : expectOldTree)(target, inode);
});

it.each(["process loss", "I/O failure"] as const)("can restart recovery after %s without consuming its rollback snapshot", (failure) => {
  const target = workspace(replacement);
  oldTree(target);
  const inode = statSync(target.project).ino;
  expect(run(target, "restore", 1024, 20, crashDuringInstall).status).toBe(91);
  const injected = `${injectionPrelude}
copyfile = shutil.copyfile
def crash_rollback(source, destination, **kwargs):
    result = copyfile(source, destination, **kwargs)
    if destination.startswith(project_path + '/'):
        ${failure === "process loss" ? "os._exit(91)" : "raise OSError(errno.ENOSPC, 'synthetic rollback capacity failure')"}
    return result
shutil.copyfile = crash_rollback
`;
  expect(run(target, "recover", 1024, 20, injected).status).toBe(failure === "process loss" ? 91 : 69);
  expect(readFileSync(join(target.directory, ".project.previous", "existing.txt"), "utf8")).toBe("existing tree");
  expect(readFileSync(join(target.directory, ".project.previous", "lower-directory", "old.txt"), "utf8")).toBe("nested old bytes");
  expect(run(target, "recover").status).toBe(0);
  expectOldTree(target, inode);
});

it("keeps the recovery obligation when its backup is missing or its journal is invalid", () => {
  const target = workspace(replacement);
  expect(run(target, "restore", 1024, 20, crashDuringInstall).status).toBe(91);
  const installed = readdirSync(target.project);
  rmSync(join(target.directory, ".project.previous"), { recursive: true });
  expect(run(target, "recover").status).toBe(69);
  expect(readdirSync(target.project)).toEqual(installed);
  expect(JSON.parse(readFileSync(join(target.directory, ".project.restore-state"), "utf8"))).toMatchObject({ phase: "replacing" });
  writeFileSync(join(target.directory, ".project.restore-state"), "invalid");
  expect(run(target, "recover").status).toBe(69);
  expect(readdirSync(target.project)).toEqual(installed);
});

it("sweeps uncommitted scratch directories without changing the project", () => {
  const target = workspace(replacement);
  mkdirSync(join(target.directory, ".project.previous"));
  writeFileSync(join(target.directory, ".project.previous", "partial.txt"), "partial backup");
  mkdirSync(join(target.directory, ".project.restore"));
  expect(run(target, "recover").status).toBe(0);
  expect(readdirSync(target.directory).sort()).toEqual(SIBLINGS);
  expectUntouched(target.project);
});

it("restores into an absent project and rolls an interrupted first install back to absence", () => {
  const target = workspace(replacement);
  rmSync(target.project, { recursive: true });
  expect(run(target, "restore", 1024, 20, crashDuringInstall).status).toBe(91);
  expect(run(target, "recover").status).toBe(0);
  expect(readdirSync(target.directory).sort()).toEqual(["outside.txt", "seed.tar.gz"]);
  expect(run(target, "restore").status).toBe(0);
  expectNewTree(target, statSync(target.project).ino);
});

it("rolls a synchronous installation failure back before reporting failure", () => {
  const target = workspace(replacement);
  oldTree(target);
  const inode = statSync(target.project).ino;
  const injected = `${injectionPrelude}
rename = os.rename
def fail_install(source, destination):
    result = rename(source, destination)
    if source.startswith(staging_path + '/'):
        raise OSError(errno.EIO, 'synthetic installation failure')
    return result
os.rename = fail_install
`;
  expect(run(target, "restore", 1024, 20, injected).status).toBe(68);
  expectOldTree(target, inode);
});
