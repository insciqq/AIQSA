import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createSkillBundle, parseSkillMarkdown, type SkillBundle } from "./bundle";
import type { SkillRevisionContent } from "./revisionWriteCore";

/**
 * Skills the release ships to every user of an installation (operator request
 * 2026-11-06). The list is explicit: `skills/` also holds Skills for coding
 * agents, such as `skills/aiqsa-troubleshooting`, that must never reach chats.
 * A key is permanent: users' Off switches and run bindings follow it across
 * releases, and removing it retires the Skill on the next upgrade.
 */
export const SHIPPED_SKILLS: readonly Readonly<{ key: string; directory: string }>[] = Object.freeze([
  Object.freeze({ key: "health-questions", directory: "skills/health-questions" })
]);

export type ShippedSkill = Readonly<{ key: string; content: SkillRevisionContent }>;

export class ShippedSkillError extends Error {
  constructor(readonly key: string, reason: string) {
    super(`Shipped Skill ${key}: ${reason}`);
    this.name = "ShippedSkillError";
  }
}

function listFiles(directory: string, key: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path, key);
    if (!entry.isFile()) throw new ShippedSkillError(key, "only regular files can ship");
    return [path];
  });
}

/** Reads one shipped Skill as the import path would. Migrate-bootstrap has no
 * object storage, so a shipped Skill carries text files only. */
export function loadShippedSkill(root: string, entry: Readonly<{ key: string; directory: string }>): ShippedSkill {
  const directory = join(root, entry.directory);
  const files = listFiles(directory, entry.key).map((path) => ({
    path: relative(directory, path).split(sep).join("/"),
    bytes: readFileSync(path),
    executable: false
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const markdown = files.find((file) => file.path === "SKILL.md");
  if (!markdown) throw new ShippedSkillError(entry.key, "SKILL.md is missing");
  const bundle: SkillBundle = createSkillBundle(parseSkillMarkdown(markdown.bytes, entry.key),
    files.filter((file) => file !== markdown));
  if (bundle.files.some((file) => file.kind !== "text")) throw new ShippedSkillError(entry.key, "only text files can ship");
  return { key: entry.key, content: shippedSkillContent(bundle) };
}

export function shippedSkillContent(bundle: SkillBundle): SkillRevisionContent {
  return {
    name: bundle.name, description: bundle.description, instructions: bundle.instructions,
    frontmatterJson: bundle.frontmatterJson, bundleDigest: bundle.bundleDigest, fileCount: bundle.fileCount,
    bundleByteSize: bundle.bundleByteSize, hasExecutables: bundle.hasExecutables,
    files: bundle.files.map(({ path, byteSize, checksum, kind, executable, textContent }) =>
      ({ path, byteSize, checksum, kind, executable, textContent }))
  };
}

/** The release's shipped Skills, read from the image's working directory. */
export function loadShippedSkills(root = process.cwd()): ShippedSkill[] {
  return SHIPPED_SKILLS.map((entry) => loadShippedSkill(root, entry));
}
