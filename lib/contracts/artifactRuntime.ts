export type ArtifactRuntimeError = Readonly<{
  kind: "error" | "unhandledrejection" | "csp";
  message: string;
  line: number;
  column: number;
  directive?: string;
  blocked?: string;
}>;

export const ARTIFACT_VIEW_SANDBOX = "allow-scripts allow-forms allow-pointer-lock allow-downloads";
export const ARTIFACT_VIEW_ALLOW = "fullscreen; clipboard-write";
export const ARTIFACT_STORAGE_PLACEHOLDER = "/*AIQSA_ARTIFACT_STORAGE_STATE*/[]";
export const ARTIFACT_BRIDGE_SCRIPT_OPEN = '<script data-aiqsa-artifact-bridge="3">';
export const ARTIFACT_STORAGE_LIMITS = {
  maxKeys: 64,
  maxKeyCharacters: 128,
  maxValueBytes: 32 * 1024,
  maxMapBytes: 256 * 1024,
  maxOriginBytes: 2 * 1024 * 1024,
  maxRecords: 50
} as const;
export type ArtifactStorageSnapshot = readonly (readonly [string, string])[];
export type ArtifactStorageMessage =
  | Readonly<{ type: "aiqsa_artifact_storage_set"; key: string; value: string }>
  | Readonly<{ type: "aiqsa_artifact_storage_remove"; key: string }>
  | Readonly<{ type: "aiqsa_artifact_storage_clear" }>;

/** Browser storage counts UTF-16 code units, including serialized structure. */
export function artifactStorageBytes(value: string): number { return value.length * 2; }

export function parseArtifactStorageSnapshot(value: unknown): ArtifactStorageSnapshot | null {
  if (!Array.isArray(value) || value.length > ARTIFACT_STORAGE_LIMITS.maxKeys) return null;
  const entries: Array<[string, string]> = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string" ||
      item[0].length > ARTIFACT_STORAGE_LIMITS.maxKeyCharacters || artifactStorageBytes(item[1]) > ARTIFACT_STORAGE_LIMITS.maxValueBytes || keys.has(item[0])) return null;
    keys.add(item[0]); entries.push([item[0], item[1]]);
  }
  return artifactStorageBytes(JSON.stringify(entries)) <= ARTIFACT_STORAGE_LIMITS.maxMapBytes ? entries : null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function parseArtifactStorageMessage(value: unknown): ArtifactStorageMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.type === "aiqsa_artifact_storage_clear" && exactFields(input, ["type"])) return { type: input.type };
  if (typeof input.key !== "string" || input.key.length > ARTIFACT_STORAGE_LIMITS.maxKeyCharacters) return null;
  if (input.type === "aiqsa_artifact_storage_remove" && exactFields(input, ["type", "key"])) return { type: input.type, key: input.key };
  if (input.type === "aiqsa_artifact_storage_set" && exactFields(input, ["type", "key", "value"]) && typeof input.value === "string" &&
    artifactStorageBytes(input.value) <= ARTIFACT_STORAGE_LIMITS.maxValueBytes) return { type: input.type, key: input.key, value: input.value };
  return null;
}

export function parseArtifactLink(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

export function parseArtifactOpenLinkMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return input.type === "aiqsa_artifact_open_link" && exactFields(input, ["type", "href"]) ? parseArtifactLink(input.href) : null;
}

export function artifactLinkCarriesData(href: string): boolean {
  const url = new URL(href);
  return url.search.slice(1).length + url.hash.slice(1).length > 80 || url.pathname.split("/").some(segment => segment.length > 40 && /^[A-Za-z0-9_\-=%+]+$/u.test(segment));
}

const clean = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value);

export function parseArtifactRuntimeError(value: unknown): ArtifactRuntimeError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.type !== "aiqsa_artifact_runtime_error" || (typeof input.kind !== "string" || !["error", "unhandledrejection", "csp"].includes(input.kind)) ||
    !clean(input.message, 300) || !Number.isSafeInteger(input.line) || Number(input.line) < 0 ||
    !Number.isSafeInteger(input.column) || Number(input.column) < 0) return null;
  const result = { kind: input.kind as ArtifactRuntimeError["kind"], message: input.message,
    line: Number(input.line), column: Number(input.column) };
  if (input.kind !== "csp") return result;
  if (!clean(input.directive, 64) || !clean(input.blocked, 128)) return null;
  if (!["inline", "eval", "data", "blob", "unknown"].includes(input.blocked)) {
    try { const url = new URL(input.blocked); if (!/^https?:$/u.test(url.protocol) || url.origin !== input.blocked) return null; }
    catch { return null; }
  }
  return { ...result, directive: input.directive, blocked: input.blocked };
}
