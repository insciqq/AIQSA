import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REQUIRED_DOCS } from "../../scripts/docs-manifest.mjs";

const cli = path.resolve(process.cwd(), "scripts/docs-check.mjs");
const generator = path.resolve(process.cwd(), "scripts/generate-doc-reference.mjs");
const roots: string[] = [];
const required = [...REQUIRED_DOCS];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-docs-check-"));
  roots.push(root);
  for (const filename of required) {
    const target = path.join(root, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    const body = filename.endsWith("/CLAUDE.md") || filename === "CLAUDE.md"
      ? "@AGENTS.md\n"
      : filename.endsWith("/AGENTS.md")
        ? "# AGENTS\n\nScope: fixture domain instructions.\n"
        : filename === "agent_docs/ENV_VARIABLES.md"
          ? "# Environment\n\nEXAMPLE_KEY=\n"
          : `# ${filename}\n`;
    writeFileSync(target, body);
  }
  writeFileSync(path.join(root, ".env.example"), "EXAMPLE_KEY=value\n");
  writeFileSync(
    path.join(root, ".gitignore"),
    "/agent_docs/tasks/*.md\n!/agent_docs/tasks/README.md\n/agent_docs/task_archive/*\n!/agent_docs/task_archive/README.md\n/agent_docs/PRD/**\n/agent_docs/backlog/**\n"
  );
  writeFileSync(path.join(root, "README.md"), "# README\n\n[Architecture](agent_docs/ARCHITECTURE.md)\n");
  mkdirSync(path.join(root, "app/api/health"), { recursive: true });
  writeFileSync(path.join(root, "app/api/health/route.ts"), "export function GET() {}\n");
  mkdirSync(path.join(root, "prisma"), { recursive: true });
  writeFileSync(path.join(root, "prisma/schema.prisma"), "model User {\n  id String @id\n}\n\nenum UserStatus {\n  active\n}\n");
  const generated = spawnSync(process.execPath, [generator, "--root", root], { encoding: "utf8" });
  if (generated.status !== 0) throw new Error(generated.stderr);
  const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  const staged = spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  if (staged.status !== 0) throw new Error(staged.stderr);
  return root;
}

function task(root: string, stem: string, status = "backlog", dependencies = "none") {
  writeFileSync(
    path.join(root, "agent_docs/tasks", `${stem}.md`),
    `# ${stem}

Status: ${status}
Depends on: ${dependencies}
Blocked by: none
Durable rationale: none

## Goal

Deliver the fixture outcome.

## Context

- Fixture owner.

## Scope

- Fixture change.

## Out Of Scope

- Runtime changes outside the fixture.

## Acceptance Criteria

- Fixture behavior is observable.

## Plan

- [ ] Run the fixture milestone.

## Progress

- Not started.

## Decisions

- None.

## Verification

- [ ] focused fixture check
`,
    "utf8"
  );
}

function check(root: string) {
  return spawnSync(process.execPath, [cli, "--root", root], { encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("current documentation and harness sanity check", () => {
  it("keeps one unique mandatory-document manifest", () => {
    expect(new Set(REQUIRED_DOCS).size).toBe(REQUIRED_DOCS.length);
  });

  it("accepts current docs, scoped imports, env keys, and a local task graph", () => {
    const root = fixture();
    task(root, "20260801120000001-follow-up");

    const result = check(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs:check passed.");
  });

  it("reports missing required documents", () => {
    const root = fixture();
    rmSync(path.join(root, "agent_docs/security/MCP_RUNTIME.md"));

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required document: agent_docs/security/MCP_RUNTIME.md");
  });

  it("reports broken local Markdown links", () => {
    const root = fixture();
    writeFileSync(path.join(root, "README.md"), "[Missing](agent_docs/missing.md)\n");

    expect(check(root).stderr).toContain("broken local Markdown link");
  });

  it("allows a current top-level docs directory but rejects obsolete harness directories", () => {
    const root = fixture();
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs/README.md"), "# Public documentation\n");
    mkdirSync(path.join(root, "agent_docs/done_tasks"));

    const result = check(root);

    expect(result.stderr).not.toContain("docs: obsolete top-level human-docs directory");
    expect(result.stderr).toContain("agent_docs/done_tasks: obsolete harness directory");
  });

  it("allows ignored operator-local PRD and backlog directories outside the task ledger", () => {
    const root = fixture();
    mkdirSync(path.join(root, "agent_docs/PRD"), { recursive: true });
    mkdirSync(path.join(root, "agent_docs/backlog"), { recursive: true });
    writeFileSync(
      path.join(root, "agent_docs/PRD/private.md"),
      "Private reference with agent_docs/ADR/0001-old.md.\n"
    );
    writeFileSync(
      path.join(root, "agent_docs/backlog/private.md"),
      "Private backlog with agent_docs/archive/old.md.\n"
    );

    expect(check(root).status).toBe(0);
  });

  it("scans tracked and unignored Markdown anywhere in the repository", () => {
    const root = fixture();
    mkdirSync(path.join(root, "packages/example"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/example/README.md"),
      "# Example\n\nSee agent_docs/ADR/0001-old.md.\n"
    );

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/example/README.md: references obsolete ADR path");
  });

  it("falls back to repository-wide filesystem discovery outside Git", () => {
    const root = fixture();
    rmSync(path.join(root, ".git"), { force: true, recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(path.join(root, "notes/README.md"), "See agent_docs/ADR/0001-old.md.\n");

    expect(check(root).stderr).toContain("notes/README.md: references obsolete ADR path");
  });

  it("keeps root and nearest instructions within context budgets", () => {
    const root = fixture();
    writeFileSync(path.join(root, "AGENTS.md"), `# AGENTS\n${"instruction\n".repeat(201)}`);
    expect(check(root).stderr).toContain("root-instruction budget");

    writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n");
    writeFileSync(
      path.join(root, "components/AGENTS.md"),
      `# AGENTS\n\nScope: component instructions.\n${"nested instruction\n".repeat(41)}`
    );
    expect(check(root).stderr).toContain("components/AGENTS.md: exceeds the 40-line/4096-byte nested-instruction budget");
  });

  it("requires exact root and scoped Claude imports", () => {
    const root = fixture();
    writeFileSync(path.join(root, "CLAUDE.md"), "# duplicated rules\n");
    expect(check(root).stderr).toContain("CLAUDE.md: must contain only the shared-instruction import @AGENTS.md");

    writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\n");
    writeFileSync(path.join(root, "components/CLAUDE.md"), "# duplicated rules\n");
    expect(check(root).stderr).toContain("components/CLAUDE.md: must contain only the scoped-instruction import @AGENTS.md");
  });

  it("requires every example environment key to be documented", () => {
    const root = fixture();
    writeFileSync(path.join(root, ".env.example"), "UNDOCUMENTED_KEY=value\n");

    expect(check(root).stderr).toContain("missing .env.example key UNDOCUMENTED_KEY");
  });

  it("requires bounded metadata, rejects global freshness stamps, and caps living-document size", () => {
    const root = fixture();
    const target = path.join(root, "agent_docs/SECURITY.md");
    const body = `# SECURITY\n\n${"security contract text\n".repeat(900)}`;
    writeFileSync(target, body);

    const missing = check(root);
    expect(missing.stderr).toContain("large living document needs a bounded Owner marker");
    expect(readFileSync(target, "utf8")).toBe(body);

    writeFileSync(
      target,
      `# SECURITY\n\nOwner: Security maintainers\nScope: Current security behavior for the fixture only.\nVerified against: abcdef0 (2000-01-01)\n\n${"security contract text\n".repeat(900)}`
    );
    expect(check(root).stderr).toContain("ordinary living documents must not carry a global Verified against stamp");

    writeFileSync(
      target,
      `# SECURITY\n\nOwner: Security maintainers\nScope: Current security behavior for the fixture only.\n\n${"security contract text long enough to exceed the cap\n".repeat(1_100)}`
    );
    expect(check(root).stderr).toContain("exceed the 40960-byte non-generated living-document cap");
  });

  it("rejects copied normative prose but ignores code and routing indexes", () => {
    const root = fixture();
    const first = path.join(root, "agent_docs/security/MCP_RUNTIME.md");
    const second = path.join(root, "agent_docs/backend/api/AUTH_AND_ONBOARDING.md");
    const router = path.join(root, "agent_docs/SECURITY.md");
    const copied = "Every durable contract in this deliberately long fixture paragraph has one normative owner. "
      + "Another bounded document links that owner and records only the enforcement or presentation facts "
      + "specific to its own layer, so future edits cannot silently create two competing sources of truth.";

    writeFileSync(first, `# MCP runtime\n\n${copied}\n`);
    writeFileSync(second, `# Auth and onboarding\n\n${copied}\n`);

    const duplicated = check(root);
    expect(duplicated.status).toBe(1);
    expect(duplicated.stderr).toContain("duplicates a substantial normative block from");

    writeFileSync(second, `# Auth and onboarding\n\n\`\`\`text\n${copied}\n\`\`\`\n`);
    writeFileSync(
      router,
      `# Security\n\nScope: Non-normative router to fixture owners.\n\n${copied}\n`
    );
    writeFileSync(
      path.join(root, "AGENTS.md"),
      `# AGENTS\n\nScope: fixture domain instructions.\n\n${copied}\n`
    );
    writeFileSync(path.join(root, "agent_docs/tasks/README.md"), `# Tasks\n\n${copied}\n`);
    writeFileSync(path.join(root, "agent_docs/generated/COPY.md"), `# Generated\n\n${copied}\n`);

    const nonNormativeCopies = check(root);
    expect(nonNormativeCopies.status).toBe(0);
  });

  it("reports generated route or schema drift", () => {
    const root = fixture();
    writeFileSync(path.join(root, "app/api/health/route.ts"), "export function POST() {}\n");

    expect(check(root).stderr).toContain("stale generated reference");
  });

  it("reports invalid task state and dependency cycles", () => {
    const root = fixture();
    task(root, "20260801120000001-first", "backlog", "20260801120000002-second");
    task(root, "20260801120000002-second", "backlog", "20260801120000001-first");

    expect(check(root).stderr).toContain("task dependency cycle");
  });

  it("requires local task ignore rules and rejects force-tracked task instances", () => {
    const root = fixture();
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
    expect(check(root).stderr).toContain("must ignore /agent_docs/tasks/*.md");

    writeFileSync(
      path.join(root, ".gitignore"),
      "/agent_docs/tasks/*.md\n!/agent_docs/tasks/README.md\n"
    );
    const stem = "20260801120000001-tracked-task";
    task(root, stem);
    const staged = spawnSync("git", ["add", "-f", `agent_docs/tasks/${stem}.md`], { cwd: root, encoding: "utf8" });
    expect(staged.status).toBe(0);
    expect(check(root).stderr).toContain("public Git must not track task instances");
  });

  it("scans current source for obsolete references but leaves migration history immutable", () => {
    const root = fixture();
    mkdirSync(path.join(root, "lib"), { recursive: true });
    writeFileSync(path.join(root, "lib/current.ts"), "// See agent_docs/ADR/0001-old.md\n");
    expect(check(root).stderr).toContain("lib/current.ts: references obsolete harness");

    rmSync(path.join(root, "lib/current.ts"));
    writeFileSync(path.join(root, "custom.config.ts"), "// See agent_docs/ADR/0001-old.md\n");
    expect(check(root).stderr).toContain("custom.config.ts: references obsolete harness");

    rmSync(path.join(root, "custom.config.ts"));
    mkdirSync(path.join(root, "prisma/migrations/20260101000000_history"), { recursive: true });
    writeFileSync(
      path.join(root, "prisma/migrations/20260101000000_history/migration.sql"),
      "-- Historical agent_docs/ADR/0001-old.md reference must remain immutable.\n"
    );
    writeFileSync(
      path.join(root, "prisma/migrations/20260101000000_history/README.md"),
      "Historical agent_docs/ADR/0001-old.md reference must remain immutable.\n"
    );
    expect(check(root).status).toBe(0);
  });

  it("does not treat a product name as an obsolete publication contract", () => {
    const root = fixture();
    writeFileSync(path.join(root, "README.md"), "A contributor may import work from GitLab.\n");

    expect(check(root).status).toBe(0);
  });
});
