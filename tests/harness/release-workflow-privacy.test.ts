import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

describe("public release privacy contract", () => {
  it("checks complete tag ancestry before the Docker publication step", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    const privacy = workflow.indexOf("node scripts/release-privacy-check.mjs --ref HEAD --require-origin");
    const build = workflow.indexOf("docker/build-push-action@");

    expect(workflow).toContain("fetch-depth: 0");
    expect(privacy).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(privacy);
    expect(workflow).toContain("context: .");
    expect(workflow).toContain("target: release");
  });

  it("keeps agent-only files out of every Docker stage context", () => {
    const dockerignore = readFileSync(path.join(root, ".dockerignore"), "utf8");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");

    expect(dockerignore).toMatch(/^agent_docs$/mu);
    expect(dockerignore).toMatch(/^\*\*\/AGENTS\.md$/mu);
    expect(dockerignore).toMatch(/^\*\*\/CLAUDE\.md$/mu);
    expect(dockerfile).toContain("COPY --chown=node:node . .");
  });

  it("exposes the repository privacy check as an explicit package command", () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.scripts["release:privacy:check"]).toBe(
      "node scripts/release-privacy-check.mjs --require-origin"
    );
  });
});
