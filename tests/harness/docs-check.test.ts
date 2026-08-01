import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(process.cwd(), "scripts/docs-check.mjs");
const generator = path.resolve(process.cwd(), "scripts/generate-doc-reference.mjs");
const roots: string[] = [];
const required = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "components/AGENTS.md",
  "components/CLAUDE.md",
  "lib/server/AGENTS.md",
  "lib/server/CLAUDE.md",
  "ops/AGENTS.md",
  "ops/CLAUDE.md",
  "ops/nginx/README.md",
  "ops/systemd/README.md",
  "prisma/AGENTS.md",
  "prisma/CLAUDE.md",
  "agent_docs/AUTONOMOUS_WORKFLOW.md",
  "agent_docs/AI_CONTEXT.md",
  "agent_docs/ARCHITECTURE.md",
  "agent_docs/BACKEND.md",
  "agent_docs/backend/API_AND_AUTH.md",
  "agent_docs/backend/PERSISTENCE_AND_RETENTION.md",
  "agent_docs/backend/PROVIDER_ADAPTERS.md",
  "agent_docs/backend/RUNS_AND_STREAMING.md",
  "agent_docs/CRITICAL_INVARIANTS.md",
  "agent_docs/DECISION_DEFAULTS.md",
  "agent_docs/DESIGN_SYSTEM.md",
  "agent_docs/FRONTEND.md",
  "agent_docs/frontend/ACCOUNT_ADMIN_AND_SHARING.md",
  "agent_docs/frontend/COMPOSER_AND_CONTROLS.md",
  "agent_docs/frontend/IMPLEMENTATION_STATE.md",
  "agent_docs/frontend/MESSAGES_AND_MARKDOWN.md",
  "agent_docs/frontend/PRODUCT_AND_LAYOUT.md",
  "agent_docs/frontend/VISUAL_INTERACTION.md",
  "agent_docs/ENV_VARIABLES.md",
  "agent_docs/PRODUCT_PRINCIPLES.md",
  "agent_docs/PROVIDER_API_NOTES.md",
  "agent_docs/QSA_PIPELINE.md",
  "agent_docs/RISKS.md",
  "agent_docs/SECURITY.md",
  "agent_docs/TESTING.md",
  "agent_docs/TASK_TEMPLATE.md",
  "agent_docs/tasks/README.md",
  "agent_docs/generated/API_AND_SCHEMA.md"
];

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
    "/agent_docs/tasks/*.md\n!/agent_docs/tasks/README.md\n"
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
Human review: optional
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
  it("accepts current docs, scoped imports, env keys, and a local task graph", () => {
    const root = fixture();
    task(root, "20260801120000001-follow-up");

    const result = check(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs:check passed.");
  });

  it("reports missing required documents", () => {
    const root = fixture();
    rmSync(path.join(root, "agent_docs/SECURITY.md"));

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required document: agent_docs/SECURITY.md");
  });

  it("reports broken local Markdown links", () => {
    const root = fixture();
    writeFileSync(path.join(root, "README.md"), "[Missing](agent_docs/missing.md)\n");

    expect(check(root).stderr).toContain("broken local Markdown link");
  });

  it("rejects the removed top-level docs and obsolete harness directories", () => {
    const root = fixture();
    mkdirSync(path.join(root, "docs"));
    mkdirSync(path.join(root, "agent_docs/done_tasks"));

    const result = check(root);

    expect(result.stderr).toContain("docs: obsolete top-level human-docs directory");
    expect(result.stderr).toContain("agent_docs/done_tasks: obsolete harness directory");
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

  it("reports missing and stale large-document review markers without rewriting", () => {
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
    expect(check(root).stderr).toContain("stale verification marker");
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
    mkdirSync(path.join(root, "prisma/migrations/20260101000000_history"), { recursive: true });
    writeFileSync(
      path.join(root, "prisma/migrations/20260101000000_history/migration.sql"),
      "-- Historical agent_docs/ADR/0001-old.md reference must remain immutable.\n"
    );
    expect(check(root).status).toBe(0);
  });

  it("rejects current GitLab publication wording", () => {
    const root = fixture();
    writeFileSync(path.join(root, "README.md"), "Development is published from GitLab.\n");

    expect(check(root).stderr).toContain("obsolete GitLab publication contract");
  });
});
