import { dirname, join, resolve } from "node:path";

// Keep resolution in Node: bundlers must not rewrite the require used by
// unbundled workers or try to evaluate its runtime working directory.
const runtimeRequire = process.getBuiltinModule("module").createRequire(
  resolve(process.cwd(), "package.json")
);

/** Resolve a package for an unbundled Node worker at runtime. */
export function resolveRuntimeModulePath(specifier: string): string {
  return runtimeRequire.resolve(specifier);
}

/**
 * Root of the shipped source tree and worker dependencies. Next's standalone
 * server changes its working directory to its traced output directory, whose
 * parent is that root; other launches already run from it.
 */
export function applicationRootPath(): string {
  const workingDirectory = process.cwd();
  const { existsSync } = process.getBuiltinModule("fs");
  return existsSync(join(workingDirectory, "server.js")) &&
    existsSync(join(workingDirectory, ".next"))
    ? dirname(workingDirectory)
    : workingDirectory;
}
