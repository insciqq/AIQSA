import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
    "/agent_docs/tasks/queue/*\n!/agent_docs/tasks/queue/README.md\n" +
      "/agent_docs/tasks/archive/*\n!/agent_docs/tasks/archive/README.md\n" +
      "/agent_docs/tasks/drafts/*\n!/agent_docs/tasks/drafts/README.md\n"
  );
  const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  return root;
}

type TaskOptions = {
  dependencies?: string;
  group?: string;
  plan?: string;
  rationale?: string;
  verification?: string;
};

function task(root: string, stem: string, status: string, options: TaskOptions = {}) {
  const directory = path.join(root, "agent_docs/tasks/queue", options.group ?? "");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `${stem}.md`),
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
  it("keeps named groups out of the default queue and requires explicit selection", () => {
    const root = fixture();
    const ordinary = "20260801120000001-ordinary";
    const grouped = "20260801120000002-grouped";
    task(root, ordinary, "ready");
    task(root, grouped, "ready", { group: "maintenance" });

    expect(run(root, "list").stdout).toContain(ordinary);
    expect(run(root, "list").stdout).not.toContain(grouped);
    expect(run(root, "list", "--group", "maintenance").stdout)
      .toContain(`ready       maintenance/${grouped}`);
    expect(run(root, "list", "--group", "maintenance").stdout).not.toContain(ordinary);
    expect(run(root, "list", "--all").stdout).toContain(`maintenance/${grouped}`);
    expect(run(root, "list", "--all", "--group", "maintenance").status).toBe(1);
    expect(run(root, "start", grouped).status).toBe(1);
    expect(run(root, "start", grouped, "--group", "maintenance").status).toBe(0);
    expect(run(root, "block", grouped, "--group", "maintenance", "--reason", "Fixture service unavailable").status).toBe(0);
    expect(run(root, "check").status).toBe(0);
  });

  it("creates private grouped scaffolds and refuses an insufficient flat ignore rule", () => {
    const root = fixture();
    const created = run(root, "new", "next-task", "--summary", "Grouped slice", "--group", "maintenance");
    expect(created.status).toBe(0);
    const directory = path.join(root, "agent_docs/tasks/queue/maintenance");
    const [filename] = readdirSync(directory);
    expect(filename).toMatch(/^\d{17}-next-task\.md$/);
    expect(readFileSync(path.join(directory, filename!), "utf8")).toContain("Status: backlog");
    expect(run(root, "list").stdout).toBe("No open tasks.\n");

    const unsafeRoot = fixture();
    writeFileSync(path.join(unsafeRoot, ".gitignore"), "/agent_docs/tasks/queue/*.md\n");
    const refused = run(unsafeRoot, "new", "next-task", "--summary", "Grouped slice", "--group", "maintenance");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("must be ignored before local task creation");
    expect(existsSync(path.join(unsafeRoot, "agent_docs/tasks/queue/maintenance"))).toBe(false);
  });

  it("preserves groups through archive and drafts while resolving dependencies across groups", () => {
    const root = fixture();
    const foundation = "20260801120000001-foundation";
    const dependent = "20260801120000002-dependent";
    const ordinary = "20260801120000003-ordinary";
    task(root, foundation, "backlog", { group: "maintenance" });
    task(root, dependent, "backlog", { group: "maintenance", dependencies: foundation });
    task(root, ordinary, "backlog", { dependencies: foundation });
    expect(run(root, "promote", dependent, "--group", "maintenance").status).toBe(1);
    expect(run(root, "park", foundation, "--group", "maintenance").status).toBe(1);
    expect(run(root, "promote", foundation, "--group", "maintenance").status).toBe(0);
    expect(run(root, "start", foundation, "--group", "maintenance").status).toBe(0);
    expect(run(root, "complete", foundation, "--group", "maintenance").status).toBe(0);
    expect(readFileSync(path.join(root, "agent_docs/tasks/archive/maintenance", `${foundation}.md`), "utf8"))
      .toContain("Status: completed");
    for (const filename of [`maintenance/${dependent}.md`, `${ordinary}.md`]) {
      expect(readFileSync(path.join(root, "agent_docs/tasks/queue", filename), "utf8"))
        .toContain("Depends on: none");
    }
    expect(run(root, "park", dependent, "--group", "maintenance").status).toBe(0);
    expect(existsSync(path.join(root, "agent_docs/tasks/drafts/maintenance", `${dependent}.md`))).toBe(true);
    expect(run(root, "restore", dependent).status).toBe(1);
    expect(run(root, "restore", dependent, "--group", "maintenance").status).toBe(0);
    expect(run(root, "check").status).toBe(0);
  });

  it("validates every group and rejects traversal, nested groups and symlinks", () => {
    const root = fixture();
    expect(run(root, "new", "escape", "--summary", "Escape", "--group", "../outside").status).toBe(1);
    expect(run(root, "list", "--group", "maintenance/nested").status).toBe(1);
    const directory = path.join(root, "agent_docs/tasks/queue/maintenance");
    mkdirSync(path.join(directory, "nested"), { recursive: true });
    expect(run(root, "check").stderr).toContain("maintenance/nested");
    rmSync(path.join(directory, "nested"), { recursive: true });
    const target = path.join(root, "outside");
    mkdirSync(target);
    symlinkSync(target, path.join(directory, "linked"));
    expect(run(root, "check").stderr).toContain("maintenance/linked");
    unlinkSync(path.join(directory, "linked"));
    writeFileSync(path.join(directory, "bad.md"), "Malformed private task\n");
    expect(run(root, "list").status).toBe(1);
    expect(run(root, "check").stderr).toContain("maintenance/bad.md");
    unlinkSync(path.join(directory, "bad.md"));
    const stem = "20260801120000001-parked";
    task(root, stem, "backlog", { group: "maintenance" });
    symlinkSync(target, path.join(root, "agent_docs/tasks/drafts/maintenance"));
    expect(run(root, "park", stem, "--group", "maintenance").stderr).toContain("not a file or symlink");
    expect(existsSync(path.join(directory, `${stem}.md`))).toBe(true);
    expect(readdirSync(target)).toEqual([]);
  });

  it("keeps task identifiers globally unique across named queues and their archives", () => {
    const root = fixture();
    task(root, "20260801120000001-ordinary", "backlog");
    task(root, "20260801120000001-grouped", "backlog", { group: "maintenance" });
    expect(run(root, "check").stderr).toContain("duplicate task id");
    rmSync(path.join(root, "agent_docs/tasks/queue/20260801120000001-ordinary.md"));
    const directory = path.join(root, "agent_docs/tasks/archive/older");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "20260801120000001-prior.md"), "Status: completed\n");
    expect(run(root, "check").stderr).toContain("task id exists in both the open queue and completion archive");
  });

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
