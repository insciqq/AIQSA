import type { ThreadGeneratedFile } from "@/lib/contracts/workspace";
import { WORKSPACE_OUTPUT_DIRECTORY, isSafeWorkspaceRelativePath } from "./workspace";

/**
 * Resolution of a model-written `sandbox:` link against the generated files
 * of the same run. Only the exact run output directory of the message's own
 * run and an exact relative path match may become a real download; anything
 * else is rendered as inert text so the reader never gets a dead link.
 */
export type WorkspaceOutputLinkResolution =
  | Readonly<{ file: ThreadGeneratedFile; kind: "download" }>
  | Readonly<{ kind: "unresolved" }>;

const SANDBOX_SCHEME = /^sandbox:\/{0,3}/iu;
const OUTPUT_PREFIX = `${WORKSPACE_OUTPUT_DIRECTORY}/`;

export function isWorkspaceSandboxHref(href: unknown): href is string {
  return typeof href === "string" && /^sandbox:/iu.test(href.trim());
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function resolveWorkspaceOutputLink(input: Readonly<{
  generatedFiles: readonly ThreadGeneratedFile[];
  href: unknown;
  runId: string | null | undefined;
}>): WorkspaceOutputLinkResolution | null {
  if (!isWorkspaceSandboxHref(input.href)) return null;
  const raw = input.href.trim().replace(SANDBOX_SCHEME, "/").replace(/^\/{2,}/u, "/");
  const withoutQuery = raw.split(/[?#]/u, 1)[0] ?? "";
  const decoded = decodeSegment(withoutQuery);
  if (
    !decoded ||
    !input.runId ||
    /[\u0000-\u001f\u007f\\]/u.test(decoded) ||
    !decoded.startsWith(OUTPUT_PREFIX)
  ) {
    return { kind: "unresolved" };
  }
  const remainder = decoded.slice(OUTPUT_PREFIX.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0) return { kind: "unresolved" };
  const runId = remainder.slice(0, slash);
  const relativePath = remainder.slice(slash + 1);
  if (runId !== input.runId || !isSafeWorkspaceRelativePath(relativePath)) {
    return { kind: "unresolved" };
  }
  const file = input.generatedFiles.find((candidate) => candidate.relativePath === relativePath);
  return file ? { file, kind: "download" } : { kind: "unresolved" };
}
