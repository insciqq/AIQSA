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
  for (const directory of ["queue", "archive", "drafts"]) {
    mkdirSync(path.join(root, `agent_docs/tasks/${directory}`), { recursive: true });
    writeFileSync(path.join(root, `agent_docs/tasks/${directory}/README.md`), `# ${directory}\n`);
  }
  writeFileSync(path.join(root, "agent_docs/tasks/README.md"), "# TASKS\n");
  writeFileSync(
    path.join(root, ".gitignore"),
    "/agent_docs/tasks/queue/*.md\n!/agent_docs/tasks/queue/README.md\n" +
      "/agent_docs/tasks/archive/*\n!/agent_docs/tasks/archive/README.md\n" +
      "/agent_docs/tasks/drafts/*\n!/agent_docs/tasks/drafts/README.md\n" +
      "/agent_docs/PRD/**\n/DEV_SERVER.md\n"
  );
  writeFileSync(
    path.join(root, ".dockerignore"),
    "agent_docs\nDEV_SERVER.md\n**/AGENTS.md\n**/CLAUDE.md\n!.env.example\n"
  );
  writeFileSync(path.join(root, "README.md"), "# Public source\n");
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", "https://github.com/insciqq/AIQSA.git");
  commit(root, "initial public tree");
  return root;
}

function run(root: string, historySince: string, ...arguments_: string[]) {
  return spawnSync(
    process.execPath,
    [cli, "--history-since", historySince, "--ref", "HEAD", ...arguments_],
    { cwd: root, encoding: "utf8" }
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release privacy command", () => {
  it("accepts a clean public tree and official origin", () => {
    const root = fixture();
    const baseline = git(root, "rev-parse", "HEAD").stdout.trim();

    const result = run(root, baseline, "--require-origin");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release privacy check passed");
  });

  it("rejects a private task in both the current tree and later history", () => {
    const root = fixture();
    const baseline = git(root, "rev-parse", "HEAD").stdout.trim();
    const relative = "agent_docs/tasks/archive/20260801120000001-private-task.md";
    writeFileSync(path.join(root, relative), "private task\n");
    git(root, "add", "-f", relative);
    git(root, "-c", "user.name=AIQSA Test", "-c", "user.email=test@aiqsa.local", "commit", "-q", "-m", "unsafe task");

    const present = run(root, baseline);
    expect(present.status).toBe(1);
    expect(present.stderr).toContain(`release tree contains private task artifact ${relative}`);

    rmSync(path.join(root, relative));
    commit(root, "remove unsafe task");
    const deleted = run(root, baseline);
    expect(deleted.status).toBe(1);
    expect(deleted.stderr).toContain(`post-baseline history contains private task artifact ${relative}`);
  });

  it("rejects Docker negations that can re-include protected agent content", () => {
    const root = fixture();
    const baseline = git(root, "rev-parse", "HEAD").stdout.trim();
    writeFileSync(
      path.join(root, ".dockerignore"),
      "agent_docs\n**/AGENTS.md\n**/CLAUDE.md\n!agent_docs/private-note.md\n"
    );

    const result = run(root, baseline);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("later negation !agent_docs/private-note.md");
  });

  it("rejects a non-public origin when publication validation is requested", () => {
    const root = fixture();
    const baseline = git(root, "rev-parse", "HEAD").stdout.trim();
    git(root, "remote", "set-url", "origin", "https://example.invalid/wrong.git");

    const result = run(root, baseline, "--require-origin");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "origin fetch URL is not the public AIQSA GitHub repository"
    );
  });

  it("keeps local server instructions private even after forced staging or later deletion", () => {
    const root = fixture();
    const baseline = git(root, "rev-parse", "HEAD").stdout.trim();
    writeFileSync(path.join(root, "DEV_SERVER.md"), "# Synthetic private server\n");
    expect(git(root, "check-ignore", "DEV_SERVER.md").status).toBe(0);
    expect(run(root, baseline).status).toBe(0);

    git(root, "add", "-f", "DEV_SERVER.md");
    expect(run(root, baseline).stderr).toContain("DEV_SERVER.md: public Git tracks a private task artifact");
    commit(root, "unsafe server instructions");
    expect(run(root, baseline).stderr).toContain("release tree contains private task artifact DEV_SERVER.md");
    rmSync(path.join(root, "DEV_SERVER.md"));
    commit(root, "remove unsafe server instructions");
    expect(run(root, baseline).stderr).toContain("post-baseline history contains private task artifact DEV_SERVER.md");
  });

  it.each(["missing", "negated"])("rejects %s Docker protection for local server instructions", (mode) => {
    const root = fixture();
    const baseline = git(root, "rev-parse", "HEAD").stdout.trim();
    writeFileSync(path.join(root, ".dockerignore"),
      "agent_docs\n**/AGENTS.md\n**/CLAUDE.md\n" + (mode === "negated" ? "DEV_SERVER.md\n!DEV_SERVER.md\n" : ""));
    const result = run(root, baseline);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(mode === "missing"
      ? "missing agent-only exclusion DEV_SERVER.md"
      : "later negation !DEV_SERVER.md may re-include protected DEV_SERVER.md");
  });
});
