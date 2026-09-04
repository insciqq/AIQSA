import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createReadStream, openSync, closeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [rootfsValue, outputValue, reference = "aiqsa-workspace:0.1.25", architecture = "amd64"] =
  process.argv.slice(2);
if (!rootfsValue || !outputValue || !["amd64", "arm64"].includes(architecture)) {
  throw new Error("usage: build-workspace-oci.mjs <rootfs> <output.tar> [reference] [amd64|arm64]");
}

const rootfs = resolve(rootfsValue);
const output = resolve(outputValue);
const buildRoot = `${output}.build`;
const layout = join(buildRoot, "layout");
const rawLayer = join(buildRoot, "layer.tar");
const compressedLayer = join(buildRoot, "layer.tar.gz");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command}_failed_${result.status ?? "signal"}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeBlob(value) {
  const encoded = Buffer.from(JSON.stringify(value));
  const digest = createHash("sha256").update(encoded).digest("hex");
  const target = join(layout, "blobs", "sha256", digest);
  await writeFile(target, encoded);
  return { digest: `sha256:${digest}`, size: encoded.byteLength };
}

await rm(buildRoot, { force: true, recursive: true });
await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
run("tar", [
  "--sort=name",
  "--mtime=@0",
  "--clamp-mtime",
  "--numeric-owner",
  "--owner=0",
  "--group=0",
  "--format=posix",
  "--pax-option=delete=atime,delete=ctime",
  "-C",
  rootfs,
  "-cf",
  rawLayer,
  "."
]);
const compressedFd = openSync(compressedLayer, "w");
try {
  run("gzip", ["-n", "-c", rawLayer], { stdio: ["ignore", compressedFd, "inherit"] });
} finally {
  closeSync(compressedFd);
}
const diffId = await sha256(rawLayer);
const layerDigest = await sha256(compressedLayer);
const layerSize = (await stat(compressedLayer)).size;
await copyFile(compressedLayer, join(layout, "blobs", "sha256", layerDigest));

const config = await writeBlob({
  architecture,
  config: {
    Cmd: ["/bin/bash"],
    Env: [
      "PATH=/opt/aiqsa-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    ],
    WorkingDir: "/workspace/project"
  },
  history: [{ created_by: "AIQSA pinned Workspace guest image" }],
  os: "linux",
  rootfs: { diff_ids: [`sha256:${diffId}`], type: "layers" }
});
const manifest = await writeBlob({
  config: {
    digest: config.digest,
    mediaType: "application/vnd.oci.image.config.v1+json",
    size: config.size
  },
  layers: [{
    digest: `sha256:${layerDigest}`,
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    size: layerSize
  }],
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  schemaVersion: 2
});
await writeFile(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
await writeFile(join(layout, "index.json"), JSON.stringify({
  manifests: [{
    annotations: { "org.opencontainers.image.ref.name": reference },
    digest: manifest.digest,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: { architecture, os: "linux" },
    size: manifest.size
  }],
  schemaVersion: 2
}));

await mkdir(dirname(output), { recursive: true });
const stagedOutput = join(buildRoot, basename(output));
run("tar", [
  "--sort=name",
  "--mtime=@0",
  "--clamp-mtime",
  "--numeric-owner",
  "--owner=0",
  "--group=0",
  "--format=posix",
  "--pax-option=delete=atime,delete=ctime",
  "-C",
  layout,
  "-cf",
  stagedOutput,
  "."
]);
await rm(output, { force: true });
await rename(stagedOutput, output);
process.stdout.write(`${reference} ${await sha256(output)}\n`);
