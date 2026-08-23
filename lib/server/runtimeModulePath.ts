import { createRequire } from "node:module";
import { resolve } from "node:path";

const runtimeRequire = createRequire(resolve(process.cwd(), "package.json"));

/** Resolve a package for an unbundled Node worker at runtime. */
export function resolveRuntimeModulePath(specifier: string): string {
  return runtimeRequire.resolve(specifier);
}
