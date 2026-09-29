// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/migrate-minio-to-seaweedfs.sh");
const directories: string[] = [];

// A Docker CLI double: it records every invocation and answers the read-only
// queries the script makes from scenario files.
const fakeDocker = String.raw`#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_DIR/log"
case "$*" in
  version) exit 0 ;;
  'compose version --short') printf '%s\n' "$FAKE_COMPOSE_VERSION" ;;
  'compose config --quiet') exit 0 ;;
  'compose --profile storage-migration config --format json storage-migrate') printf '    "image": "aiqsa:test",\n' ;;
  'compose --profile storage-migration config --format json minio-legacy') printf '    "image": "minio/minio:RELEASE@sha256:abc",\n' ;;
  'image inspect aiqsa:test') exit 0 ;;
  'image inspect -f {{.Id}} minio/minio:RELEASE@sha256:abc') [ -e "$FAKE_DIR/no-image" ] && exit 1; echo sha256:minio ;;
  'compose ps -a -q minio') cat "$FAKE_DIR/minio-ids" 2>/dev/null ;;
  'compose ps -q --status running minio') cat "$FAKE_DIR/running-minio" 2>/dev/null ;;
  'compose config --services') printf 'app\nminio\n' ;;
  'compose --profile storage-migration config --format json') echo '{}' ;;
  'compose run --rm --no-deps -T storage-init status') cat "$FAKE_DIR/status"; exit "$(cat "$FAKE_DIR/status-code")" ;;
  inspect\ -f\ \{\{.State.Running\}\}\ *) echo true ;;
  inspect\ -f\ \{\{range\ .Config.Env\}\}*) printf 'MINIO_ROOT_USER=aiqsa\nMINIO_ROOT_PASSWORD=fixture-secret\n' ;;
  inspect\ -f\ \{\{range\ \$name*) echo aiqsa_default ;;
  run\ --rm\ --network\ aiqsa_default\ *check-source) [ "$S3_SECRET_ACCESS_KEY" = fixture-secret ] && cat "$FAKE_DIR/source" ;;
  'info -f {{.DockerRootDir}}') echo /var/lib/docker ;;
  'compose --profile storage-migration run --rm --no-deps -T storage-migrate copy-from-minio-legacy') exit "$(cat "$FAKE_DIR/copy-code")" ;;
  inspect\ *) echo '[]' ;;
  volume\ inspect\ *) [ -e "$FAKE_DIR/no-volume" ] && exit 1; exit 0 ;;
  run\ --rm\ -i\ *plan) cat >/dev/null; cat "$FAKE_DIR/plan" ;;
  run\ --rm\ --network\ none\ *inspect-legacy*) cat "$FAKE_DIR/legacy" ;;
  run\ --rm\ --network\ none\ *inspect-space*) cat "$FAKE_DIR/space" ;;
  *) exit 0 ;;
esac
`;

const plan = [
  "project=aiqsa", "bucket=aiqsa-uploads", "legacy_image=minio/minio:RELEASE@sha256:abc",
  "legacy_origin=minio-container", "legacy_type=volume", "legacy_source=aiqsa_minio_data",
  "target_type=volume", "target_source=aiqsa_seaweedfs_data", "old_minio_container=abc",
  "legacy_container=", "s3_services=app memory-worker storage-init storage-migrate"
].join("\n");

type Scenario = Partial<{
  compose: string; copyCode: number; legacy: string; noImage: boolean; plan: string; source: string; space: string;
  runningMinio: string; status: string; statusCode: number;
}>;

function run(args: string[], scenario: Scenario = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "aiqsa-storage-migration-test-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "docker"), fakeDocker, { mode: 0o755 });
  writeFileSync(path.join(directory, "plan"), `${scenario.plan ?? plan}\n`);
  writeFileSync(path.join(directory, "legacy"), `${scenario.legacy ?? "layout=minio\nobjects=yes\nbytes=1000\nfiles=3"}\n`);
  writeFileSync(path.join(directory, "space"), `${scenario.space ?? "available=5000000000\nused=0"}\n`);
  writeFileSync(path.join(directory, "source"), `${scenario.source ?? "source=ok"}\n`);
  writeFileSync(path.join(directory, "status"), scenario.status ?? "marker=absent\nobjects=0\n");
  writeFileSync(path.join(directory, "status-code"), String(scenario.statusCode ?? 3));
  writeFileSync(path.join(directory, "copy-code"), String(scenario.copyCode ?? 0));
  writeFileSync(path.join(directory, "running-minio"), scenario.runningMinio ?? "");
  if (scenario.noImage) writeFileSync(path.join(directory, "no-image"), "");
  const result = spawnSync("sh", [script, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_COMPOSE_VERSION: scenario.compose ?? "2.29.7",
      FAKE_DIR: directory,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      TMPDIR: directory
    }
  });
  let log: string[] = [];
  try { log = readFileSync(path.join(directory, "log"), "utf8").trim().split("\n"); } catch { /* no calls */ }
  return { log, output: result.stdout + result.stderr, status: result.status };
}

const MUTATIONS = /^(?:image tag|compose stop|compose up|compose --profile storage-migration (?:up|stop|rm|run)|compose run --rm --no-deps -T migrate-bootstrap|volume (?:create|rm)|rm |image rm|compose down)/u;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("MinIO to SeaweedFS host script", () => {
  it("rejects unknown arguments", () => {
    expect(run(["--force"]).status).toBe(2);
    expect(run(["status", "extra"]).status).toBe(2);
  });

  it("performs only read-only commands in a dry run and prints both storage names", () => {
    const result = run(["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.log.some((call) => call.includes("fixture-secret"))).toBe(false);
    expect(result.log.filter((call) => call.startsWith("compose run"))).toEqual([]);
    expect(result.output).toContain("Legacy MinIO data (minio-container): volume aiqsa_minio_data");
    expect(result.output).toContain("New SeaweedFS data:        volume aiqsa_seaweedfs_data");
    expect(result.output).toContain("nothing was changed");
    expect(result.log.filter((call) => MUTATIONS.test(call))).toEqual([]);
  });

  it("runs the migration in the documented order without down, volume or image removal", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    const mutations = result.log.filter((call) => MUTATIONS.test(call));
    expect(mutations).toEqual([
      "image tag sha256:minio aiqsa-legacy-minio:aiqsa",
      "compose stop",
      "compose --profile storage-migration stop minio-legacy",
      "compose up -d --wait postgres minio",
      "compose run --rm --no-deps -T migrate-bootstrap",
      "compose --profile storage-migration up -d --wait minio-legacy",
      "compose --profile storage-migration run --rm --no-deps -T storage-migrate copy-from-minio-legacy",
      "compose --profile storage-migration stop minio-legacy",
      "compose --profile storage-migration rm -f minio-legacy",
      "compose up -d"
    ]);
    expect(result.log.some((call) => /down|volume rm|image rm|remove-orphans/u.test(call))).toBe(false);
  });

  it("keeps the stack stopped and the reader in place when copying fails", () => {
    const result = run([], { copyCode: 1 });
    expect(result.status).toBe(24);
    expect(result.output).toContain("rerun the script: it resumes");
    expect(result.log).not.toContain("compose up -d");
    expect(result.log.some((call) => call.includes("rm -f minio-legacy"))).toBe(false);
  });

  it("refuses to switch to an older migration after a rollback to MinIO", () => {
    const result = run([], { copyCode: 3 });
    expect(result.status).toBe(19);
    expect(result.log).not.toContain("compose up -d");
    const resumed = run([], { copyCode: 3, plan: plan.replace("old_minio_container=abc", "old_minio_container=") });
    expect(resumed.status).toBe(0);
    expect(resumed.log).toContain("compose up -d");
  });

  it.each([
    ["an old Compose release", { compose: "2.29.6" }, 10],
    ["an active storage-migration profile", { plan: "error=storage_profile_active" }, 12],
    ["an external endpoint", { plan: "error=storage_endpoint_external" }, 13],
    ["a mismatched legacy source", { plan: "error=storage_legacy_mount_mismatch\ndetail=MinIO data is on bind mount /srv/minio" }, 14],
    ["an empty legacy volume", { legacy: "layout=empty\nbytes=0" }, 15],
    ["an unknown legacy layout", { legacy: "layout=unknown" }, 15],
    ["unreadable legacy files", { legacy: "storage-init: refused EACCES" }, 15],
    ["a versioned legacy bucket", { source: "source=storage_migrate_source_versioned" }, 18],
    ["an encrypted legacy bucket", { source: "source=storage_migrate_source_encrypted" }, 18],
    ["unreadable legacy bucket settings", { source: "" }, 18],
    ["a missing MinIO image", { noImage: true }, 16],
    ["insufficient disk", { space: "available=100\nused=0" }, 17]
  ] as const)("refuses %s before any mutation", (_name, scenario, code) => {
    const result = run([], scenario);
    expect(result.status).toBe(code);
    expect(result.output).toMatch(/FAILED \(exit \d+\)[\s\S]*Next step:|FAILED \(exit \d+\)/u);
    expect(result.log.filter((call) => MUTATIONS.test(call))).toEqual([]);
  });

  it("reports an already migrated installation without changes", () => {
    const result = run([], {
      plan: plan.replace("old_minio_container=abc", "old_minio_container="),
      runningMinio: "relay",
      status: "marker=valid\nmarker_source=migrated\nobjects=3\n",
      statusCode: 0
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Already migrated");
    expect(result.log.filter((call) => MUTATIONS.test(call))).toEqual([]);
  });

  it("refuses a foreign or invalid marker", () => {
    const result = run([], {
      plan: plan.replace("old_minio_container=abc", "old_minio_container="),
      runningMinio: "relay",
      statusCode: 4
    });
    expect(result.status).toBe(19);
    expect(result.log.filter((call) => MUTATIONS.test(call))).toEqual([]);
  });

  it("reports status codes for a valid, absent or unreadable marker", () => {
    expect(run(["status"], { runningMinio: "relay", statusCode: 0, status: "marker=valid\nobjects=1\n" }))
      .toMatchObject({ status: 0, output: expect.stringContaining("marker=valid") });
    expect(run(["status"], { runningMinio: "relay", statusCode: 3 }).status).toBe(30);
    expect(run(["status"], { runningMinio: "relay", statusCode: 4 }).status).toBe(31);
    expect(run(["status"]).status).toBe(31);
  });
});
