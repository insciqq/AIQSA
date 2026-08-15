import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(process.cwd(), "scripts/task-ledger.mjs");
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-task-ledger-"));
  roots.push(root);
  for (const directory of ["queue", "archive", "drafts"]) {
    mkdirSync(path.join(root, `agent_docs/tasks/${directory}`), { recursive: true });
    writeFileSync(path.join(root, `agent_docs/tasks/${directory}/README.md`), `# ${directory}\n`);
  }
  writeFileSync(path.join(root, "agent_docs/tasks/README.md"), "# TASKS\n");
  writeFileSync(path.join(root, "agent_docs/SECURITY.md"), "# SECURITY\n");
  writeFileSync(
    path.join(root, ".gitignore"),
    "/agent_docs/tasks/queue/*.md\n!/agent_docs/tasks/queue/README.md\n" +
      "/agent_docs/tasks/archive/*\n!/agent_docs/tasks/archive/README.md\n" +
      "/agent_docs/tasks/drafts/*\n!/agent_docs/tasks/drafts/README.md\n"
  );
  const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  return root;
}

type TaskOptions = {
  dependencies?: string;
  plan?: string;
  rationale?: string;
  verification?: string;
};

function task(root: string, stem: string, status: string, options: TaskOptions = {}) {
  writeFileSync(
    path.join(root, "agent_docs/tasks/queue", `${stem}.md`),
    `# ${stem}

Status: ${status}
Depends on: ${options.dependencies ?? "none"}
Blocked by: none
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

- Fixture implementation recorded.

## Decisions

- No lasting decision.

## Verification

${options.verification ?? "- [x] focused fixture check passed."}
`,
    "utf8"
  );
}

function archivedTask(root: string, stem: string) {
  writeFileSync(
    path.join(root, "agent_docs/tasks/archive", `${stem}.md`),
    `# ${stem}\n\nStatus: completed\n`,
    "utf8"
  );
}

function run(root: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [cli, ...arguments_, "--root", root], {
    encoding: "utf8"
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("local task ledger command", () => {
  it("creates ignored local tasks and fails closed without the ignore guard", () => {
    const root = fixture();
    expect(run(root, "check").stdout).toContain("Task ledger is valid");
    const created = run(root, "new", "next-task", "--summary", "Next slice");

    expect(created.status).toBe(0);
    const filename = readdirSync(path.join(root, "agent_docs/tasks/queue"))
      .find((entry) => entry !== "README.md");
    expect(filename).toMatch(/^\d{17}-next-task\.md$/);
    expect(readFileSync(path.join(root, "agent_docs/tasks/queue", filename!), "utf8"))
      .toContain("Status: backlog");
    expect(
      spawnSync("git", ["check-ignore", "-q", `agent_docs/tasks/queue/${filename}`], {
        cwd: root
      }).status
    ).toBe(0);

    const unsafeRoot = fixture();
    unlinkSync(path.join(unsafeRoot, ".gitignore"));
    const unsafe = run(unsafeRoot, "new", "unsafe-task", "--summary", "Must stay local");
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toContain("must be ignored before local task creation");
  });

  it("promotes and starts only dependency-free ready work", () => {
    const root = fixture();
    const foundation = "20260801120000001-foundation";
    const dependent = "20260801120000002-dependent";
    task(root, foundation, "backlog");
    task(root, dependent, "backlog", { dependencies: foundation });

    const blocked = run(root, "promote", dependent);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain(`open dependencies: ${foundation}`);

    expect(run(root, "promote", foundation).status).toBe(0);
    expect(run(root, "start", foundation).status).toBe(0);
    expect(readFileSync(
      path.join(root, "agent_docs/tasks/queue", `${foundation}.md`),
      "utf8"
    )).toContain("Status: in_progress");
  });

  it("parks and restores dependent work only in dependency order", () => {
    const root = fixture();
    const foundation = "20260801120000001-foundation";
    const dependent = "20260801120000002-dependent";
    task(root, foundation, "backlog");
    task(root, dependent, "backlog", { dependencies: foundation });

    expect(run(root, "park", dependent).status).toBe(0);
    expect(run(root, "park", foundation).status).toBe(0);
    const premature = run(root, "restore", dependent);
    expect(premature.status).toBe(1);
    expect(existsSync(path.join(root, "agent_docs/tasks/drafts", `${dependent}.md`)))
      .toBe(true);

    expect(run(root, "restore", foundation).status).toBe(0);
    expect(run(root, "restore", dependent).status).toBe(0);
    expect(run(root, "list").stdout).toContain(`backlog     ${dependent}`);
  });

  it("completes by archiving the task and clearing remaining dependencies", () => {
    const root = fixture();
    const foundation = "20260801120000001-foundation";
    const followup = "20260801120000002-follow-up";
    const prior = "20260701120000001-prior";
    archivedTask(root, prior);
    task(root, foundation, "in_progress");
    task(root, followup, "backlog", { dependencies: foundation });

    const result = run(root, "complete", foundation);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(root, "agent_docs/tasks/queue", `${foundation}.md`)))
      .toBe(false);
    expect(readFileSync(
      path.join(root, "agent_docs/tasks/archive", `${foundation}.md`),
      "utf8"
    )).toContain("Status: completed");
    expect(readFileSync(
      path.join(root, "agent_docs/tasks/queue", `${followup}.md`),
      "utf8"
    )).toContain("Depends on: none");
    expect(existsSync(path.join(root, "agent_docs/tasks/archive", `${prior}.md`))).toBe(true);
  });

  it("fails explicit validation for malformed tasks and unresolved dependencies", () => {
    const root = fixture();
    const malformed = path.join(root, "agent_docs/tasks/queue/not-a-task.md");
    writeFileSync(malformed, "malformed\n");
    const malformedResult = run(root, "check");
    expect(malformedResult.status).toBe(1);
    expect(malformedResult.stderr).toContain("task filenames must be");
    rmSync(malformed);

    task(root, "20260801120000001-first", "backlog", {
      dependencies: "20260801120000002-second"
    });

    const result = run(root, "check");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not resolve to exactly one open task");
  });

  it("requires finished work and positive verification before completion", () => {
    const root = fixture();
    const unchecked = "20260801120000001-unchecked";
    task(root, unchecked, "in_progress", { plan: "- [ ] Finish the fixture." });
    expect(run(root, "complete", unchecked).stderr)
      .toContain("## Plan has 1 unchecked milestone");
    rmSync(path.join(root, "agent_docs/tasks/queue", `${unchecked}.md`));

    const unavailable = "20260801120000002-unavailable";
    task(root, unavailable, "in_progress", {
      verification: "- Not run: provider smoke — credentials are unavailable"
    });
    expect(run(root, "complete", unavailable).stderr)
      .toContain("Unavailable-only verification cannot complete a task");
    rmSync(path.join(root, "agent_docs/tasks/queue", `${unavailable}.md`));

    const mixed = "20260801120000003-mixed";
    task(root, mixed, "in_progress", {
      verification:
        "- [x] deterministic check passed.\n" +
        "- Not run: provider smoke — credentials are unavailable"
    });
    expect(run(root, "complete", mixed).status).toBe(0);
  });
});
