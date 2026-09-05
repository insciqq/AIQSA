import { resolve } from "node:path";

// Keep resolution in Node: bundlers must not rewrite the require used by
// unbundled workers or try to evaluate its runtime working directory.
const runtimeRequire = process.getBuiltinModule("module").createRequire(
  resolve(process.cwd(), "package.json")
);

/** Resolve a package for an unbundled Node worker at runtime. */
export function resolveRuntimeModulePath(specifier: string): string {
  return runtimeRequire.resolve(specifier);
}
