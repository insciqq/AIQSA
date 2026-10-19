// Builds the AIQSA Connect client for every supported target into
// connect/dist/ with a SHA256SUMS file, exactly as the Dockerfile's
// connect-build stage does, so a development installation serves the same
// downloads as a release image.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(root, "connect");
const distDir = path.join(moduleDir, "dist");

// Keep in step with the Dockerfile's connect-build stage and CONNECT_OS_VALUES × CONNECT_ARCH_VALUES.
const CONNECT_BUILD_TARGETS = Object.freeze([
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["linux", "amd64"],
  ["linux", "arm64"]
]);

const VERSION_PATTERN = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,32})?$/u;

function fail(message) {
  console.error(`build:connect: ${message}`);
  process.exit(1);
}

function buildEnvironment(os, arch) {
  const env = { ...process.env };
  // Only the flags below decide the output: a developer's own Go settings
  // must not make these binaries differ from the release image's.
  for (const name of ["GOFLAGS", "GOEXPERIMENT", "GOAMD64", "GOARM64", "CC", "CGO_CFLAGS", "CGO_LDFLAGS"]) delete env[name];
  return {
    ...env,
    CGO_ENABLED: "0",
    GOAMD64: "v1",
    GOARCH: arch,
    GOARM64: "v8.0",
    GOFLAGS: "-mod=readonly",
    GOOS: os,
    GOTOOLCHAIN: "local"
  };
}

const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (typeof version !== "string" || !VERSION_PATTERN.test(version)) fail("package.json has no release version");

const probe = spawnSync("go", ["version"], { cwd: moduleDir, encoding: "utf8", env: buildEnvironment("linux", "amd64") });
if (probe.error?.code === "ENOENT") {
  fail("Go is not installed. Install the Go version named in connect/go.mod (https://go.dev/dl/) or build the image's connect-build stage with Docker.");
}
if (probe.status !== 0) fail(`go version failed: ${(probe.stderr || "").trim()}`);

rmSync(distDir, { force: true, recursive: true });
mkdirSync(distDir, { recursive: true });

const sums = [];
for (const [os, arch] of CONNECT_BUILD_TARGETS) {
  const name = `aiqsa-connect-${os}-${arch}`;
  const result = spawnSync("go", [
    "build",
    "-trimpath",
    "-buildvcs=false",
    `-ldflags=-s -w -buildid= -X main.version=${version}`,
    "-o",
    path.join(distDir, name),
    "./cmd/aiqsa-connect"
  ], { cwd: moduleDir, env: buildEnvironment(os, arch), stdio: "inherit" });
  if (result.error) fail(`go build ${os}/${arch}: ${result.error.message}`);
  if (result.status !== 0) fail(`go build ${os}/${arch} failed`);
  sums.push(`${createHash("sha256").update(readFileSync(path.join(distDir, name))).digest("hex")}  ${name}\n`);
}
writeFileSync(path.join(distDir, "SHA256SUMS"), sums.join(""));
console.log(`build:connect: aiqsa-connect ${version} for ${CONNECT_BUILD_TARGETS.length} targets in connect/dist (${probe.stdout.trim()})`);
