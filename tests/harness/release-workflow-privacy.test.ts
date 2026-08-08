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

  it("publishes the pgvector Postgres image with separate verified multi-platform digests", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    const postgresDockerfile = readFileSync(
      path.join(root, "ops/postgres-pgvector.Dockerfile"),
      "utf8"
    );

    expect(workflow).toContain("POSTGRES_IMAGE: ghcr.io/insciqq/aiqsa-postgres");
    expect(workflow).toContain("POSTGRES_COMPONENT_TAG: 16.14-pgvector0.8.5");
    expect(workflow).toContain("file: ops/postgres-pgvector.Dockerfile");
    expect(workflow).toContain("name: postgres-digests-${{ matrix.id }}");
    expect(workflow).toContain("pattern: postgres-digests-*");
    expect(workflow).toContain("${POSTGRES_IMAGE}:${POSTGRES_COMPONENT_TAG}-${VERSION}");
    expect(workflow).toContain("Immutable Postgres digest: ${POSTGRES_IMAGE}@${POSTGRES_DIGEST}");
    expect(workflow).toContain(
      "Published Postgres manifest platforms are not exactly linux/amd64 and linux/arm64."
    );

    expect(postgresDockerfile).toContain(
      "postgres:16.14-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"
    );
    expect(postgresDockerfile).toContain("ARG PGVECTOR_VERSION=0.8.5");
    expect(postgresDockerfile).toContain(
      "ARG PGVECTOR_SOURCE_SHA256=6f88a5cbdde31666f4b6c1a6b75c51dcbeffe58f9a7d2b26e502d5a6e5e14d44"
    );
    expect(postgresDockerfile).toContain('echo "${PGVECTOR_SOURCE_SHA256}  pgvector.tar.gz" | sha256sum -c -');
    expect(postgresDockerfile).toContain('make -C "pgvector-${PGVECTOR_VERSION}" OPTFLAGS=""');
    expect(postgresDockerfile.match(/^FROM /gmu)).toHaveLength(2);
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
