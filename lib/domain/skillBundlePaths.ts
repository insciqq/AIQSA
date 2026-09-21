import { isSafeWorkspaceRelativePath } from "./workspace";

export const SKILL_WORKSPACE_DIRECTORY = "/workspace/.aiqsa/skills";
export function skillWorkspacePath(alias: string): string | null {
  return alias.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(alias)
    ? `${SKILL_WORKSPACE_DIRECTORY}/${alias}` : null;
}

/** Lossless ustar name/prefix split, measured in UTF-8 bytes. */
export function skillTarPath(path: string): readonly [prefix: string, name: string] | null {
  if (!isSafeWorkspaceRelativePath(path) || /^[a-z]:/iu.test(path)) return null;
  const length = (value: string) => new TextEncoder().encode(value).length;
  if (length(path) <= 100) return ["", path];
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (length(prefix) <= 155 && length(name) <= 100) return [prefix, name];
  }
  return null;
}

export function skillAlias(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64).replace(/-+$/u, "") || "skill";
  let alias = base;
  for (let suffix = 2; used.has(alias); suffix += 1) {
    const tail = `-${suffix}`;
    alias = `${base.slice(0, 64 - tail.length).replace(/-+$/u, "")}${tail}`;
  }
  used.add(alias);
  return alias;
}
