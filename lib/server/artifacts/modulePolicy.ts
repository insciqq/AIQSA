import { Buffer } from "node:buffer";
import { parse } from "acorn";
import { ArtifactToolError } from "./errors";
import { ARTIFACT_RESOURCE_LIMITS } from "./resourcePolicy";

/**
 * Bytes of one module script parsed for its imports, as for a downloaded script. An AST costs
 * about 120 bytes a node: at this bound the densest code measured takes 0.8 s and 400 MB, the
 * 2.9 MB echarts ESM build 0.25 s and 110 MB. Classic scripts are never parsed.
 */
export const ARTIFACT_MODULE_MAX_BYTES = ARTIFACT_RESOURCE_LIMITS.scriptBytes;

/** Parse module syntax, including nested template expressions, without executing
 * code. Only a single module is shipped: every import/re-export is rejected.
 * A module larger than `ARTIFACT_MODULE_MAX_BYTES` is refused before parsing. */
export function isArtifactSingleModule(source: string, path: string): boolean {
  if (Buffer.byteLength(source) > ARTIFACT_MODULE_MAX_BYTES) throw new ArtifactToolError("artifact_module_too_large", { path,
    hint: `A module script (type="module") may be at most ${ARTIFACT_MODULE_MAX_BYTES / 1024 / 1024} MiB, since it is parsed to check that it imports nothing. ` +
      "Build it as a classic script in the Workspace (esbuild main.js --bundle --outfile=app.js, with this module or its source as main.js; the default format needs no type=\"module\") " +
      "and reference app.js with a plain <script src>; classic scripts may be as large as any file. Without the Workspace, tell the user." });
  let program: unknown;
  try { program = parse(source, { ecmaVersion: "latest", sourceType: "module" }); }
  catch { return false; }
  const pending: unknown[] = [program];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue; }
    const node = value as Record<string, unknown>;
    if (["ImportDeclaration", "ImportExpression", "ExportAllDeclaration"].includes(String(node.type)) ||
      node.type === "ExportNamedDeclaration" && node.source) return false;
    for (const child of Object.values(node)) if (child && typeof child === "object") pending.push(child);
  }
  return true;
}

/** `valid` passes an earlier `isArtifactSingleModule` answer for the same source. */
export function assertArtifactSingleModule(source: string, path: string, valid = isArtifactSingleModule(source, path)): void {
  if (!valid) throw new ArtifactToolError("artifact_module_graph_unsupported", { path,
    hint: "Use valid self-contained JavaScript or a UMD/IIFE build. External, relative and dynamic module imports are unsupported. " +
      "Bundle a site of several modules into one file with esbuild in the Workspace (esbuild main.js --bundle --outfile=app.js), then reference app.js instead of the modules; without the Workspace, tell the user." });
}
