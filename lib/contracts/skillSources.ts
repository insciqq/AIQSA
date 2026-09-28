import type { SkillValidationError } from "./skills";

export const SKILL_SOURCE_URL_MAX_LENGTH = 2_048;
export const SKILL_SOURCE_MAX_SELECTIONS = 200;

export type SkillRemoteSource = {
  kind: "github" | "gitlab" | "zip" | "markdown";
  url: string;
  revision: string;
};
export type SkillImportSource = SkillRemoteSource & { path: string; bundleDigest: string };
export type SkillSourceTarget = { id: string; name: string; version: number };
export type SkillSourcePreviewRequest = { url: string; targetSkillId?: string };
export type SkillSourceCandidate = {
  path: string;
  name: string;
  matches: SkillSourceTarget[];
} & (
  | { bundleDigest: string; description: string; fileCount: number; totalBytes: number; hasExecutables: boolean; error?: never }
  | { error: SkillValidationError; bundleDigest?: never; description?: never; fileCount?: never; totalBytes?: never; hasExecutables?: never }
);
export type SkillSourcePreview = {
  source: SkillRemoteSource;
  fingerprint: string;
  candidates: SkillSourceCandidate[];
  ignoredFiles: number;
  target?: SkillSourceTarget & { path: string; locallyModified: boolean };
};
export type SkillSourceImportAction = { kind: "create" } | { kind: "update"; skillId: string; version: number };
export type SkillSourceImportRequest = {
  url: string;
  fingerprint: string;
  selections: Array<{ path: string; bundleDigest: string; action: SkillSourceImportAction }>;
};

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const path = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
  (value === "." || (!/[\\\u0000-\u001f\u007f]/u.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")));

/** The server additionally validates DNS, redirects and supported source routes. */
export function isSkillSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > SKILL_SOURCE_URL_MAX_LENGTH || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    const viewQuery = url.hostname === "gitlab.com" && url.pathname.includes("/-/") &&
      ["?ref_type=heads", "?ref_type=tags"].includes(url.search);
    return url.protocol === "https:" && !url.username && !url.password && (!url.search || viewQuery) && !url.hash && (!url.port || url.port === "443");
  } catch { return false; }
}

export function decodeSkillSourcePreviewRequest(value: unknown): SkillSourcePreviewRequest | null {
  if (!record(value) || !only(value, ["url", "targetSkillId"]) || !isSkillSourceUrl(value.url) ||
    (value.targetSkillId !== undefined && !id(value.targetSkillId))) return null;
  return { url: value.url, ...(value.targetSkillId === undefined ? {} : { targetSkillId: value.targetSkillId }) };
}

export function decodeSkillSourceImportRequest(value: unknown): SkillSourceImportRequest | null {
  if (!record(value) || !only(value, ["url", "fingerprint", "selections"]) || !isSkillSourceUrl(value.url) || !digest(value.fingerprint) ||
    !Array.isArray(value.selections) || !value.selections.length || value.selections.length > SKILL_SOURCE_MAX_SELECTIONS) return null;
  const selections: SkillSourceImportRequest["selections"] = [];
  const paths = new Set<string>(), targets = new Set<string>();
  for (const selection of value.selections) {
    if (!record(selection) || !only(selection, ["path", "bundleDigest", "action"]) || !path(selection.path) ||
      !digest(selection.bundleDigest) || paths.has(selection.path) || !record(selection.action)) return null;
    const action = selection.action;
    if (action.kind === "create" && only(action, ["kind"])) {
      selections.push({ path: selection.path, bundleDigest: selection.bundleDigest, action: { kind: "create" } });
    } else if (action.kind === "update" && only(action, ["kind", "skillId", "version"]) && id(action.skillId) &&
      typeof action.version === "number" && Number.isSafeInteger(action.version) && action.version > 0 && !targets.has(action.skillId)) {
      targets.add(action.skillId);
      selections.push({ path: selection.path, bundleDigest: selection.bundleDigest, action: { kind: "update", skillId: action.skillId, version: action.version } });
    } else return null;
    paths.add(selection.path);
  }
  return { url: value.url, fingerprint: value.fingerprint, selections };
}

/** Positive projection of private persisted provenance; old/invalid data is not a source authority. */
export function decodeSkillImportSource(value: unknown): SkillImportSource | null {
  if (!record(value) || !["github", "gitlab", "zip", "markdown"].includes(String(value.kind)) || !isSkillSourceUrl(value.url) || new URL(value.url).search ||
    typeof value.revision !== "string" || !/^[a-f0-9]{40,64}$/u.test(value.revision) || !path(value.path) || !digest(value.bundleDigest)) return null;
  return { kind: value.kind as SkillRemoteSource["kind"], url: value.url, revision: value.revision, path: value.path, bundleDigest: value.bundleDigest };
}
