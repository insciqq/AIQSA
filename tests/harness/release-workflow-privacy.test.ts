import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

describe("public release privacy contract", () => {
  it("keeps the historical privacy baseline in executable policy rather than living contracts", () => {
    const privacyScript = readFileSync(path.join(root, "scripts/release-privacy-check.mjs"), "utf8");
    const securityContract = readFileSync(path.join(root, "agent_docs/SECURITY.md"), "utf8");

    expect(privacyScript).toContain(
      'const DEFAULT_HISTORY_BASE = "233b7494c00adde46c12e9d49f29676bf52c0f6a"'
    );
    expect(securityContract).not.toContain("233b7494c00adde46c12e9d49f29676bf52c0f6a");
  });

  it("checks the release tree and post-policy ancestry before the Docker publication step", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    const privacy = workflow.indexOf("node scripts/release-privacy-check.mjs --ref HEAD --require-origin");
    const build = workflow.indexOf("docker/build-push-action@");

    expect(workflow).toContain("fetch-depth: 0");
    expect(privacy).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(privacy);
    expect(workflow).toContain("context: .");
    expect(workflow).toContain("target: release");
  });

  it("builds both release architectures on native runners before publishing one manifest", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("platform: linux/amd64\n            runner: ubuntu-24.04");
    expect(workflow).toContain("platform: linux/arm64\n            runner: ubuntu-24.04-arm");
    expect(workflow).toContain("runs-on: ${{ matrix.runner }}");
    expect(workflow).not.toContain("docker/setup-qemu-action@");
    expect(workflow).toContain("push-by-digest=true,name-canonical=true,push=true");
    expect(workflow).toContain("pattern: digests-*");
    expect(workflow).toContain("docker buildx imagetools create");
    expect(workflow).toContain("expected_platforms=(linux/amd64 linux/arm64)");
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
