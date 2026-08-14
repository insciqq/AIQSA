import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(process.cwd(), "scripts/task-ledger.mjs");
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-task-ledger-"));
  roots.push(root);
  mkdirSync(path.join(root, "agent_docs/tasks/queue"), { recursive: true });
  mkdirSync(path.join(root, "agent_docs/tasks/archive"), { recursive: true });
  mkdirSync(path.join(root, "agent_docs/tasks/drafts"), { recursive: true });
  writeFileSync(path.join(root, "agent_docs/tasks/README.md"), "# TASKS\n");
  writeFileSync(path.join(root, "agent_docs/tasks/queue/README.md"), "# TASK QUEUE\n");
  writeFileSync(path.join(root, "agent_docs/tasks/archive/README.md"), "# TASK ARCHIVE\n");
  writeFileSync(path.join(root, "agent_docs/tasks/drafts/README.md"), "# TASK DRAFTS\n");
  writeFileSync(path.join(root, "agent_docs/SECURITY.md"), "# SECURITY\n");
  writeFileSync(
    path.join(root, ".gitignore"),
    "/agent_docs/tasks/queue/*.md\n!/agent_docs/tasks/queue/README.md\n"
      + "/agent_docs/tasks/archive/*\n!/agent_docs/tasks/archive/README.md\n"
      + "/agent_docs/tasks/drafts/*\n!/agent_docs/tasks/drafts/README.md\n"
      + "/agent_docs/tasks/*.md\n!/agent_docs/tasks/README.md\n"
      + "/agent_docs/task_archive/*\n/agent_docs/backlog/**\n"
  );
  const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  return root;
}

type TaskOptions = {
  blockedBy?: string;
  decisions?: string;
  dependencies?: string;
  plan?: string;
  progress?: string;
  rationale?: string;
  verification?: string;
};

function task(root: string, stem: string, status: string, options: TaskOptions = {}) {
  const body = `# ${stem}

Status: ${status}
Depends on: ${options.dependencies ?? "none"}
Blocked by: ${options.blockedBy ?? (status === "blocked" ? "waiting for operator input" : "none")}
Durable rationale: ${options.rationale ?? "none"}

## Goal

Deliver the fixture outcome.

## Context

- Current fixture owner.

## Scope

- Implement the fixture slice.

## Out Of Scope

- Product runtime behavior outside this fixture.

## Acceptance Criteria

- The fixture behavior is observable.

## Plan

${options.plan ?? "- [x] Implement the fixture milestone."}

## Progress

${options.progress ?? "- Fixture implementation recorded."}

## Decisions

${options.decisions ?? "- No lasting decision."}

## Verification

${options.verification ?? "- [x] focused fixture check passed."}
`;
  writeFileSync(path.join(root, "agent_docs/tasks/queue", `${stem}.md`), body, "utf8");
}

function archivedTask(root: string, stem: string) {
  writeFileSync(
    path.join(root, "agent_docs/tasks/archive", `${stem}.md`),
    `# ${stem}\n\nStatus: completed\n`,
    "utf8"
  );
}

function run(root: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [cli, ...arguments_, "--root", root], { encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("local unified task ledger", () => {
  it("creates a timestamp task as ignored local state", () => {
    const root = fixture();

    const result = run(root, "new", "next-task", "--summary", "Next implementation slice");

    expect(result.status).toBe(0);
    const filename = readdirSync(path.join(root, "agent_docs/tasks/queue")).find((entry) => entry !== "README.md");
    expect(filename).toMatch(/^\d{17}-next-task\.md$/);
    const body = readFileSync(path.join(root, "agent_docs/tasks/queue", filename!), "utf8");
    expect(body).toContain("Status: backlog");
    expect(body).toContain("Durable rationale: pending");
    expect(body).not.toContain("Human review:");
    expect(spawnSync("git", ["check-ignore", "-q", `agent_docs/tasks/queue/${filename}`], { cwd: root }).status).toBe(0);
  });

  it("refuses local task creation when the public-repository ignore guard is absent", () => {
    const root = fixture();
    unlinkSync(path.join(root, ".gitignore"));

    const result = run(root, "new", "unsafe-task", "--summary", "Must stay local");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be ignored before local task creation");
    expect(readdirSync(path.join(root, "agent_docs/tasks/queue"))).toEqual(["README.md"]);
  });

  it("fails closed when pre-migration local task state remains", () => {
    const root = fixture();
    writeFileSync(path.join(root, "agent_docs/tasks/20260801120000001-legacy.md"), "private task\n");

    const rootTask = run(root, "list");
    expect(rootTask.status).toBe(1);
    expect(rootTask.stderr).toContain("legacy task-queue entry");

    rmSync(path.join(root, "agent_docs/tasks/20260801120000001-legacy.md"));
    mkdirSync(path.join(root, "agent_docs/backlog"));
    const oldDrafts = run(root, "list");
    expect(oldDrafts.status).toBe(1);
    expect(oldDrafts.stderr).toContain("move its local state to agent_docs/tasks/drafts");
  });

  it("parks a reconciled task outside the ledger and restores its original status", () => {
    const root = fixture();
    const stem = "20260801120000001-paused-work";
    task(root, stem, "ready");

    const parked = run(root, "park", stem);

    expect(parked.status).toBe(0);
    expect(parked.stdout).toContain(`Parked ${stem} at agent_docs/tasks/drafts/${stem}.md`);
    expect(existsSync(path.join(root, "agent_docs/tasks/queue", `${stem}.md`))).toBe(false);
    const draft = path.join(root, "agent_docs/tasks/drafts", `${stem}.md`);
    expect(readFileSync(draft, "utf8")).toContain("Status: ready");
    expect(spawnSync("git", ["check-ignore", "-q", `agent_docs/tasks/drafts/${stem}.md`], { cwd: root }).status).toBe(0);
    expect(run(root, "list").stdout).toContain("No open tasks.");

    const restored = run(root, "restore", stem);

    expect(restored.status).toBe(0);
    expect(restored.stdout).toContain(`Restored ${stem} at agent_docs/tasks/queue/${stem}.md`);
    expect(existsSync(draft)).toBe(false);
    expect(run(root, "list").stdout).toContain(`ready       ${stem}`);
  });

  it("refuses to park active work or a dependency still used by the queue", () => {
    const root = fixture();
    const active = "20260801120000001-active";
    task(root, active, "in_progress");
    expect(run(root, "park", active).stderr).toContain("reconcile it before parking");

    const foundation = "20260801120000002-foundation";
    const dependent = "20260801120000003-dependent";
    task(root, foundation, "backlog");
    task(root, dependent, "backlog", { dependencies: foundation });
    const rejected = run(root, "park", foundation);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(`required by open task(s): ${dependent}`);
  });

  it("rolls back a restore until draft dependencies are restored first", () => {
    const root = fixture();
    const foundation = "20260801120000001-foundation";
    const dependent = "20260801120000002-dependent";
    task(root, foundation, "backlog");
    task(root, dependent, "backlog", { dependencies: foundation });
    expect(run(root, "park", dependent).status).toBe(0);
    expect(run(root, "park", foundation).status).toBe(0);

    const premature = run(root, "restore", dependent);
    expect(premature.status).toBe(1);
    expect(premature.stderr).toContain("does not resolve to exactly one open task");
    expect(existsSync(path.join(root, "agent_docs/tasks/drafts", `${dependent}.md`))).toBe(true);
    expect(existsSync(path.join(root, "agent_docs/tasks/queue", `${dependent}.md`))).toBe(false);

    expect(run(root, "restore", foundation).status).toBe(0);
    expect(run(root, "restore", dependent).status).toBe(0);
  });

  it("completes by archiving the task and clearing remaining dependencies", () => {
    const root = fixture();
    const foundation = "20260801120000001-foundation";
    const followup = "20260801120000002-follow-up";
    task(root, foundation, "in_progress");
    task(root, followup, "backlog", { dependencies: foundation });

    const result = run(root, "complete", foundation);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(root, "agent_docs/tasks/queue", `${foundation}.md`))).toBe(false);
    const archived = path.join(root, "agent_docs/tasks/archive", `${foundation}.md`);
    expect(readFileSync(archived, "utf8")).toContain("Status: completed");
    expect(spawnSync("git", ["check-ignore", "-q", `agent_docs/tasks/archive/${foundation}.md`], { cwd: root }).status).toBe(0);
    expect(readFileSync(path.join(root, "agent_docs/tasks/queue", `${followup}.md`), "utf8")).toContain("Depends on: none");
    expect(result.stdout).toContain(`archived ${foundation} at agent_docs/tasks/archive/${foundation}.md`);
    expect(result.stdout).toContain("cleared 1 dependency reference");
  });

  it("keeps completing beyond ten archived tasks without pruning existing evidence", () => {
    const root = fixture();
    for (let index = 0; index < 10; index += 1) {
      const id = `20260701120000${String(index).padStart(3, "0")}`;
      archivedTask(root, `${id}-archived-${index}`);
    }
    const current = "20260801120000001-current";
    task(root, current, "in_progress");
    const before = readdirSync(path.join(root, "agent_docs/tasks/archive")).sort();

    const result = run(root, "complete", current);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(root, "agent_docs/tasks/queue", `${current}.md`))).toBe(false);
    const after = readdirSync(path.join(root, "agent_docs/tasks/archive")).sort();
    expect(after).toEqual([...before, `${current}.md`].sort());
    expect(readFileSync(path.join(root, "agent_docs/tasks/archive", `${current}.md`), "utf8"))
      .toContain("Status: completed");
  });

  it("accepts an archive above ten while preserving normal queue validation", () => {
    const root = fixture();
    for (let index = 0; index < 25; index += 1) {
      const id = `20260701120000${String(index).padStart(3, "0")}`;
      archivedTask(root, `${id}-archived-${index}`);
    }
    task(root, "20260801120000001-ready", "ready");

    const result = run(root, "list");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ready       20260801120000001-ready");
  });

  it("allows parallel in_progress tasks and enforces dependency-free executable states", () => {
    const root = fixture();
    task(root, "20260801120000001-first", "in_progress");
    task(root, "20260801120000002-second", "in_progress");

    const parallel = run(root, "list");
    expect(parallel.status).toBe(0);
    expect(parallel.stdout.match(/in_progress/g)).toHaveLength(2);

    rmSync(path.join(root, "agent_docs/tasks/queue/20260801120000002-second.md"));
    task(root, "20260801120000002-second", "ready", { dependencies: "20260801120000001-first" });
    const dependency = run(root, "list");
    expect(dependency.status).toBe(1);
    expect(dependency.stderr).toContain("ready task cannot have open dependencies");
  });

  it("rejects unresolved dependencies and cycles", () => {
    const root = fixture();
    task(root, "20260801120000001-first", "backlog", { dependencies: "20260801120000002-second" });
    task(root, "20260801120000002-second", "backlog", { dependencies: "20260801120000001-first" });

    const cycle = run(root, "list");
    expect(cycle.status).toBe(1);
    expect(cycle.stderr).toContain("task dependency cycle");

    task(root, "20260801120000002-second", "backlog", { dependencies: "20260801120000003-missing" });
    const missing = run(root, "list");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("does not resolve to exactly one open task");
  });

  it("allows checked plus unavailable evidence but blocks unavailable-only completion", () => {
    const root = fixture();
    const mixed = "20260801120000001-mixed-evidence";
    task(root, mixed, "in_progress", {
      verification: "- [x] deterministic check passed.\n- Not run: provider smoke — credentials are unavailable"
    });
    expect(run(root, "complete", mixed).status).toBe(0);

    const unavailable = "20260801120000002-unavailable";
    task(root, unavailable, "in_progress", {
      verification: "- Not run: provider smoke — credentials are unavailable"
    });
    const rejected = run(root, "complete", unavailable);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Unavailable-only verification cannot complete a task");
  });

  it("blocks unchecked or malformed verification evidence", () => {
    const root = fixture();
    const unchecked = "20260801120000001-unchecked";
    task(root, unchecked, "in_progress", { verification: "- [ ] npm run check:hermetic" });
    expect(run(root, "complete", unchecked).stderr).toContain("no unchecked checks");

    rmSync(path.join(root, "agent_docs/tasks/queue", `${unchecked}.md`));
    const malformed = "20260801120000002-malformed";
    task(root, malformed, "in_progress", { verification: "- Not run: provider smoke" });
    expect(run(root, "list").stderr).toContain("Not run: <check> — <specific reason>");
  });

  it.each([
    ["an unchecked Plan item", { plan: "- [ ] Finish the fixture milestone." }, "## Plan has 1 unchecked milestone"],
    ["the untouched Progress scaffold", { progress: "- Not started." }, "## Progress must replace the scaffold value"],
    ["the untouched Decisions scaffold", { decisions: "- None yet." }, "## Decisions must replace the scaffold value"]
  ])("rejects %s before completion", (_label, override, expected) => {
    const root = fixture();
    const stem = "20260801120000001-completion-readiness";
    task(root, stem, "in_progress", override);

    const completion = run(root, "complete", stem);
    expect(completion.status).toBe(1);
    expect(completion.stderr).toContain(expected);
  });

  it("accepts an explicit no-decisions completion value", () => {
    const root = fixture();
    const stem = "20260801120000001-no-decisions";
    task(root, stem, "in_progress", { decisions: "- None." });

    expect(run(root, "complete", stem).status).toBe(0);
  });

  it("requires settled durable rationale and validates moved-to owners", () => {
    const root = fixture();
    const pending = "20260801120000001-pending-rationale";
    task(root, pending, "in_progress", { rationale: "pending" });
    expect(run(root, "complete", pending).stderr).toContain("Durable rationale must be settled");

    rmSync(path.join(root, "agent_docs/tasks/queue", `${pending}.md`));
    const moved = "20260801120000002-moved-rationale";
    task(root, moved, "in_progress", { rationale: "moved to agent_docs/SECURITY.md" });
    expect(run(root, "complete", moved).status).toBe(0);

    const invalid = "20260801120000003-invalid-rationale";
    task(root, invalid, "backlog", { rationale: "moved to README.md" });
    expect(run(root, "list").stderr).toContain("owner must be an existing file outside local task directories");
  });

  it("requires a concrete blocker only for blocked state", () => {
    const root = fixture();
    task(root, "20260801120000001-blocked", "blocked", { blockedBy: "none" });
    expect(run(root, "list").stderr).toContain("blocked task needs a specific Blocked by value");
  });
});
