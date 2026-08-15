// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The checked CLI is intentionally plain Node ESM.
import { checkDocs, runDocsCheck } from "./docs-check.mjs";
import {
  AGENT_DOC_BUDGETS,
  HANDWRITTEN_AGENT_DOCS,
  REQUIRED_DOCS
} from "./docs-manifest.mjs";

const roots: string[] = [];

function write(root: string, relative: string, body = `# ${relative}\n`): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-docs-check-"));
  roots.push(root);
  for (const relative of REQUIRED_DOCS as readonly string[]) write(root, relative);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("documentation sanity check", () => {
  it("accepts the compact required document set", () => {
    const root = fixture();

    expect(checkDocs(root)).toEqual([]);
    expect(runDocsCheck(["--root", root])).toBe("docs:check passed.");
  });

  it("rejects a missing required owner", () => {
    const root = fixture();
    unlinkSync(path.join(root, "agent_docs/SECURITY.md"));

    expect(checkDocs(root)).toContain(
      "missing required document: agent_docs/SECURITY.md"
    );
  });

  it("finds an untracked orphan in a Git worktree", () => {
    const root = fixture();
    const initialized = spawnSync("git", ["init", "-q"], {
      cwd: root,
      encoding: "utf8"
    });
    expect(initialized.status, initialized.stderr).toBe(0);
    write(root, "agent_docs/ORPHAN.md");

    expect(checkDocs(root)).toContain(
      "agent_docs/ORPHAN.md: orphan handwritten agent document; merge it into a core owner or add it deliberately"
    );
  });

  it("rejects a broken local Markdown link", () => {
    const root = fixture();
    write(root, "README.md", "[missing](docs/does-not-exist.md)\n");

    expect(checkDocs(root)).toContain(
      "README.md: broken local Markdown link: docs/does-not-exist.md"
    );
  });

  it("enforces the per-document budget", () => {
    const root = fixture();
    const lines = Array.from(
      { length: AGENT_DOC_BUDGETS.nonEmptyLinesPerFile + 1 },
      (_, index) => `line ${index}`
    );
    write(root, "agent_docs/INDEX.md", `${lines.join("\n")}\n`);

    expect(checkDocs(root)).toContain(
      `agent_docs/INDEX.md: ${lines.length} nonempty lines exceed the ${AGENT_DOC_BUDGETS.nonEmptyLinesPerFile}-line file budget`
    );
  });

  it("enforces the aggregate budget independently of per-document limits", () => {
    const root = fixture();
    const expanded = (HANDWRITTEN_AGENT_DOCS as readonly string[]).slice(0, 5);
    for (const relative of expanded) {
      const lines = Array.from(
        { length: AGENT_DOC_BUDGETS.nonEmptyLinesPerFile },
        (_, index) => `line ${index}`
      );
      write(root, relative, `${lines.join("\n")}\n`);
    }
    const total =
      expanded.length * AGENT_DOC_BUDGETS.nonEmptyLinesPerFile +
      (HANDWRITTEN_AGENT_DOCS as readonly string[]).length - expanded.length;

    expect(checkDocs(root)).toContain(
      `agent_docs: ${total} nonempty lines exceed the ${AGENT_DOC_BUDGETS.nonEmptyLines}-line budget`
    );
  });
});
