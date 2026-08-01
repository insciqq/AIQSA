import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { databaseRequiredTestFiles } from "../../vitest.hermetic.policy";

function testFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && ![".git", ".next", "node_modules"].includes(entry.name)) {
      files.push(...testFiles(target));
    } else if (entry.isFile() && /\.test\.(?:ts|tsx)$/u.test(entry.name)) {
      files.push(target);
    }
  }
  return files;
}

describe("hermetic Vitest classification", () => {
  it("keeps every direct Prisma singleton test in the explicit database lane", () => {
    const root = process.cwd();
    const directDatabaseTests = testFiles(root)
      .filter((filename) => !filename.includes(".integration.test."))
      .filter((filename) => /import\s+\{\s*prisma\s*\}\s+from\s+["'][^"']*\/prisma["']/u.test(
        readFileSync(filename, "utf8")
      ))
      .map((filename) => path.relative(root, filename).split(path.sep).join("/"))
      .sort();

    expect([...databaseRequiredTestFiles].sort()).toEqual(directDatabaseTests);
    for (const filename of databaseRequiredTestFiles) expect(existsSync(path.join(root, filename))).toBe(true);
  });
});
