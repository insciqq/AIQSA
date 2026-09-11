// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error The checked CLI is intentionally plain Node ESM.
import { imageIndexDigest, planImageReuse, publishedImageDigest, releaseMode } from "./release-plan.mjs";

const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
const postgresTag = "18.6-pgvector0.8.6";

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(root: string, name: string, value: string) {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), value);
}

function commit(root: string) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-qm", "fixture");
}

function fixture(tag = true) {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-release-plan-"));
  roots.push(root);
  git(root, "init", "-q");
  write(root, "ops/postgres-pgvector.Dockerfile", "FROM postgres:18\n");
  for (const component of ["docling", "tika", "opensearch"]) {
    write(root, `ops/${component}/Dockerfile`, "FROM scratch\n");
  }
  write(root, "app.ts", "initial application\n");
  commit(root);
  if (tag) git(root, "tag", "v0.2.0");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release channel selection", () => {
  it.each([
    ["tag", "v0.2.1-rc.1", true],
    ["tag", "v0.2.1", false],
    ["tag", "v0.2.1-beta.1", false],
    ["tag", "v0.2.1-rc.1-extra", false],
    ["tag", "v0.2.1-rc.01", false],
    ["branch", "v0.2.1-rc.1", false]
  ])("only numbered RC tags use the RC channel: %s %s", (type, ref, isRc) => {
    expect(releaseMode(type, ref, "0.2.1")).toEqual({
      version: type === "tag" ? ref.slice(1) : "0.2.1", is_rc: isRc
    });
  });

  it("rejects a candidate for a different package version", () => {
    expect(() => releaseMode("tag", "v0.2.2-rc.1", "0.2.1")).toThrow("does not match");
  });
});

describe("reuse of published infrastructure", () => {
  it("reuses all four images for an application-only fix, excluding the current and prerelease tags", async () => {
    const root = fixture();
    write(root, "app.ts", "fixed application\n");
    commit(root);
    git(root, "tag", "v0.2.1-rc.1");
    git(root, "tag", "v0.2.1");
    const resolve = vi.fn().mockResolvedValue(digest);
    const plan = await planImageReuse(root, "v0.2.1", postgresTag, resolve);
    expect(plan).toEqual({ base: "v0.2.0", reuse: { postgres: digest, docling: digest, tika: digest, opensearch: digest } });
    expect(resolve.mock.calls.map(([ref]) => ref)).toEqual([
      "ghcr.io/insciqq/aiqsa-postgres:18.6-pgvector0.8.6-0.2.0",
      "ghcr.io/insciqq/aiqsa:docling-0.2.0",
      "ghcr.io/insciqq/aiqsa:tika-0.2.0",
      "ghcr.io/insciqq/aiqsa:opensearch-0.2.0"
    ]);
  });

  it("rebuilds only the component whose context changed", async () => {
    const root = fixture();
    write(root, "ops/docling/model-checksums.txt", "updated model\n");
    commit(root);
    const resolve = vi.fn().mockResolvedValue(digest);
    expect((await planImageReuse(root, "v0.2.1-rc.1", postgresTag, resolve)).reuse)
      .toEqual({ postgres: digest, tika: digest, opensearch: digest });
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("compares the root context if Postgres starts copying application files", async () => {
    const root = fixture();
    write(root, "ops/postgres-pgvector.Dockerfile", "FROM postgres:18\nCOPY app.ts /opt/\n");
    commit(root);
    git(root, "tag", "v0.2.1");
    write(root, "app.ts", "changed root context\n");
    commit(root);
    expect((await planImageReuse(root, "v0.2.2-rc.1", postgresTag, async () => digest)).reuse)
      .toEqual({ docling: digest, tika: digest, opensearch: digest });
  });

  it("builds images when no stable ancestor exists", async () => {
    const resolve = vi.fn();
    expect(await planImageReuse(fixture(false), "v0.2.0-rc.1", postgresTag, resolve))
      .toEqual({ base: "", reuse: {} });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rebuilds an unpublished image but does not mask registry errors", async () => {
    const root = fixture();
    const resolve = vi.fn().mockResolvedValue(digest).mockResolvedValueOnce("");
    expect((await planImageReuse(root, "v0.2.1-rc.1", postgresTag, resolve)).reuse)
      .toEqual({ docling: digest, tika: digest, opensearch: digest });
    await expect(planImageReuse(root, "v0.2.1-rc.1", postgresTag, async () => { throw new Error("registry unavailable"); }))
      .rejects.toThrow("registry unavailable");
  });
});

describe("published manifest validation", () => {
  const index = JSON.stringify({ manifests: [
    { digest, platform: { os: "linux", architecture: "amd64" } },
    { digest, platform: { os: "linux", architecture: "arm64" } },
    { digest, platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } }
  ] });

  it("pins the full index, retaining attestations, and checks the registry digest", () => {
    const pinned = imageIndexDigest(index, null);
    expect(pinned).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(imageIndexDigest(index, pinned)).toBe(pinned);
    expect(() => imageIndexDigest(index, digest)).toThrow("digest mismatch");
    const withoutAttestations = JSON.stringify({ manifests: JSON.parse(index).manifests.slice(0, 2) });
    expect(imageIndexDigest(withoutAttestations, null)).not.toBe(pinned);
  });

  it("rejects images missing a supported architecture", () => {
    expect(() => imageIndexDigest(JSON.stringify({ manifests: JSON.parse(index).manifests.slice(0, 1) }), null))
      .toThrow("exactly linux/amd64 and linux/arm64");
  });

  it("resolves public images without installation credentials", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token: "synthetic-pull-token" }))
      .mockResolvedValueOnce(new Response(index));
    expect(await publishedImageDigest("ghcr.io/insciqq/aiqsa:docling-0.2.0", request))
      .toBe(imageIndexDigest(index, null));
    expect(request.mock.calls[1][0]).toBe("https://ghcr.io/v2/insciqq/aiqsa/manifests/docling-0.2.0");
  });

  it("treats only a missing manifest as a build fallback", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token: "synthetic-pull-token" }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await publishedImageDigest("ghcr.io/insciqq/aiqsa:tika-0.2.0", request)).toBe("");
    request.mockResolvedValueOnce(Response.json({ token: "synthetic-pull-token" }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(publishedImageDigest("ghcr.io/insciqq/aiqsa:tika-0.2.0", request)).rejects.toThrow("HTTP 503");
  });
});
