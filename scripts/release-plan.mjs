#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stableTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const rcTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.(?:0|[1-9]\d*)$/u;

export function releaseMode(refType, refName, packageVersion) {
  if (refType !== "tag") return { version: packageVersion, is_rc: false };
  const version = refName.replace(/^v/u, "");
  if (version !== packageVersion && !version.startsWith(`${packageVersion}-`)) {
    throw new Error(`Tag ${refName} does not match package version ${packageVersion}.`);
  }
  return { version, is_rc: rcTag.test(refName) };
}

function git(root, args, allowedStatuses = [0]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (!allowedStatuses.includes(result.status)) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result;
}

// Keep the entire index, including provenance attestations, when reusing an image.
export function imageIndexDigest(body, registryDigest) {
  const index = JSON.parse(body);
  const platforms = (index.manifests ?? [])
    .filter(({ platform }) => platform?.os !== "unknown")
    .map(({ platform }) => `${platform?.os}/${platform?.architecture}`)
    .sort();
  if (platforms.join(",") !== "linux/amd64,linux/arm64") {
    throw new Error("Reusable image must contain exactly linux/amd64 and linux/arm64.");
  }
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (registryDigest && registryDigest !== digest) throw new Error("Registry image digest mismatch.");
  return digest;
}

export async function publishedImageDigest(reference, fetchImage = fetch) {
  const match = /^ghcr\.io\/(insciqq\/aiqsa(?:-postgres)?):([\w.-]+)$/u.exec(reference);
  if (!match) throw new Error("Unexpected component image repository.");
  const [, repository, tag] = match;
  const tokenResponse = await fetchImage(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!tokenResponse.ok) throw new Error(`Registry authorization failed: HTTP ${tokenResponse.status}.`);
  const { token } = await tokenResponse.json();
  if (typeof token !== "string" || !token) throw new Error("Registry returned no pull token.");
  const response = await fetchImage(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"
    },
    signal: AbortSignal.timeout(30_000)
  });
  // A tag without published images (including the first release) needs a build.
  if (response.status === 404) return "";
  if (!response.ok) throw new Error(`Registry image lookup failed: HTTP ${response.status}.`);
  return imageIndexDigest(await response.text(), response.headers.get("docker-content-digest"));
}

export async function planImageReuse(root, currentTag, postgresTag, resolveDigest = publishedImageDigest) {
  const base = git(root, ["tag", "--merged", "HEAD", "--sort=-version:refname"]).stdout.trim()
    .split("\n").find((tag) => tag !== currentTag && stableTag.test(tag));
  const reuse = {};
  if (!base) return { base: "", reuse };

  // These are the actual build contexts; Postgres currently has no COPY/ADD.
  // If it starts consuming the root context, conservatively compare all of it.
  const postgresFile = "ops/postgres-pgvector.Dockerfile";
  const postgresCopiesContext = /^\s*(?:COPY|ADD)\s/imu.test(readFileSync(path.join(root, postgresFile), "utf8"));
  const inputs = {
    postgres: postgresCopiesContext ? ["."] : [postgresFile, `${postgresFile}.dockerignore`, ".dockerignore"],
    docling: ["ops/docling"],
    tika: ["ops/tika"],
    opensearch: ["ops/opensearch"]
  };
  for (const [component, paths] of Object.entries(inputs)) {
    if (git(root, ["diff", "--quiet", base, "HEAD", "--", ...paths], [0, 1]).status !== 0) continue;
    const reference = component === "postgres"
      ? `ghcr.io/insciqq/aiqsa-postgres:${postgresTag}-${base.slice(1)}`
      : `ghcr.io/insciqq/aiqsa:${component}-${base.slice(1)}`;
    const digest = await resolveDigest(reference);
    if (digest) reuse[component] = digest;
  }
  return { base, reuse };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_OUTPUT, POSTGRES_COMPONENT_TAG } = process.env;
    if (!GITHUB_REF_TYPE || !GITHUB_REF_NAME || !POSTGRES_COMPONENT_TAG) throw new Error("Missing release context.");
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    const mode = releaseMode(GITHUB_REF_TYPE, GITHUB_REF_NAME, version);
    const images = await planImageReuse(process.cwd(), GITHUB_REF_TYPE === "tag" ? GITHUB_REF_NAME : "", POSTGRES_COMPONENT_TAG);
    const plan = { ...mode, ...images };
    if (GITHUB_OUTPUT) {
      appendFileSync(GITHUB_OUTPUT, Object.entries(plan)
        .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}\n`).join(""));
    }
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(`release-plan: ${error.message}`);
    process.exitCode = 1;
  }
}
