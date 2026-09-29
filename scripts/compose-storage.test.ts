// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

type Service = Record<string, unknown> & {
  command?: unknown; depends_on?: Record<string, { condition: string }>; entrypoint?: string[];
  environment?: Record<string, string>; image?: string; networks?: string[]; profiles?: string[];
  volumes?: string[];
};
type ComposeFile = { networks: Record<string, { internal?: boolean }>; services: Record<string, Service>; volumes: Record<string, unknown> };

const files = ["compose.yaml", "docker-compose.dev.yml"] as const;
const load = (file: string) => parse(readFileSync(path.resolve(file), "utf8")) as ComposeFile;
const production = load("compose.yaml");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("object storage topology", () => {
  it.each(files)("%s references no MinIO client image and keeps MinIO only as the pinned legacy reader", (file) => {
    const compose = load(file);
    for (const [name, service] of Object.entries(compose.services)) {
      expect(String(service.image ?? "")).not.toMatch(/minio\/mc/u);
      if (/minio\/minio/u.test(String(service.image ?? ""))) expect(name).toBe("minio-legacy");
    }
    expect(compose.services["minio-init"]).toBeUndefined();
  });

  it.each(files)("%s runs SeaweedFS without a network and exposes only the S3 relay", (file) => {
    const { services } = load(file);
    const engine = services.seaweedfs!;
    expect(engine.image).toMatch(/^chrislusf\/seaweedfs:[\d.]+@sha256:[0-9a-f]{64}$/u);
    expect(engine).toMatchObject({ network_mode: "none", read_only: true, user: "1000:1000" });
    expect(engine.cap_drop).toEqual(["ALL"]);
    const script = engine.entrypoint!.join("\n");
    for (const flag of [
      "-ip=127.0.0.1", "-ip.bind=127.0.0.1", "-master.telemetry=false", "-master.volumeSizeLimitMB=1024",
      "-volume.max=0", "-dir=/data", "-master.dir=/data", "-s3.config=", "-s3.autoCreateBucket=false",
      "-s3.iam=false", "-s3.port.iceberg=0", "-s3.port.lance=0", "-webdav=false", "-s3.allowedOrigins=",
      "-s3.localSocket=/run/aiqsa-storage-socket/s3.sock"
    ]) expect(script).toContain(flag);
    expect(script).not.toContain("-s3.ip.bind");
    const relay = services.minio!;
    expect(relay.command).toEqual(["node", "scripts/storage-relay.cjs"]);
    expect(relay.depends_on).toEqual({ seaweedfs: { condition: "service_healthy" } });
    const socket = (engine.volumes ?? []).filter((entry) => entry.endsWith(":/run/aiqsa-storage-socket"));
    expect(socket).toHaveLength(1);
    expect(relay.volumes).toEqual(socket);
    expect(relay.user).toBe("1000:1000");
  });

  it("gates application writers on storage-init after migrations", () => {
    const { services } = production;
    expect(services["storage-init"]!.depends_on).toEqual({
      "migrate-bootstrap": { condition: "service_completed_successfully" },
      minio: { condition: "service_healthy" }
    });
    for (const writer of ["app", "memory-worker"]) {
      expect(services[writer]!.depends_on!["storage-init"]).toEqual({ condition: "service_completed_successfully" });
    }
    expect(Object.keys(services["migrate-bootstrap"]!.depends_on!)).toEqual(["postgres"]);
    expect(Object.keys(services["migrate-bootstrap"]!.environment!).filter((key) => key.startsWith("S3_"))).toEqual([]);
    expect(services["storage-init"]!.volumes).toEqual(["minio_data:/legacy:ro"]);
  });

  it("starts the migration services only through their profile and explicit arguments", () => {
    const { networks, services } = production;
    const legacy = services["minio-legacy"]!;
    expect(legacy).toMatchObject({ networks: ["storage-migration"], profiles: ["storage-migration"], pull_policy: "never" });
    expect(legacy.image).toMatch(/^minio\/minio:RELEASE\.[0-9TZ-]+@sha256:[0-9a-f]{64}$/u);
    expect(legacy.ports).toBeUndefined();
    expect(networks["storage-migration"]).toEqual({ internal: true });
    const migrate = services["storage-migrate"]!;
    expect(migrate.profiles).toEqual(["storage-migration"]);
    // Arguments of `docker compose run` must reach the script, not replace it.
    expect(migrate.entrypoint).toEqual(["node", "--import", "tsx", "scripts/storage-migrate.ts"]);
    expect(migrate.command).toEqual([]);
    expect(services["storage-init"]!.entrypoint).toEqual(["node", "--import", "tsx", "scripts/storage-init.ts"]);
    expect(services["storage-init"]!.command).toEqual([]);
    expect(Object.keys(production.volumes)).toEqual(expect.arrayContaining(["minio_data", "seaweedfs_data", "storage_socket"]));
  });
});

describe("SeaweedFS entry point", () => {
  function run(env: Record<string, string>) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "aiqsa-seaweedfs-entry-"));
    directories.push(directory);
    const weed = path.join(directory, "weed");
    writeFileSync(weed, "#!/bin/sh\nfor argument in \"$@\"; do printf '%s\\n' \"$argument\"; done\n", { mode: 0o755 });
    const script = production.services.seaweedfs!.entrypoint![2]!
      .replaceAll("$$", "$")
      .replaceAll("/run/aiqsa-storage/s3.json", path.join(directory, "s3.json"))
      .replace("exec /usr/bin/weed", `exec ${weed}`);
    const result = spawnSync("sh", ["-euc", script, "aiqsa-storage"], { encoding: "utf8", env: { ...process.env, ...env } });
    let config: unknown = null;
    try { config = JSON.parse(readFileSync(path.join(directory, "s3.json"), "utf8")); } catch { /* not written */ }
    return { args: result.stdout.trim().split("\n"), config, status: result.status, stderr: result.stderr };
  }

  it("renders exactly one identity with escaped credentials and the application origin", () => {
    const result = run({
      AIQSA_STORAGE_ACCESS_KEY_ID: 'key"with\\quote',
      AIQSA_STORAGE_ALLOWED_ORIGIN: "https://aiqsa.example.test/app/",
      AIQSA_STORAGE_EXTERNAL_URL: "https://objects.example.test",
      AIQSA_STORAGE_SECRET_ACCESS_KEY: "secret-value"
    });
    expect(result.status).toBe(0);
    expect(result.config).toEqual({ identities: [{
      actions: ["Admin", "Read", "List", "Write"],
      credentials: [{ accessKey: 'key"with\\quote', secretKey: "secret-value" }],
      name: "aiqsa"
    }] });
    expect(result.args).toContain("-s3.allowedOrigins=https://aiqsa.example.test");
    expect(result.args).toContain("-s3.externalUrl=https://objects.example.test");
    expect(result.args.join(" ")).not.toContain("secret-value");
  });

  it.each([
    ["an empty secret", { AIQSA_STORAGE_SECRET_ACCESS_KEY: "" }, "storage_credentials_invalid"],
    ["a control character", { AIQSA_STORAGE_SECRET_ACCESS_KEY: "a\nb" }, "storage_credentials_invalid"],
    ["an invalid origin", { AIQSA_STORAGE_ALLOWED_ORIGIN: "not a url" }, "storage_allowed_origin_invalid"]
  ])("refuses to start with %s", (_name, override, code) => {
    const result = run({
      AIQSA_STORAGE_ACCESS_KEY_ID: "aiqsa",
      AIQSA_STORAGE_ALLOWED_ORIGIN: "http://localhost:3000",
      AIQSA_STORAGE_EXTERNAL_URL: "",
      AIQSA_STORAGE_SECRET_ACCESS_KEY: "secret",
      ...override
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(code);
    expect(result.config).toBeNull();
  });

  it("omits the external URL when no public endpoint is configured", () => {
    const result = run({
      AIQSA_STORAGE_ACCESS_KEY_ID: "aiqsa", AIQSA_STORAGE_ALLOWED_ORIGIN: "http://localhost:3000",
      AIQSA_STORAGE_EXTERNAL_URL: "", AIQSA_STORAGE_SECRET_ACCESS_KEY: "secret"
    });
    expect(result.status).toBe(0);
    expect(result.args.some((argument) => argument.startsWith("-s3.externalUrl"))).toBe(false);
  });
});
