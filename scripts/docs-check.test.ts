import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REQUIRED_DOCS } from "./docs-manifest.mjs";

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
    "/agent_docs/tasks/queue/*.md\n!/agent_docs/tasks/queue/README.md\n"
      + "/agent_docs/tasks/archive/*\n!/agent_docs/tasks/archive/README.md\n"
      + "/agent_docs/tasks/drafts/*\n!/agent_docs/tasks/drafts/README.md\n"
      + "/agent_docs/tasks/*.md\n!/agent_docs/tasks/README.md\n"
      + "/agent_docs/task_archive/*\n/agent_docs/backlog/**\n"
      + "/agent_docs/PRD/**\n"
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
    path.join(root, "agent_docs/tasks/queue", `${stem}.md`),
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
    rmSync(path.join(root, "agent_docs/frontend/composer/ANSWER_OUTPUTS_AND_BRANCHES.md"));

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "missing required document: agent_docs/frontend/composer/ANSWER_OUTPUTS_AND_BRANCHES.md"
    );
  });

  it("reports broken local Markdown links", () => {
    const root = fixture();
    writeFileSync(path.join(root, "README.md"), "[Missing](agent_docs/missing.md)\n");

    expect(check(root).stderr).toContain("broken local Markdown link");
  });

  it("falls back to repository-wide filesystem discovery outside Git", () => {
    const root = fixture();
    rmSync(path.join(root, ".git"), { force: true, recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(path.join(root, "notes/README.md"), "[Missing](missing.md)\n");

    expect(check(root).stderr).toContain("notes/README.md: broken local Markdown link");
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
    expect(check(root).stderr).toContain("must ignore /agent_docs/tasks/queue/*.md");

    const ignoreContract = "/agent_docs/tasks/queue/*.md\n!/agent_docs/tasks/queue/README.md\n"
      + "/agent_docs/tasks/archive/*\n!/agent_docs/tasks/archive/README.md\n"
      + "/agent_docs/tasks/drafts/*\n!/agent_docs/tasks/drafts/README.md\n"
      + "/agent_docs/tasks/*.md\n!/agent_docs/tasks/README.md\n"
      + "/agent_docs/task_archive/*\n/agent_docs/backlog/**\n";
    writeFileSync(path.join(root, ".gitignore"), ignoreContract.replace("!/agent_docs/tasks/README.md\n", ""));
    expect(check(root).stderr).toContain("must keep agent_docs/tasks/README.md trackable");

    writeFileSync(path.join(root, ".gitignore"), ignoreContract);
    const stem = "20260801120000001-tracked-task";
    task(root, stem);
    const staged = spawnSync("git", ["add", "-f", `agent_docs/tasks/queue/${stem}.md`], { cwd: root, encoding: "utf8" });
    expect(staged.status).toBe(0);
    expect(check(root).stderr).toContain("public Git must not track task instances");
  });

});
