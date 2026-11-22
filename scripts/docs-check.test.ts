// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The checked CLI is intentionally plain Node ESM.
import { checkDocs, runDocsCheck } from "./docs-check.mjs";
import { REQUIRED_DOCS } from "./docs-manifest.mjs";

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

  it("sets no size limit on documents or instructions", () => {
    const root = fixture();
    const long = `${Array.from({ length: 400 }, () => Array(40).fill("word").join(" ")).join("\n")}\n`;
    write(root, "agent_docs/TESTING.md", long);
    write(root, "AGENTS.md", long);

    expect(checkDocs(root)).toEqual([]);
  });

  describe("path-scoped rules", () => {
    const scoped = (...globs: string[]) =>
      `---\npaths:\n${globs.map((glob) => `  - "${glob}"`).join("\n")}\n---\n# Memory\n`;
    const link = (root: string, name: string, target: string) => {
      mkdirSync(path.join(root, ".claude/rules"), { recursive: true });
      symlinkSync(target, path.join(root, ".claude/rules", name));
    };

    it("accepts a document linked from exactly one rule whose globs match files", () => {
      const root = fixture();
      write(root, "lib/server/memory/store.ts", "export {};\n");
      write(root, "agent_docs/MEMORY.md", scoped("lib/server/memory/**", "**/*.{ts,tsx}"));
      link(root, "memory.md", "../../agent_docs/MEMORY.md");

      expect(checkDocs(root)).toEqual([]);
    });

    it("matches globs against committed migrations", () => {
      const root = fixture();
      write(root, "prisma/migrations/20260101000000_init/migration.sql", "SELECT 1;\n");
      write(root, "agent_docs/PERSISTENCE.md", scoped("prisma/migrations/**"));
      link(root, "persistence.md", "../../agent_docs/PERSISTENCE.md");

      expect(checkDocs(root)).toEqual([]);
    });

    it("requires a rule symlink for a document with paths frontmatter", () => {
      const root = fixture();
      write(root, "lib/server/memory/store.ts", "export {};\n");
      write(root, "agent_docs/MEMORY.md", scoped("lib/server/memory/**"));

      expect(checkDocs(root)).toEqual([
        "agent_docs/MEMORY.md: paths frontmatter needs exactly one symlink in .claude/rules/, found 0"
      ]);
    });

    it("rejects globs that match nothing and frontmatter Claude Code would not scope", () => {
      const root = fixture();
      write(root, "agent_docs/MEMORY.md", scoped("lib/server/missing/**"));
      link(root, "memory.md", "../../agent_docs/MEMORY.md");
      write(root, "agent_docs/PROVIDERS.md", "---\npaths: lib/server/providers/**\n---\n# Providers\n");

      expect(checkDocs(root)).toEqual([
        "agent_docs/PROVIDERS.md: frontmatter must contain only a paths: list",
        "agent_docs/MEMORY.md: paths glob matches no file: lib/server/missing/**"
      ]);
    });

    it("keeps rule content in agent documents", () => {
      const root = fixture();
      write(root, ".claude/rules/inline.md", "# Inline rule\n");
      link(root, "orphan.md", "../../README.md");

      expect(checkDocs(root)).toEqual([
        ".claude/rules/inline.md: rules must be symlinks to a handwritten agent document that carries the paths frontmatter",
        ".claude/rules/orphan.md: rules must be symlinks to a handwritten agent document that carries the paths frontmatter"
      ]);
    });
  });

  it("rejects a cited repository path that does not exist", () => {
    const root = fixture();
    write(root, "lib/server/memory/store.ts", "export {};\n");
    write(root, "proxy.ts", "export {};\n");
    write(root, "prisma/migrations/20260101000000_init/migration.sql", "SELECT 1;\n");
    write(
      root,
      "agent_docs/MEMORY.md",
      [
        "Present: `lib/server/memory/store.ts`, `lib/server/memory/`, `proxy.ts`,",
        "`prisma/migrations/20260101000000_init/migration.sql`.",
        "Missing: `lib/server/gone.ts`, `gone.ts`.",
        "Not paths: `lib/**/x.ts`, `agent_docs/<FILE>.md`, `queue/old.md`, `aiqsa.chat`, `/c/<id>`.",
        "Private, absent from clones and exports: `agent_docs/PRD/`, `.claude/agents/`, `DEV_SERVER.md`.",
        "```",
        "`lib/server/fenced.ts`",
        "```",
        ""
      ].join("\n")
    );

    expect(checkDocs(root)).toEqual([
      "agent_docs/MEMORY.md: cited path does not exist: lib/server/gone.ts",
      "agent_docs/MEMORY.md: cited path does not exist: gone.ts"
    ]);
  });
});
