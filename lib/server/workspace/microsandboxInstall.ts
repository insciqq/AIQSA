import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

const PLATFORM_PACKAGES = Object.freeze({
  arm64: "@superradcompany/microsandbox-linux-arm64-gnu",
  x64: "@superradcompany/microsandbox-linux-x64-gnu"
} as const);

async function copyIfChanged(source: string, target: string, mode: number): Promise<void> {
  const [sourceStat, targetStat] = await Promise.all([
    stat(source),
    stat(target).catch(() => null)
  ]);
  if (targetStat?.isFile() && targetStat.size === sourceStat.size) {
    await chmod(target, mode);
    return;
  }
  const staged = `${target}.stage-${process.pid}`;
  await rm(staged, { force: true });
  await copyFile(source, staged);
  await chmod(staged, mode);
  await rename(staged, target);
}

async function replaceSymlink(target: string, linkPath: string): Promise<void> {
  const current = await lstat(linkPath).catch(() => null);
  if (current?.isSymbolicLink() && await readlink(linkPath) === target) return;
  if (current) await unlink(linkPath);
  await symlink(target, linkPath);
}

/**
 * The pinned npm platform package carries both runtime artifacts, while the
 * native SDK intentionally recognizes only the canonical MSB_HOME layout.
 * Materialize that layout into the runner's writable volume without a setup
 * download so startup remains pinned and works after an existing volume is
 * attached to a newer runner image.
 */
export async function ensureBundledMicrosandboxRuntime(): Promise<void> {
  if (process.platform !== "linux" || !(process.arch in PLATFORM_PACKAGES)) {
    throw new Error("workspace_runtime_platform_unsupported");
  }
  const home = process.env.MSB_HOME?.trim();
  if (!home || !isAbsolute(home)) throw new Error("workspace_runtime_home_invalid");

  const packageName = PLATFORM_PACKAGES[process.arch as keyof typeof PLATFORM_PACKAGES];
  const packageRoot = join(process.cwd(), "node_modules", ...packageName.split("/"));
  const sourceBinary = join(packageRoot, "bin", "msb");
  const sourceLibraryDirectory = join(packageRoot, "lib");
  const firmwareFiles = (await readdir(sourceLibraryDirectory)).filter((name) =>
    /^libkrunfw\.so\.\d+(?:\.\d+)*$/u.test(name)
  );
  if (firmwareFiles.length !== 1) throw new Error("workspace_runtime_bundle_invalid");

  const binaryDirectory = join(home, "bin");
  const libraryDirectory = join(home, "lib");
  await Promise.all([
    mkdir(binaryDirectory, { recursive: true }),
    mkdir(libraryDirectory, { recursive: true })
  ]);
  const firmwareName = firmwareFiles[0]!;
  await Promise.all([
    copyIfChanged(sourceBinary, join(binaryDirectory, "msb"), 0o755),
    copyIfChanged(
      join(sourceLibraryDirectory, firmwareName),
      join(libraryDirectory, firmwareName),
      0o644
    )
  ]);
  const majorName = firmwareName.replace(/^(libkrunfw\.so\.\d+).*$/u, "$1");
  await replaceSymlink("msb", join(binaryDirectory, "microsandbox"));
  await replaceSymlink(firmwareName, join(libraryDirectory, majorName));
  await replaceSymlink(basename(majorName), join(libraryDirectory, "libkrunfw.so"));
}
