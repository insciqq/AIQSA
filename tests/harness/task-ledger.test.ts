import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(process.cwd(), "scripts/task-ledger.mjs");
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-task-ledger-"));
  roots.push(root);
  mkdirSync(path.join(root, "agent_docs/tasks"), { recursive: true });
  writeFileSync(path.join(root, "agent_docs/tasks/README.md"), "# TASKS\n");
  writeFileSync(path.join(root, "agent_docs/SECURITY.md"), "# SECURITY\n");
  writeFileSync(
    path.join(root, ".gitignore"),
    "/agent_docs/tasks/*.md\n!/agent_docs/tasks/README.md\n"
  );
  const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  return root;
}

type TaskOptions = {
  blockedBy?: string;
  decisions?: string;
  dependencies?: string;
  humanReview?: "optional" | "required";
  plan?: string;
  progress?: string;
  rationale?: string;
  verification?: string;
};

function task(root: string, stem: string, status: string, options: TaskOptions = {}) {
  const body = `# ${stem}

Status: ${status}
Depends on: ${options.dependencies ?? "none"}
Human review: ${options.humanReview ?? "optional"}
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
  writeFileSync(path.join(root, "agent_docs/tasks", `${stem}.md`), body, "utf8");
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
    const filename = readdirSync(path.join(root, "agent_docs/tasks")).find((entry) => entry !== "README.md");
    expect(filename).toMatch(/^\d{17}-next-task\.md$/);
    const body = readFileSync(path.join(root, "agent_docs/tasks", filename!), "utf8");
    expect(body).toContain("Status: backlog");
    expect(body).toContain("Durable rationale: pending");
    expect(spawnSync("git", ["check-ignore", "-q", `agent_docs/tasks/${filename}`], { cwd: root }).status).toBe(0);
  });

  it("refuses local task creation when the public-repository ignore guard is absent", () => {
    const root = fixture();
    unlinkSync(path.join(root, ".gitignore"));

    const result = run(root, "new", "unsafe-task", "--summary", "Must stay local");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be ignored before local task creation");
    expect(readdirSync(path.join(root, "agent_docs/tasks"))).toEqual(["README.md"]);
  });

  it("completes by deleting the task and clearing remaining dependencies", () => {
    const root = fixture();
    const foundation = "20260801120000001-foundation";
    const followup = "20260801120000002-follow-up";
    task(root, foundation, "in_progress");
    task(root, followup, "backlog", { dependencies: foundation });

    const result = run(root, "complete", foundation);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(root, "agent_docs/tasks", `${foundation}.md`))).toBe(false);
    expect(readFileSync(path.join(root, "agent_docs/tasks", `${followup}.md`), "utf8")).toContain("Depends on: none");
    expect(result.stdout).toContain("cleared 1 dependency reference");
  });

  it("enforces one in_progress task and dependency-free executable states", () => {
    const root = fixture();
    task(root, "20260801120000001-first", "in_progress");
    task(root, "20260801120000002-second", "in_progress");

    const duplicate = run(root, "list");
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("only one integrating task is allowed");

    rmSync(path.join(root, "agent_docs/tasks/20260801120000002-second.md"));
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

  it("requires review status and explicit approval for required human review", () => {
    const root = fixture();
    const stem = "20260801120000001-reviewed-change";
    task(root, stem, "in_progress", { humanReview: "required" });

    expect(run(root, "complete", stem).stderr).toContain("requires human review before completion");
    expect(run(root, "review", stem).status).toBe(0);
    expect(run(root, "complete", stem).stderr).toContain("requires explicit operator approval");
    expect(run(root, "complete", stem, "--approved").status).toBe(0);
  });

  it("allows checked plus unavailable evidence but reviews unavailable-only evidence", () => {
    const root = fixture();
    const mixed = "20260801120000001-mixed-evidence";
    task(root, mixed, "in_progress", {
      verification: "- [x] deterministic check passed.\n- Not run: provider smoke — credentials are unavailable"
    });
    expect(run(root, "complete", mixed).status).toBe(0);

    const optional = "20260801120000002-optional-unavailable";
    task(root, optional, "in_progress", {
      verification: "- Not run: provider smoke — credentials are unavailable"
    });
    const rejected = run(root, "complete", optional);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Unavailable-only verification requires required human review");

    rmSync(path.join(root, "agent_docs/tasks", `${optional}.md`));
    const required = "20260801120000003-required-unavailable";
    task(root, required, "in_progress", {
      humanReview: "required",
      verification: "- Not run: provider smoke — credentials are unavailable"
    });
    expect(run(root, "review", required).status).toBe(0);
    expect(run(root, "complete", required, "--approved").status).toBe(0);
  });

  it("blocks unchecked or malformed verification evidence", () => {
    const root = fixture();
    const unchecked = "20260801120000001-unchecked";
    task(root, unchecked, "in_progress", { verification: "- [ ] npm run check:hermetic" });
    expect(run(root, "complete", unchecked).stderr).toContain("no unchecked checks");

    rmSync(path.join(root, "agent_docs/tasks", `${unchecked}.md`));
    const malformed = "20260801120000002-malformed";
    task(root, malformed, "in_progress", { verification: "- Not run: provider smoke" });
    expect(run(root, "list").stderr).toContain("Not run: <check> — <specific reason>");
  });

  it.each([
    ["an unchecked Plan item", { plan: "- [ ] Finish the fixture milestone." }, "## Plan has 1 unchecked milestone"],
    ["the untouched Progress scaffold", { progress: "- Not started." }, "## Progress must replace the scaffold value"],
    ["the untouched Decisions scaffold", { decisions: "- None yet." }, "## Decisions must replace the scaffold value"]
  ])("rejects %s before completion and review", (_label, override, expected) => {
    const root = fixture();
    const optional = "20260801120000001-optional-readiness";
    task(root, optional, "in_progress", override);

    const completion = run(root, "complete", optional);
    expect(completion.status).toBe(1);
    expect(completion.stderr).toContain(expected);

    rmSync(path.join(root, "agent_docs/tasks", `${optional}.md`));
    const required = "20260801120000002-required-readiness";
    task(root, required, "in_progress", { ...override, humanReview: "required" });

    const review = run(root, "review", required);
    expect(review.status).toBe(1);
    expect(review.stderr).toContain(expected);

    const body = readFileSync(path.join(root, "agent_docs/tasks", `${required}.md`), "utf8");
    writeFileSync(
      path.join(root, "agent_docs/tasks", `${required}.md`),
      body.replace("Status: in_progress", "Status: review"),
      "utf8"
    );
    expect(run(root, "list").stderr).toContain(expected);
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

    rmSync(path.join(root, "agent_docs/tasks", `${pending}.md`));
    const moved = "20260801120000002-moved-rationale";
    task(root, moved, "in_progress", { rationale: "moved to agent_docs/SECURITY.md" });
    expect(run(root, "complete", moved).status).toBe(0);

    const invalid = "20260801120000003-invalid-rationale";
    task(root, invalid, "backlog", { rationale: "moved to README.md" });
    expect(run(root, "list").stderr).toContain("owner must be an existing file outside agent_docs/tasks");
  });

  it("requires a concrete blocker only for blocked state", () => {
    const root = fixture();
    task(root, "20260801120000001-blocked", "blocked", { blockedBy: "none" });
    expect(run(root, "list").stderr).toContain("blocked task needs a specific Blocked by value");
  });
});
