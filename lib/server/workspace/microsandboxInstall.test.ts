// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ensureBundledMicrosandboxRuntime } from "./microsandboxInstall";

it.skipIf(process.platform !== "linux")("keeps native temporary files on the private runtime volume across startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiqsa-runtime-install-"));
  const runtimeHome = join(root, "runtime");
  const packageRoot = join(root, "node_modules", "@superradcompany", `microsandbox-linux-${process.arch}-gnu`);
  vi.stubEnv("MSB_HOME", runtimeHome);
  vi.stubEnv("TMPDIR", tmpdir());
  vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "lib"), { recursive: true });
    await writeFile(join(packageRoot, "bin", "msb"), "synthetic runtime");
    await writeFile(join(packageRoot, "lib", "libkrunfw.so.5"), "synthetic firmware");
    await ensureBundledMicrosandboxRuntime();
    const nativeTemporary = await mkdtemp(join(tmpdir(), "trampoline-"));
    expect(nativeTemporary.startsWith(`${runtimeHome}/tmp/`)).toBe(true);
    await ensureBundledMicrosandboxRuntime();
    expect(tmpdir()).toBe(join(runtimeHome, "tmp"));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  }
});
