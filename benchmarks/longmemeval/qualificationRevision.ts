import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const excludedPrefixes = Object.freeze([
  "agent_docs/",
  "benchmarks/longmemeval/.upstream/",
  "benchmarks/longmemeval/qualifications/",
  "benchmarks/longmemeval/results/"
]);

export type LongMemEvalQualificationRevision = Readonly<{
  headCommit: string;
  worktreeSha256: string;
}>;

export function longMemEvalQualificationRevisionPathIncluded(path: string): boolean {
  return path.length > 0 && !path.includes("\u0000") &&
    !excludedPrefixes.some((prefix) => path.startsWith(prefix));
}

function frame(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(String(bytes.byteLength), "utf8");
  hash.update(":", "utf8");
  hash.update(bytes);
  hash.update("\n", "utf8");
}

export async function currentLongMemEvalQualificationRevision(
  repositoryRoot: string
): Promise<LongMemEvalQualificationRevision> {
  const [{ stdout: head }, { stdout: listed }] = await Promise.all([
    execFile("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }),
    execFile("git", [
      "-C",
      repositoryRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard"
    ], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024
    })
  ]);
  const headCommit = head.trim();
  if (!/^[a-f0-9]{40}$/u.test(headCommit)) {
    throw new Error("longmemeval_qualification_revision_invalid");
  }
  const paths = listed.toString("utf8").split("\u0000")
    .filter(longMemEvalQualificationRevisionPathIncluded)
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error("longmemeval_qualification_revision_invalid");
  }
  const hash = createHash("sha256");
  hash.update("aiqsa.longmemeval.qualification-worktree.v1\n", "utf8");
  for (const path of paths) {
    const absolutePath = resolve(repositoryRoot, path);
    const metadata = await lstat(absolutePath);
    frame(hash, path);
    if (metadata.isSymbolicLink()) {
      frame(hash, "symlink");
      frame(hash, await readlink(absolutePath));
    } else if (metadata.isFile()) {
      frame(hash, metadata.mode & 0o111 ? "executable" : "file");
      frame(hash, await readFile(absolutePath));
    } else {
      throw new Error("longmemeval_qualification_revision_invalid");
    }
  }
  return Object.freeze({
    headCommit,
    worktreeSha256: hash.digest("hex")
  });
}

export async function assertLongMemEvalQualificationRevision(
  repositoryRoot: string,
  expected: LongMemEvalQualificationRevision
): Promise<void> {
  const current = await currentLongMemEvalQualificationRevision(repositoryRoot);
  if (current.headCommit !== expected.headCommit ||
    current.worktreeSha256 !== expected.worktreeSha256) {
    throw new Error("longmemeval_qualification_revision_mismatch");
  }
}
