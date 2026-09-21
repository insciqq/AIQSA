import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  decodeSkillDraft, SKILL_ARCHIVE_MAX_BYTES, SKILL_ARCHIVE_MAX_ENTRIES,
  SKILL_BUNDLE_MAX_BYTES, SKILL_COMPATIBILITY_MAX_LENGTH, SKILL_FILE_MAX_BYTES,
  SKILL_FRONTMATTER_MAX_BYTES, SKILL_MAX_FILES, SKILL_TEXT_FILE_MAX_BYTES,
  type SkillDraft, type SkillValidationError
} from "../../contracts/skills";
import { skillAlias, skillTarPath } from "../../domain/skillBundlePaths";
import { isSafeWorkspaceRelativePath } from "../../domain/workspace";
import { SkillBundleError, skillLimit } from "./bundleErrors";
import type { SkillImportFile } from "./zipReader";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SkillFrontmatter = { [key: string]: Json };
export type SkillBundleFile = {
  path: string; byteSize: number; checksum: string; executable: boolean;
  kind: "text" | "binary"; textContent: string | null; bytes: Buffer;
};
export type SkillBundle = SkillDraft & {
  frontmatterJson: SkillFrontmatter | null;
  bundleDigest: string; bundleByteSize: number; fileCount: number;
  hasExecutables: boolean; files: SkillBundleFile[];
};
export type SkillImportCandidate = { name: string } & (
  | { bundle: SkillBundle; error?: never }
  | { error: SkillValidationError; bundle?: never }
);

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function canonical(value: unknown, depth = 0): Json {
  if (depth > 32) throw new SkillBundleError({ code: "skill_frontmatter_invalid" });
  if (typeof value === "string") {
    if (/[\u0000\uD800-\uDFFF]/u.test(value)) throw new SkillBundleError({ code: "skill_frontmatter_invalid" });
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [canonical(key, depth + 1) as string, canonical(value[key], depth + 1)]));
  throw new SkillBundleError({ code: "skill_frontmatter_invalid" });
}

export function normalizeSkillFrontmatter(value: unknown): SkillFrontmatter | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new SkillBundleError({ code: "skill_frontmatter_invalid" });
  const { name: _name, description: _description, ...extra } = value;
  if (extra.metadata !== undefined) {
    if (!isObject(extra.metadata) || Object.values(extra.metadata).some((entry) => typeof entry !== "string")) {
      throw new SkillBundleError({ code: "skill_frontmatter_invalid", field: "metadata" });
    }
    const metadata = { ...extra.metadata };
    delete metadata["aiqsa-title"];
    if (Object.keys(metadata).length) extra.metadata = metadata;
    else delete extra.metadata;
  }
  if (extra.compatibility !== undefined) {
    if (typeof extra.compatibility !== "string") throw new SkillBundleError({ code: "skill_frontmatter_invalid", field: "compatibility" });
    skillLimit("compatibility", [...extra.compatibility].length, SKILL_COMPATIBILITY_MAX_LENGTH);
  }
  const normalized = canonical(extra) as SkillFrontmatter;
  skillLimit("frontmatter", Buffer.byteLength(JSON.stringify(normalized)), SKILL_FRONTMATTER_MAX_BYTES);
  return Object.keys(normalized).length ? normalized : null;
}

function yamlObject(source: string): Record<string, unknown> {
  const parse = (text: string) => {
    const doc = parseDocument(text, { uniqueKeys: true, strict: true, customTags: [] });
    if (doc.errors.length || doc.warnings.length) throw new Error("invalid_yaml");
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!isObject(value)) throw new Error("invalid_yaml");
    return value;
  };
  try { return parse(source); } catch {
    // Repair only common unquoted top-level name/description scalars, preserving every other field.
    const repaired = source.replace(/^(name|description):[ \t]+([^\r\n]+)$/gmu, (line, key: string, raw: string) => {
      const value = raw.trim();
      return value.includes(": ") && !/^["'|>\[{&*!]/u.test(value) ? `${key}: ${JSON.stringify(value)}` : line;
    });
    if (repaired !== source) {
      try { return parse(repaired); } catch { /* fall through to content-free error */ }
    }
    throw new SkillBundleError({ code: "skill_frontmatter_invalid" });
  }
}

export function parseSkillMarkdown(bytes: Buffer, fallbackName: string): SkillDraft & { frontmatterJson: SkillFrontmatter | null } {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new SkillBundleError({ code: "skill_markdown_invalid" });
  }
  if (text.includes("\0")) throw new SkillBundleError({ code: "skill_markdown_invalid" });
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (!match) throw new SkillBundleError({ code: "skill_frontmatter_required" });
  skillLimit("frontmatter", Buffer.byteLength(match[1]!), SKILL_FRONTMATTER_MAX_BYTES * 4);
  const values = yamlObject(match[1]!);
  const title = isObject(values.metadata) && typeof values.metadata["aiqsa-title"] === "string"
    ? values.metadata["aiqsa-title"] : undefined;
  const result = decodeSkillDraft({
    name: title ?? values.name ?? fallbackName,
    description: values.description,
    instructions: match[2]!
  });
  if (!result.ok) {
    const { ok: _ok, ...issue } = result;
    // Omitted required metadata is a missing field, rather than an invalid supplied type.
    if (values.description === undefined) throw new SkillBundleError({ code: "skill_field_required", field: "description" });
    throw new SkillBundleError(issue);
  }
  return { ...result.draft, frontmatterJson: normalizeSkillFrontmatter(values) };
}

export function skillBundleDigest(input: SkillDraft & {
  frontmatterJson?: unknown;
  files: readonly Pick<SkillBundleFile, "path" | "checksum" | "byteSize" | "executable">[];
}): string {
  return sha256(JSON.stringify(canonical({
    name: input.name, description: input.description, instructions: input.instructions,
    frontmatter: normalizeSkillFrontmatter(input.frontmatterJson),
    files: [...input.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map((file) => [file.path, file.checksum, file.byteSize, file.executable])
  })));
}

export function renderSkillMarkdown(input: SkillDraft & { frontmatterJson?: unknown }, alias?: string): string {
  const extras = normalizeSkillFrontmatter(input.frontmatterJson) ?? {};
  const safeName = alias ?? input.name;
  const metadata = isObject(extras.metadata) ? extras.metadata : {};
  if (alias && alias !== input.name) extras.metadata = { ...metadata, "aiqsa-title": input.name } as SkillFrontmatter;
  const fields = { name: safeName, description: input.description || input.name, ...extras };
  // JSON values are valid YAML flow values; quoting prevents instruction text from becoming structure.
  return `---\n${Object.entries(fields).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join("\n")}\n---\n${input.instructions}\n`;
}

export function createSkillBundle(input: SkillDraft & { frontmatterJson?: unknown }, imports: readonly SkillImportFile[] = []): SkillBundle {
  const frontmatterJson = normalizeSkillFrontmatter(input.frontmatterJson);
  skillLimit("files", imports.length, SKILL_MAX_FILES);
  const paths = new Set(["skill.md"]);
  const files = imports.map((file): SkillBundleFile => {
    if (!skillTarPath(file.path)) throw new SkillBundleError({ code: "skill_path_invalid" });
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new SkillBundleError({ code: "skill_path_duplicate" });
    paths.add(key);
    skillLimit("fileBytes", file.bytes.length, SKILL_FILE_MAX_BYTES);
    let textContent: string | null = null;
    if (file.bytes.length <= SKILL_TEXT_FILE_MAX_BYTES && !file.bytes.includes(0)) {
      try { textContent = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); } catch { /* binary */ }
    }
    return {
      path: file.path, bytes: file.bytes, byteSize: file.bytes.length, checksum: sha256(file.bytes),
      executable: file.executable ?? (file.bytes[0] === 35 && file.bytes[1] === 33),
      kind: textContent === null ? "binary" : "text", textContent
    };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (paths.has(segments.slice(0, index).join("/"))) throw new SkillBundleError({ code: "skill_path_duplicate" });
    }
  }
  const normalized = { name: input.name, description: input.description, instructions: input.instructions, frontmatterJson };
  const bundleByteSize = Buffer.byteLength(renderSkillMarkdown(normalized)) + files.reduce((sum, file) => sum + file.byteSize, 0);
  skillLimit("bundleBytes", bundleByteSize, SKILL_BUNDLE_MAX_BYTES);
  return {
    ...normalized, files, fileCount: files.length, bundleByteSize,
    hasExecutables: files.some((file) => file.executable),
    bundleDigest: skillBundleDigest({ ...normalized, files })
  };
}

export function parseSkillImport(files: readonly SkillImportFile[]): { candidates: SkillImportCandidate[]; ignoredFiles: number } {
  skillLimit("archiveEntries", files.length, SKILL_ARCHIVE_MAX_ENTRIES);
  let totalBytes = 0;
  const paths = new Set<string>();
  const duplicatePaths = new Set<string>();
  for (const file of files) {
    if (!isSafeWorkspaceRelativePath(file.path) || /^[a-z]:/iu.test(file.path)) throw new SkillBundleError({ code: "skill_path_invalid" });
    const pathKey = file.path.toLowerCase();
    if (paths.has(pathKey)) duplicatePaths.add(pathKey);
    paths.add(pathKey);
    skillLimit("fileBytes", file.bytes.length, SKILL_FILE_MAX_BYTES);
    totalBytes += file.bytes.length;
    skillLimit("archiveBytes", totalBytes, SKILL_ARCHIVE_MAX_BYTES);
  }
  const rootPaths = [...new Set(files.filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
    .map((file) => file.path.slice(0, -"SKILL.md".length)))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const roots: string[] = [];
  for (const root of rootPaths) if (!roots.some((parent) => root.startsWith(parent))) roots.push(root);
  if (!roots.length) throw new SkillBundleError({ code: "skill_markdown_required" });
  const candidates = roots.map((root): SkillImportCandidate => {
    const name = root.split("/").filter(Boolean).at(-1) ?? "skill";
    let parsedName = name;
    try {
      const members = files.filter((file) => file.path.startsWith(root));
      if (members.some((file) => duplicatePaths.has(file.path.toLowerCase()))) throw new SkillBundleError({ code: "skill_path_duplicate" });
      const markdown = members.filter((file) => file.path === `${root}SKILL.md`);
      if (markdown.length !== 1) throw new SkillBundleError({ code: "skill_path_duplicate" });
      const parsed = parseSkillMarkdown(markdown[0]!.bytes, name);
      parsedName = parsed.name;
      const bundle = createSkillBundle(parsed, members.filter((file) => file !== markdown[0])
        .map((file) => ({ ...file, path: file.path.slice(root.length) })));
      return { name: parsed.name, bundle };
    } catch (error) {
      if (!(error instanceof SkillBundleError)) throw error;
      return { name: parsedName, error: error.issue };
    }
  });
  return { candidates, ignoredFiles: files.filter((file) => !roots.some((root) => file.path.startsWith(root))).length };
}

export function skillExportEntries(bundles: readonly SkillBundle[]): SkillImportFile[] {
  const used = new Set<string>();
  let count = 0;
  let byteSize = 0;
  const entries: SkillImportFile[] = [];
  for (const bundle of bundles) {
    const alias = skillAlias(bundle.name, used);
    const markdown = Buffer.from(renderSkillMarkdown(bundle, alias));
    count += 1 + bundle.fileCount;
    byteSize += markdown.length + bundle.files.reduce((sum, file) => sum + file.byteSize, 0);
    skillLimit("archiveEntries", count, SKILL_ARCHIVE_MAX_ENTRIES);
    skillLimit("archiveBytes", byteSize, SKILL_ARCHIVE_MAX_BYTES);
    entries.push({ path: `${alias}/SKILL.md`, bytes: markdown, executable: false });
    entries.push(...bundle.files.map((file) => ({ path: `${alias}/${file.path}`, bytes: file.bytes, executable: file.executable })));
  }
  return entries;
}
