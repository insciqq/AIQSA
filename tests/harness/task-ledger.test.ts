import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(process.cwd(), "scripts/task-ledger.mjs");
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-task-ledger-"));
  roots.push(root);
  for (const directory of ["active_tasks", "backlog", "done_tasks"]) {
    mkdirSync(path.join(root, "agent_docs", directory), { recursive: true });
  }
  return root;
}

function task(root: string, directory: string, stem: string, status: string, dependencies = "none", notes?: string) {
  const done = notes === undefined ? "" : `\n## Done Notes\n\n${notes}\n`;
  writeFileSync(
    path.join(root, "agent_docs", directory, `${stem}.md`),
    `# ${stem}\n\nStatus: ${status}\nDepends on: ${dependencies}\n${done}`,
    "utf8"
  );
}

function run(root: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [cli, ...arguments_, "--root", root], { encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("lean task ledger", () => {
  it("allocates natural-width identifiers without claims or queue files", () => {
    const root = fixture();
    task(root, "done_tasks", "999-last-task", "completed");

    const result = run(root, "new", "next-task", "--summary", "Next implementation slice");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created 1000-next-task");
    const body = readFileSync(path.join(root, "agent_docs/backlog/1000-next-task.md"), "utf8");
    expect(body).toContain("Status: backlog");
    expect(body).not.toContain("Claimed by:");
    expect(() => readFileSync(path.join(root, "agent_docs/backlog/README.md"))).toThrow();
  });

  it("promotes and completes a task through directory moves", () => {
    const root = fixture();
    task(root, "done_tasks", "001-foundation", "done");
    task(root, "backlog", "002-follow-up", "backlog", "001-foundation", "Implemented and verified.");

    expect(run(root, "promote", "002").status).toBe(0);
    const active = path.join(root, "agent_docs/active_tasks/002-follow-up.md");
    expect(readFileSync(active, "utf8")).toContain("Status: ready");
    expect(run(root, "complete", "002-follow-up").status).toBe(0);
    const done = readFileSync(path.join(root, "agent_docs/done_tasks/002-follow-up.md"), "utf8");
    expect(done).toMatch(/Status: done\nCompleted: \d{4}-\d{2}-\d{2}/);
  });

  it("refuses promotion while a dependency is unfinished", () => {
    const root = fixture();
    task(root, "backlog", "001-foundation", "backlog");
    task(root, "backlog", "002-follow-up", "backlog", "001-foundation");

    const result = run(root, "promote", "002");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unfinished dependencies: 001-foundation");
  });

  it("requires completion evidence", () => {
    const root = fixture();
    task(root, "active_tasks", "001-work", "ready", "none", "Fill this in when moving to `done_tasks`.");

    const result = run(root, "complete", "001");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Done Notes must contain completion evidence");
  });

  it("rejects unresolved dependencies and cycles before mutation", () => {
    const root = fixture();
    task(root, "backlog", "001-first", "backlog", "002-second");
    task(root, "backlog", "002-second", "backlog", "001-first");

    const cycle = run(root, "promote", "001");
    expect(cycle.status).toBe(1);
    expect(cycle.stderr).toContain("task dependency cycle");

    task(root, "backlog", "002-second", "backlog", "999-missing");
    const missing = run(root, "promote", "001");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("does not resolve to exactly one task");
  });

  it("requires a full stem for ambiguous numeric references", () => {
    const root = fixture();
    task(root, "backlog", "101-01-first", "backlog");
    task(root, "backlog", "101-02-second", "backlog");

    const result = run(root, "promote", "101");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("task 101 is ambiguous");
    expect(run(root, "promote", "101-01-first").status).toBe(0);
  });
});
