import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, type TestContext } from "vitest";

/**
 * Installations upgrade from a release, so its migrations are immutable (agent_docs/PERSISTENCE.md). The latest
 * release is the highest stable tag reachable from HEAD, as for the release plan (scripts/release-plan.mjs); its
 * migration directories are compared with the working tree through Git object ids, with no database.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsPath = "prisma/migrations";
const baseline = "20260815000000_baseline";
const stableReleaseTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const regularFileModes = new Set(["100644", "100755"]);

type ReleasedFile = Readonly<{ mode: string; objectId: string }>;
type Release = Readonly<{ tag: string; objectFormat: string; directories: ReadonlyMap<string, ReadonlyMap<string, ReleasedFile>> }>;

function git(args: readonly string[]): Readonly<{ ok: boolean; stdout: string; stderr: string }> {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: result.error === undefined && result.status === 0,
    stderr: result.error?.message ?? result.stderr,
    stdout: result.stdout ?? ""
  };
}

function requireGit(args: readonly string[]): string {
  const result = git(args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function runningInCi(): boolean {
  const value = process.env.CI?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/**
 * A source tree that is not this repository's Git work tree (a `git archive` export, a container copy) cannot be
 * compared and skips. A Git work tree without a reachable release tag skips only in CI, whose shallow checkout
 * fetches no tags; anywhere else it fails rather than pass without checking.
 */
function latestReleaseTag(): Readonly<{ tag: string }> | Readonly<{ skip: string }> {
  const topLevel = git(["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok || realpathSync(topLevel.stdout.trim()) !== realpathSync(repositoryRoot)) {
    return { skip: "this source tree is not a Git work tree, so released migrations cannot be compared here" };
  }
  const tag = requireGit(["tag", "--list", "v*", "--merged", "HEAD", "--sort=-version:refname"])
    .split("\n").map((line) => line.trim()).find((line) => stableReleaseTag.test(line));
  if (tag) return { tag };
  if (runningInCi()) {
    return { skip: "this CI checkout has no release tag reachable from HEAD; check out with fetch-depth: 0 to compare" };
  }
  throw new Error("No release tag vX.Y.Z is reachable from HEAD: fetch the tags and history "
    + "(git fetch --tags, plus --unshallow in a shallow clone) so released migrations can be compared.");
}

function readRelease(tag: string): Release {
  const directories = new Map<string, Map<string, ReleasedFile>>();
  const listing = requireGit(["ls-tree", "-r", "-z", "--full-tree", `refs/tags/${tag}`, "--", `${migrationsPath}/`]);
  for (const entry of listing.split("\0")) {
    if (entry === "") continue;
    const [, mode, objectId, path] = /^(\d{6}) blob ([0-9a-f]+)\t(.+)$/u.exec(entry) ?? [];
    if (mode === undefined || objectId === undefined || path === undefined) {
      throw new Error(`unexpected entry under ${migrationsPath} in ${tag}`);
    }
    const [directory = "", ...rest] = path.slice(migrationsPath.length + 1).split("/");
    if (rest.length === 0) continue; // migration_lock.toml is not a migration
    const files = directories.get(directory) ?? new Map<string, ReleasedFile>();
    files.set(rest.join("/"), { mode, objectId });
    directories.set(directory, files);
  }
  return { directories, objectFormat: requireGit(["rev-parse", "--show-object-format"]).trim(), tag };
}

/** Every file below `directory` with its kind; anything but a regular file counts as changed. */
function treeFiles(directory: string): Map<string, "file" | "other"> {
  const files = new Map<string, "file" | "other">();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files.set(path, entry.isFile() ? "file" : "other");
    }
  };
  walk("");
  return files;
}

function blobId(bytes: Buffer, objectFormat: string): string {
  return createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function releasedMigrationChanges(release: Release): string[] {
  const changes: string[] = [];
  for (const [directory, released] of release.directories) {
    const root = join(repositoryRoot, migrationsPath, directory);
    if (!existsSync(root) || !lstatSync(root).isDirectory()) {
      changes.push(`${directory}: removed`);
      continue;
    }
    const current = treeFiles(root);
    for (const [file, { mode, objectId }] of released) {
      const kind = current.get(file);
      if (kind === undefined) changes.push(`${directory}/${file}: removed`);
      else if (kind !== "file" || !regularFileModes.has(mode)) changes.push(`${directory}/${file}: no longer the released file`);
      else if (blobId(readFileSync(join(root, file)), release.objectFormat) !== objectId) {
        changes.push(`${directory}/${file}: changed`);
      }
    }
    for (const file of current.keys()) {
      if (!released.has(file)) changes.push(`${directory}/${file}: added`);
    }
  }
  return changes;
}

let cachedRelease: Release | undefined;

function releaseOrSkip(context: TestContext): Release {
  if (cachedRelease) return cachedRelease;
  const found = latestReleaseTag();
  if ("skip" in found) return context.skip(found.skip);
  cachedRelease = readRelease(found.tag);
  expect(cachedRelease.directories.has(baseline), `${found.tag} has no ${baseline} migration`).toBe(true);
  return cachedRelease;
}

describe("released migrations", () => {
  it("keep every migration directory of the latest release byte for byte", (context) => {
    const release = releaseOrSkip(context);
    expect(releasedMigrationChanges(release), `released migrations differ from ${release.tag}; `
      + "add a new migration instead of editing a released one").toEqual([]);
  });

  it("place every newer migration after the released ones", (context) => {
    const release = releaseOrSkip(context);
    const lastReleased = [...release.directories.keys()].sort().at(-1) ?? baseline;
    const misplaced = readdirSync(join(repositoryRoot, migrationsPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !release.directories.has(entry.name) && entry.name <= lastReleased)
      .map((entry) => entry.name);
    expect(misplaced, `new migrations must sort after ${lastReleased} from ${release.tag}: an upgraded installation `
      + "applies them last, while a clean install would apply them in name order").toEqual([]);
  });
});
