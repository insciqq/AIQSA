import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeRoots = ["app", "components", "lib"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".mjs", ".cjs"]);
const forbiddenDatasetTokens = [
  "LongMemEval",
  "answerSessionIds",
  "answer_session_ids",
  "goldSession",
  "gold_session",
  "longmemeval",
  "question_type"
] as const;

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

describe("LongMemEval runtime isolation", () => {
  it("keeps benchmark and oracle metadata out of application runtime modules", () => {
    const violations = runtimeRoots.flatMap((root) =>
      sourceFiles(resolve(repositoryRoot, root)).flatMap((path) => {
        const source = readFileSync(path, "utf8");
        const tokens = forbiddenDatasetTokens.filter((token) => source.includes(token));
        return tokens.length > 0
          ? [{ path: path.slice(repositoryRoot.length + 1), tokens }]
          : [];
      }));
    expect(violations).toEqual([]);
  });
});
