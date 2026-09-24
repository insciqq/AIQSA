// @vitest-environment node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink, link, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SELECTED_FILE_CAPTURE_GUEST } from "./selectedFileGuest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiqsa-selected-guest-")); roots.push(root);
  await mkdir(join(root, "project"));
  const path = join(root, "project/绘图 🧪.bin");
  await writeFile(path, Buffer.from([0, 1, 2, 127, 128, 255]));
  const script = SELECTED_FILE_CAPTURE_GUEST.replaceAll("/workspace", root);
  const run = (paths = [path], fileMaxBytes = 1024, totalMaxBytes = 2048) => {
    const result = spawnSync("python3", ["-I", "-c", script], { timeout: 2_000, maxBuffer: 64 * 1024,
      input: JSON.stringify({ paths, fileMaxBytes, totalMaxBytes }) + "\nfinish\n", encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    return { status: result.status, replies: result.stdout.trim().split("\n").map(line => JSON.parse(line)) };
  };
  return { root, path, run, script };
}

describe("selected-file guest validation (local filesystem; real KVM qualification remains separate)", () => {
  it("hashes bounded binary/empty files under leases without placing payload bytes on stdout", async () => {
    const { root, path, run } = await fixture();
    const empty = join(root, "project/empty.txt"); await writeFile(empty, "");
    const result = run([path, empty]);
    expect(result.status).toBe(0);
    expect(result.replies).toHaveLength(2);
    expect(result.replies[0].files).toMatchObject([
      { byteSize: 6, checksum: createHash("sha256").update(Buffer.from([0, 1, 2, 127, 128, 255])).digest("hex") },
      { byteSize: 0, checksum: createHash("sha256").digest("hex") }
    ]);
    expect(result.replies[1]).toEqual({ complete: true });
    expect(JSON.stringify(result.replies)).not.toContain(path);
  });

  it("refuses an already-open writer instead of claiming an atomic snapshot", async () => {
    const { path, run } = await fixture();
    const writer = await open(path, "r+");
    try { expect(run()).toEqual({ status: 65, replies: [{ error: "source_busy" }] }); }
    finally { await writer.close(); }
  });

  it("refuses a writable mmap even after the writer closes its original FD", async () => {
    const { path, run } = await fixture();
    const writer = spawn("python3", ["-I", "-u", "-c", String.raw`
import os,sys,mmap
fd=os.open(sys.argv[1],os.O_RDWR)
mapped=mmap.mmap(fd,0,access=mmap.ACCESS_WRITE)
os.close(fd)
print('ready',flush=True)
sys.stdin.readline()
mapped.close()
`, path]);
    const done = once(writer, "exit");
    try {
      await once(writer.stdout, "data");
      expect(run()).toEqual({ status: 65, replies: [{ error: "source_busy" }] });
    } finally { writer.stdin.end("finish\n"); await done; }
  });

  it("keeps its opened inode across rename and refuses to certify a subsequently substituted path", async () => {
    const { root, path, script } = await fixture();
    const helper = spawn("python3", ["-I", "-u", "-c", script]);
    const done = once(helper, "exit");
    const lines = createInterface({ input: helper.stdout });
    const replies = lines[Symbol.asyncIterator]();
    try {
      helper.stdin.write(JSON.stringify({ paths: [path], fileMaxBytes: 1024, totalMaxBytes: 2048 }) + "\n");
      const metadata = JSON.parse((await replies.next()).value!);
      expect(metadata.files).toHaveLength(1);
      await rename(path, join(root, "project/old.bin"));
      await symlink(join(root, "project/old.bin"), path);
      const pinned = await readFile(`/proc/${metadata.pid}/fd/${metadata.files[0].fd}`);
      expect(createHash("sha256").update(pinned).digest("hex")).toBe(metadata.files[0].checksum);
      helper.stdin.end("finish\n");
      expect(JSON.parse((await replies.next()).value!)).toEqual({ error: "source_invalid" });
      expect((await done)[0]).toBe(65);
    } finally { lines.close(); helper.kill(); }
  });

  it.each(["symlink", "parent_symlink", "hardlink", "fifo", "traversal", "managed"])("rejects %s before output metadata", async kind => {
    const { root, path, run } = await fixture();
    let source = join(root, "project/hostile");
    if (kind === "symlink") await symlink(path, source);
    if (kind === "parent_symlink") { await symlink(join(root, "project"), source); source += "/绘图 🧪.bin"; }
    if (kind === "hardlink") await link(path, source);
    if (kind === "fifo") {
      const made = spawnSync("python3", ["-I", "-c", "import os,sys;os.mkfifo(sys.argv[1])", source]);
      expect(made.status).toBe(0);
    }
    if (kind === "traversal") source = join(root, "project") + "/../project/绘图 🧪.bin";
    if (kind === "managed") { source = join(root, "secret.txt"); await writeFile(source, "synthetic secret"); }
    expect(run([source])).toEqual({ status: 65, replies: [{ error: "source_invalid" }] });
  });

  it("applies file and aggregate bounds before hashing", async () => {
    const { root, path, run } = await fixture();
    const second = join(root, "project/second.bin"); await writeFile(second, "123456");
    expect(run([path], 5)).toEqual({ status: 65, replies: [{ error: "limit" }] });
    expect(run([path, second], 6, 10)).toEqual({ status: 65, replies: [{ error: "limit" }] });
  });
});
