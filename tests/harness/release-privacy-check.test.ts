import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve(process.cwd(), "scripts/release-privacy-check.mjs");
const roots: string[] = [];

function git(root: string, ...arguments_: string[]) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result;
}

function commit(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=AIQSA Test", "-c", "user.email=test@aiqsa.local", "commit", "-q", "-m", message);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-release-privacy-"));
  roots.push(root);
  mkdirSync(path.join(root, "agent_docs/tasks"), { recursive: true });
  writeFileSync(path.join(root, "agent_docs/tasks/README.md"), "# TASKS\n");
  writeFileSync(
    path.join(root, ".gitignore"),
    "/agent_docs/tasks/*.md\n!/agent_docs/tasks/README.md\n"
  );
  writeFileSync(path.join(root, ".dockerignore"), "agent_docs\n**/AGENTS.md\n**/CLAUDE.md\n");
  writeFileSync(path.join(root, "README.md"), "# Public source\n");
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", "https://github.com/insciqq/AIQSA.git");
  commit(root, "initial public tree");
  return root;
}

function run(root: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [cli, ...arguments_], { cwd: root, encoding: "utf8" });
}

function head(root: string) {
  return git(root, "rev-parse", "HEAD").stdout.trim();
}

function runSince(root: string, historySince: string, ...arguments_: string[]) {
  return run(root, "--history-since", historySince, ...arguments_);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release privacy check", () => {
  it("accepts a GitHub-only post-baseline history with only the task README", () => {
    const root = fixture();
    const historySince = head(root);

    const result = runSince(root, historySince, "--ref", "HEAD", "--require-origin");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release privacy check passed");
  });

  it("accepts task artifacts that precede the explicit public-history baseline", () => {
    const root = fixture();
    const relative = "agent_docs/done_tasks/123-grandfathered-task.md";
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), "already public historical task\n");
    commit(root, "historical task");
    rmSync(path.join(root, "agent_docs/done_tasks"), { recursive: true });
    commit(root, "remove historical task from current tree");
    const historySince = head(root);
    writeFileSync(path.join(root, "README.md"), "# Public source\n\nSafe follow-up.\n");
    commit(root, "post-policy change");

    const result = runSince(root, historySince, "--ref", "HEAD");

    expect(result.status).toBe(0);
  });

  it("finds a post-baseline task that was committed and later deleted", () => {
    const root = fixture();
    const historySince = head(root);
    const relative = "agent_docs/tasks/20260801120000001-private-plan.md";
    writeFileSync(path.join(root, relative), "private task\n");
    git(root, "add", "-f", relative);
    git(root, "-c", "user.name=AIQSA Test", "-c", "user.email=test@aiqsa.local", "commit", "-q", "-m", "unsafe task");
    rmSync(path.join(root, relative));
    commit(root, "delete unsafe task");

    const result = runSince(root, historySince, "--ref", "HEAD");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`post-baseline history contains private task artifact ${relative}`);
  });

  it("finds legacy task directories added after the baseline", () => {
    const root = fixture();
    const historySince = head(root);
    const relative = "agent_docs/done_tasks/123-old-task.md";
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), "old task\n");
    commit(root, "unsafe legacy task");

    const result = runSince(root, historySince, "--ref", "HEAD");

    expect(result.stderr).toContain(`release tree contains private task artifact ${relative}`);
    expect(result.stderr).toContain(`post-baseline history contains private task artifact ${relative}`);
  });

  it("requires agent-only Docker exclusions", () => {
    const root = fixture();
    const historySince = head(root);
    writeFileSync(path.join(root, ".dockerignore"), "node_modules\n");

    const result = runSince(root, historySince);

    expect(result.stderr).toContain("missing agent-only exclusion agent_docs");
    expect(result.stderr).toContain("missing agent-only exclusion **/AGENTS.md");
  });

  it("requires exactly one public GitHub origin when requested", () => {
    const root = fixture();
    const historySince = head(root);
    git(root, "remote", "add", "legacy", "https://example.invalid/private.git");

    expect(runSince(root, historySince, "--require-origin").stderr).toContain("exactly one remote named origin");
  });
});
