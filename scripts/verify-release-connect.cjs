"use strict";

// Checks the AIQSA Connect client downloads in connect/dist: exactly the four
// binaries and SHA256SUMS, matching checksums, and a binary for this machine
// that reports the application version. With --release (the image build) it
// also requires root-owned, read-only files the application user cannot
// replace.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TARGETS = ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"];
const NAMES = TARGETS.map((target) => `aiqsa-connect-${target}`);
const SUMS = "SHA256SUMS";

function main() {
  const release = process.argv.includes("--release");
  const root = path.resolve(__dirname, "..");
  const dist = path.join(root, "connect", "dist");
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  assert.deepEqual(fs.readdirSync(dist).sort(), [...NAMES, SUMS].sort(), "connect_release_files_invalid");
  const expected = NAMES.map((name) => {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(dist, name))).digest("hex");
    return `${digest}  ${name}\n`;
  }).join("");
  assert.equal(fs.readFileSync(path.join(dist, SUMS), "utf8"), expected, "connect_release_checksums_invalid");

  if (release) {
    assert.notEqual(process.getuid(), 0, "connect_release_requires_nonroot");
    for (const name of [...NAMES, SUMS]) {
      const stat = fs.statSync(path.join(dist, name));
      assert.ok(stat.isFile(), "connect_release_file_invalid");
      assert.equal(stat.uid, 0, "connect_release_owner_invalid");
      assert.equal(stat.mode & 0o7777, 0o444, "connect_release_mode_invalid");
    }
    // Neither the files nor the directories above them may be replaced by the application user.
    for (const dir of [dist, path.dirname(dist), root]) {
      assert.equal(fs.statSync(dir).uid, 0, "connect_release_directory_owner_invalid");
      assert.throws(() => fs.accessSync(dir, fs.constants.W_OK), "connect_release_directory_writable");
    }
  }

  const arch = { arm64: "arm64", x64: "amd64" }[process.arch];
  if (!["darwin", "linux"].includes(process.platform) || !arch) {
    assert.ok(!release, "connect_release_platform_invalid");
    return;
  }
  // The shipped files are not executable (mode 0444): run a private copy.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aiqsa-connect-verify-"));
  try {
    const binary = path.join(scratch, "aiqsa-connect");
    fs.copyFileSync(path.join(dist, `aiqsa-connect-${process.platform}-${arch}`), binary);
    fs.chmodSync(binary, 0o700);
    const output = execFileSync(binary, ["version"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(output.trim(), version, "connect_release_version_invalid");
  } finally {
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}

main();
