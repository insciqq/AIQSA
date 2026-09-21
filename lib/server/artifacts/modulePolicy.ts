import { parse } from "acorn";
import { ArtifactToolError } from "./errors";

/** Parse module syntax, including nested template expressions, without executing
 * code. Only a single module is shipped: every import/re-export is rejected. */
export function assertArtifactSingleModule(source: string, path: string): void {
  const invalid = (): never => { throw new ArtifactToolError("artifact_module_graph_unsupported", { path,
    hint: "Use valid self-contained JavaScript or a UMD/IIFE build. External, relative and dynamic module imports are unsupported." }); };
  let program: unknown;
  try { program = parse(source, { ecmaVersion: "latest", sourceType: "module" }); }
  catch { return invalid(); }
  const pending: unknown[] = [program];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue; }
    const node = value as Record<string, unknown>;
    if (["ImportDeclaration", "ImportExpression", "ExportAllDeclaration"].includes(String(node.type)) ||
      node.type === "ExportNamedDeclaration" && node.source) invalid();
    for (const child of Object.values(node)) if (child && typeof child === "object") pending.push(child);
  }
}
