import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOUND_WORKSPACE_UV_CACHE,
  parseWorkspaceUvCacheBoundOutcome,
  WORKSPACE_UV_CACHE_DIRECTORY,
  WORKSPACE_UV_CACHE_PRUNE_THRESHOLD_BYTES,
  WORKSPACE_UV_CACHE_PRUNE_TIMEOUT_SECONDS
} from "./guestCache";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/**
 * Runs the real helper on the host with only its fixed paths and threshold
 * rewritten: the cache directory into a temporary tree, the threshold to a few
 * bytes, and the guest venv to a stub `uv` that records its arguments.
 */
function run(options: Readonly<{ cacheBytes?: number; uvExit?: number; symlink?: boolean }>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aiqsa-uv-cache-")));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const record = join(root, "uv-args");
  writeFileSync(join(bin, "uv"), `#!/bin/sh\necho "$@" > '${record}'\nexit ${options.uvExit ?? 0}\n`);
  chmodSync(join(bin, "uv"), 0o755);
  const cache = join(root, "workspace", ".cache", "uv");
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), Buffer.alloc(64));
  if (options.symlink) {
    mkdirSync(join(root, "workspace", ".cache"), { recursive: true });
    symlinkSync(outside, cache);
  } else if (options.cacheBytes !== undefined) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "entry"), Buffer.alloc(options.cacheBytes));
  }
  const script = BOUND_WORKSPACE_UV_CACHE
    .replaceAll(WORKSPACE_UV_CACHE_DIRECTORY, cache)
    .replaceAll(String(WORKSPACE_UV_CACHE_PRUNE_THRESHOLD_BYTES), "4096")
    .replace("/opt/aiqsa-python/bin", bin);
  const stdout = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: {} });
  return { cache, outside, stdout, uvArgs: existsSync(record) ? readFileSync(record, "utf8").trim() : null };
}

describe("uv cache bound helper", () => {
  it("is fixed: the 1 GiB threshold, the guest timeout and only the cache directory, never a removal of its own", () => {
    expect(WORKSPACE_UV_CACHE_PRUNE_THRESHOLD_BYTES).toBe(1024 ** 3);
    expect(BOUND_WORKSPACE_UV_CACHE).toContain(`dir='${WORKSPACE_UV_CACHE_DIRECTORY}'`);
    expect(BOUND_WORKSPACE_UV_CACHE).toContain(`-le ${WORKSPACE_UV_CACHE_PRUNE_THRESHOLD_BYTES}`);
    expect(BOUND_WORKSPACE_UV_CACHE).toContain(`timeout -k 5 ${WORKSPACE_UV_CACHE_PRUNE_TIMEOUT_SECONDS} uv cache prune --cache-dir "$dir"`);
    expect(BOUND_WORKSPACE_UV_CACHE).not.toMatch(/\brm\b|\bfind\b/u);
    expect(BOUND_WORKSPACE_UV_CACHE.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("prunes only above the threshold and reports one word", () => {
    const over = run({ cacheBytes: 64 * 1024 });
    expect(over.stdout.trim()).toBe("pruned");
    expect(over.uvArgs).toBe(`cache prune --cache-dir ${over.cache}`);
    const within = run({ cacheBytes: 16 });
    expect(within.stdout.trim()).toBe("within");
    expect(within.uvArgs).toBeNull();
    expect(run({}).stdout.trim()).toBe("absent");
  });

  it("reports a failed prune and still exits 0", () => {
    const failed = run({ cacheBytes: 64 * 1024, uvExit: 2 });
    expect(failed.stdout.trim()).toBe("failed");
  });

  it("never follows a cache path that resolves elsewhere", () => {
    const linked = run({ symlink: true });
    expect(linked.stdout.trim()).toBe("absent");
    expect(linked.uvArgs).toBeNull();
    expect(existsSync(join(linked.outside, "keep"))).toBe(true);
  });

  it("treats anything but a known outcome word as failed", () => {
    expect(parseWorkspaceUvCacheBoundOutcome("pruned\n")).toBe("pruned");
    expect(parseWorkspaceUvCacheBoundOutcome("")).toBe("failed");
    expect(parseWorkspaceUvCacheBoundOutcome("pruned extra")).toBe("failed");
  });
});
