// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_WORKSPACE_GUIDES } from "./guideGuest";
import { WORKSPACE_GUIDE_FILES, WORKSPACE_GUIDE_INPUT_MAX_BYTES, workspaceGuideInput } from "./guides";
import { parseWorkspaceFileSelection } from "./outputManifest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiqsa-release-guides-")); roots.push(root);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const script = INSTALL_WORKSPACE_GUIDES.replace("WORKSPACE_ROOT = '/workspace'", `WORKSPACE_ROOT = ${JSON.stringify(workspace)}`);
  const run = (input = workspaceGuideInput(), fault = "") => {
    const result = spawnSync("python3", ["-I", "-c", `${fault}\n${script}`], { input, encoding: "utf8", timeout: 2_000, maxBuffer: 16_384 });
    expect(result.error).toBeUndefined(); expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
    return result.status;
  };
  return { root, workspace, run, directory: join(workspace, "guides") };
}

describe("release guide installation (local filesystem; KVM delivery is separate)", () => {
  it("installs exact release bytes into an old disk and keeps user files and unchanged guide inodes", async () => {
    const value = await fixture();
    await mkdir(join(value.workspace, "project")); await writeFile(join(value.workspace, "project/keep.txt"), "user bytes");
    expect(workspaceGuideInput().byteLength).toBeLessThanOrEqual(WORKSPACE_GUIDE_INPUT_MAX_BYTES);
    expect(value.run()).toBe(0);
    const before = await Promise.all(WORKSPACE_GUIDE_FILES.map(async file => {
      const path = join(value.directory, file.name);
      expect(await readFile(path, "utf8")).toBe(file.content);
      const info = await stat(path); expect(info.mode & 0o777).toBe(0o444); return info.ino;
    }));
    expect(value.run()).toBe(0);
    expect(await Promise.all(WORKSPACE_GUIDE_FILES.map(file => stat(join(value.directory, file.name)).then(info => info.ino)))).toEqual(before);
    expect(await readFile(join(value.workspace, "project/keep.txt"), "utf8")).toBe("user bytes");
    expect((await readdir(value.directory)).sort()).toEqual(WORKSPACE_GUIDE_FILES.map(file => file.name).sort());
  });

  it("replaces stale or linked managed files without changing the other hard-link inode", async () => {
    const value = await fixture(); await mkdir(value.directory);
    const original = join(value.workspace, "original.txt"); await writeFile(original, "original bytes");
    await link(original, join(value.directory, "office.md"));
    await writeFile(join(value.directory, "browser.md"), "older release");
    await writeFile(join(value.directory, "keep.txt"), "unmanaged bytes");
    expect(value.run()).toBe(0);
    expect(await readFile(original, "utf8")).toBe("original bytes");
    expect((await stat(original)).ino).not.toBe((await stat(join(value.directory, "office.md"))).ino);
    expect(await readFile(join(value.directory, "keep.txt"), "utf8")).toBe("unmanaged bytes");
    for (const file of WORKSPACE_GUIDE_FILES) expect(await readFile(join(value.directory, file.name), "utf8")).toBe(file.content);
  });

  it.each(["workspace_link", "directory_link", "file_link", "fifo"])("rejects %s without changing its target", async kind => {
    const value = await fixture(); const target = join(value.root, "target"); await mkdir(target);
    const original = join(target, "original.txt"); await writeFile(original, "keep");
    if (kind === "workspace_link") { await rm(value.workspace, { recursive: true }); await symlink(target, value.workspace); }
    else if (kind === "directory_link") await symlink(target, value.directory);
    else {
      await mkdir(value.directory);
      if (kind === "file_link") await symlink(original, join(value.directory, "office.md"));
      else expect(spawnSync("python3", ["-I", "-c", "import os,sys;os.mkfifo(sys.argv[1])", join(value.directory, "office.md")]).status).toBe(0);
    }
    expect(value.run()).toBe(1); expect(await readFile(original, "utf8")).toBe("keep");
    expect(await readdir(target)).toEqual(["original.txt"]);
    if (kind === "file_link") expect((await lstat(join(value.directory, "office.md"))).isSymbolicLink()).toBe(true);
  });

  it("validates all bounded names and content before modifying existing guides", async () => {
    const value = await fixture(); expect(value.run()).toBe(0);
    const input = () => JSON.parse(workspaceGuideInput().toString()) as { version: number; guides: Array<{ name: string; content: string }> };
    for (const change of [
      (v: ReturnType<typeof input>) => { v.guides[2]!.name = "../project/other"; },
      (v: ReturnType<typeof input>) => { v.guides[2]!.content = "a".repeat(32_769); },
      (v: ReturnType<typeof input>) => { v.guides[2]!.content = "bad\0content"; },
      (v: ReturnType<typeof input>) => { v.version = 2; }
    ]) {
      const body = input(); body.guides[0]!.content = "must not replace"; change(body);
      expect(value.run(Buffer.from(JSON.stringify(body)))).toBe(1);
      expect(await readFile(join(value.directory, "office.md"), "utf8")).toBe(WORKSPACE_GUIDE_FILES[0].content);
    }
    expect(value.run(Buffer.alloc(WORKSPACE_GUIDE_INPUT_MAX_BYTES + 1, 32))).toBe(1);
    await chmod(join(value.directory, "office.md"), 0o644);
    expect(value.run()).toBe(0); expect((await stat(join(value.directory, "office.md"))).mode & 0o777).toBe(0o444);
  });

  it("leaves the prior managed file intact and removes partial staging when replacement fails", async () => {
    const value = await fixture(); await mkdir(value.directory);
    await writeFile(join(value.directory, "office.md"), "previous release");
    const before = await stat(join(value.directory, "office.md"));
    expect(value.run(workspaceGuideInput(), `import errno, os
def failed_replace(*args, **kwargs):
    raise OSError(errno.ENOSPC, 'injected replacement failure')
os.replace = failed_replace
`)).toBe(1);
    expect(await readFile(join(value.directory, "office.md"), "utf8")).toBe("previous release");
    expect((await stat(join(value.directory, "office.md"))).ino).toBe(before.ino);
    expect(await readdir(value.directory)).toEqual(["office.md"]);
    expect(value.run()).toBe(0);
    for (const file of WORKSPACE_GUIDE_FILES) expect(await readFile(join(value.directory, file.name), "utf8")).toBe(file.content);
  });

  it("leaves each guide complete or absent after an interrupted installer and removes its staging next time", async () => {
    const value = await fixture(); await mkdir(value.directory);
    await writeFile(join(value.directory, "browser.md"), "older release");
    // SIGKILL after the first publication, with the second guide fully staged.
    expect(value.run(workspaceGuideInput(), `import os, signal
original_replace = os.replace
published = 0
def interrupted_replace(*args, **kwargs):
    global published
    if published == 1:
        os.kill(os.getpid(), signal.SIGKILL)
    published += 1
    return original_replace(*args, **kwargs)
os.replace = interrupted_replace
`)).toBeNull();
    expect(await readFile(join(value.directory, "office.md"), "utf8")).toBe(WORKSPACE_GUIDE_FILES[0].content);
    expect(await readFile(join(value.directory, "browser.md"), "utf8")).toBe("older release");
    const entries = await readdir(value.directory);
    expect(entries).not.toContain("psd.md");
    expect(entries.filter(name => name.startsWith(".aiqsa-guide-"))).toHaveLength(1);
    expect(value.run()).toBe(0);
    expect((await readdir(value.directory)).sort()).toEqual(WORKSPACE_GUIDE_FILES.map(file => file.name).sort());
    for (const file of WORKSPACE_GUIDE_FILES) expect(await readFile(join(value.directory, file.name), "utf8")).toBe(file.content);
  });

  it("publishes nothing from a truncated request and fails closed on a persistent non-directory guide path", async () => {
    const value = await fixture(); const input = workspaceGuideInput();
    for (const size of [1, Math.floor(input.byteLength / 2), input.byteLength - 1]) {
      expect(value.run(input.subarray(0, size))).toBe(1);
      expect(await readdir(value.workspace)).toEqual([]);
    }
    await writeFile(value.directory, "user bytes");
    for (let attempt = 0; attempt < 2; attempt++) expect(value.run()).toBe(1);
    expect(await readFile(value.directory, "utf8")).toBe("user bytes");
  });

  it("rejects a guides-directory swap during publication without following the replacement symlink", async () => {
    const value = await fixture(); await mkdir(value.directory);
    const elsewhere = join(value.root, "other-files"); await mkdir(elsewhere);
    await writeFile(join(elsewhere, "office.md"), "outside managed guides");
    expect(value.run(workspaceGuideInput(), `import os
original_replace = os.replace
swapped = False
def swapped_replace(*args, **kwargs):
    global swapped
    if not swapped:
        swapped = True
        os.rename(${JSON.stringify(value.directory)}, ${JSON.stringify(join(value.workspace, "old-guides"))})
        os.symlink(${JSON.stringify(elsewhere)}, ${JSON.stringify(value.directory)})
    return original_replace(*args, **kwargs)
os.replace = swapped_replace
`)).toBe(1);
    expect(await readFile(join(elsewhere, "office.md"), "utf8")).toBe("outside managed guides");
    expect(await readdir(elsewhere)).toEqual(["office.md"]);
    expect((await lstat(value.directory)).isSymbolicLink()).toBe(true);
  });

  it("does not authorize guide files as user output capture", () => {
    const producerOperation = { generation: 1, owner: "run:guide-fixture" };
    expect(parseWorkspaceFileSelection({ files: [{ root: "project", relativePath: "result.txt" }], producerOperation }).files)
      .toEqual([{ root: "project", relativePath: "result.txt" }]);
    for (const file of WORKSPACE_GUIDE_FILES) {
      expect(() => parseWorkspaceFileSelection({ files: [{ root: "guides", relativePath: file.name }], producerOperation })).toThrow();
      expect(() => parseWorkspaceFileSelection({ files: [{ root: "project", relativePath: `../guides/${file.name}` }], producerOperation })).toThrow();
    }
  });
});
