import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(process.cwd(), "scripts/docs-check.mjs");
const roots: string[] = [];
const required = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "agent_docs/AUTONOMOUS_WORKFLOW.md",
  "agent_docs/AI_CONTEXT.md",
  "agent_docs/ARCHITECTURE.md",
  "agent_docs/BACKEND.md",
  "agent_docs/CRITICAL_INVARIANTS.md",
  "agent_docs/DECISION_DEFAULTS.md",
  "agent_docs/DESIGN_SYSTEM.md",
  "agent_docs/FRONTEND.md",
  "agent_docs/ENV_VARIABLES.md",
  "agent_docs/PROVIDER_API_NOTES.md",
  "agent_docs/QSA_PIPELINE.md",
  "agent_docs/RISKS.md",
  "agent_docs/SECURITY.md",
  "agent_docs/TESTING.md",
  "agent_docs/TASK_TEMPLATE.md",
  "agent_docs/ADR/README.md",
  "agent_docs/active_tasks/README.md",
  "agent_docs/backlog/README.md",
  "agent_docs/done_tasks/README.md"
];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-docs-check-"));
  roots.push(root);
  for (const filename of required) {
    const target = path.join(root, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    const body = filename === "agent_docs/ENV_VARIABLES.md"
      ? "# Environment\n\nEXAMPLE_KEY=\n"
      : filename === "CLAUDE.md"
        ? "# CLAUDE\n\nFollow [AGENTS.md](AGENTS.md).\n"
        : `# ${filename}\n`;
    writeFileSync(target, body);
  }
  for (const directory of ["active_tasks", "backlog", "done_tasks"]) {
    mkdirSync(path.join(root, "agent_docs", directory), { recursive: true });
  }
  writeFileSync(path.join(root, ".env.example"), "EXAMPLE_KEY=value\n");
  writeFileSync(path.join(root, "README.md"), "# README\n\n[Architecture](agent_docs/ARCHITECTURE.md)\n");
  return root;
}

function task(root: string, directory: string, stem: string, status: string, dependencies = "none", notes?: string) {
  const done = notes === undefined ? "" : `\n## Done Notes\n\n${notes}\n`;
  writeFileSync(
    path.join(root, "agent_docs", directory, `${stem}.md`),
    `# ${stem}\n\nStatus: ${status}\nDepends on: ${dependencies}\n${done}`
  );
}

function check(root: string) {
  return spawnSync(process.execPath, [cli, "--root", root], { encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("lean documentation sanity check", () => {
  it("accepts required docs, links, env keys, and a valid task graph", () => {
    const root = fixture();
    task(root, "done_tasks", "001-foundation", "completed");
    task(root, "backlog", "002-follow-up", "backlog", "001-foundation");

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

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("broken local Markdown link");
  });

  it("checks the done-journal README without scanning immutable completion entries", () => {
    const root = fixture();
    writeFileSync(path.join(root, "agent_docs/done_tasks/README.md"), "[Missing](../missing.md)\n");

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("agent_docs/done_tasks/README.md: broken local Markdown link");
  });

  it("keeps root instruction files within their context budgets", () => {
    const root = fixture();
    writeFileSync(path.join(root, "AGENTS.md"), `# AGENTS\n${"instruction\n".repeat(201)}`);

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENTS.md:");
    expect(result.stderr).toContain("root-instruction budget");
  });

  it("keeps CLAUDE.md as a pointer to the canonical root instructions", () => {
    const root = fixture();
    writeFileSync(path.join(root, "CLAUDE.md"), "# CLAUDE\n\nDuplicated repository rules.\n");

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLAUDE.md: must route to AGENTS.md");
  });

  it("requires every example environment key to be documented", () => {
    const root = fixture();
    writeFileSync(path.join(root, ".env.example"), "UNDOCUMENTED_KEY=value\n");

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing .env.example key UNDOCUMENTED_KEY");
  });

  it("reports task status and dependency errors", () => {
    const root = fixture();
    task(root, "active_tasks", "001-active", "backlog", "999-missing");

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected Status: ready");
    expect(result.stderr).toContain("dependency 999-missing does not resolve");
  });

  it("reports open dependency cycles", () => {
    const root = fixture();
    task(root, "backlog", "001-first", "backlog", "002-second");
    task(root, "backlog", "002-second", "backlog", "001-first");

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("task dependency cycle");
  });

  it("requires evidence in modern done journals", () => {
    const root = fixture();
    task(root, "done_tasks", "001-finished", "done", "none", "Fill this in when moving to `done_tasks`.");

    const result = check(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Done Notes must contain completion evidence");
  });
});
