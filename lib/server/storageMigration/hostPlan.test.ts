import { describe, expect, it } from "vitest";
import { formatHostPlan, resolveHostPlan, type HostPlanInput } from "./hostPlan";

const MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const MINIO_ID = "sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const APP_IMAGE = "ghcr.io/insciqq/aiqsa:latest";

type Mount = Record<string, unknown>;
const volume = (source: string, target: string): Mount => ({ source, target, type: "volume", volume: {} });
const s3 = { S3_BUCKET: "aiqsa-uploads", S3_ENDPOINT: "http://minio:9000" };

function config(overrides: Record<string, Record<string, unknown>> = {}) {
  const services: Record<string, Record<string, unknown>> = {
    app: { environment: s3, image: APP_IMAGE },
    "memory-worker": { environment: s3, image: APP_IMAGE },
    "migrate-bootstrap": { environment: {}, image: APP_IMAGE },
    minio: { image: APP_IMAGE, volumes: [volume("storage_socket", "/run/aiqsa-storage-socket")] },
    "minio-legacy": { image: MINIO_IMAGE, volumes: [volume("minio_data", "/data")] },
    seaweedfs: { volumes: [volume("seaweedfs_data", "/data"), volume("storage_socket", "/run/aiqsa-storage-socket")] },
    "storage-init": { environment: s3, image: APP_IMAGE, volumes: [{ ...volume("minio_data", "/legacy"), read_only: true }] },
    "storage-migrate": { environment: s3, image: APP_IMAGE },
    toolhive: { volumes: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock", type: "bind" }] }
  };
  for (const [name, value] of Object.entries(overrides)) services[name] = { ...services[name], ...value };
  return {
    name: "aiqsa",
    services,
    volumes: {
      minio_data: { name: "aiqsa_minio_data" },
      seaweedfs_data: { name: "aiqsa_seaweedfs_data" },
      storage_socket: { name: "aiqsa_storage_socket" }
    }
  };
}

function container(id: string, image: string, imageId: string, mounts: Mount[]) {
  return { Config: { Image: image }, Id: id.padEnd(64, "0"), Image: imageId, Mounts: mounts };
}

const oldMinio = container("a1", MINIO_IMAGE, MINIO_ID, [
  { Destination: "/data", Name: "aiqsa_minio_data", Source: "/var/lib/docker/volumes/aiqsa_minio_data/_data", Type: "volume" }
]);
const relay = container("b2", APP_IMAGE, "sha256:app", [
  { Destination: "/run/aiqsa-storage-socket", Name: "aiqsa_storage_socket", Type: "volume" }
]);
const reader = container("c3", MINIO_IMAGE, MINIO_ID, [
  { Destination: "/data", Name: "aiqsa_minio_data", Type: "volume" }
]);

function input(overrides: Partial<HostPlanInput> = {}): HostPlanInput {
  return {
    activeServices: ["app", "memory-worker", "minio", "seaweedfs", "storage-init"],
    config: config(),
    legacyContainers: [],
    legacyImageId: MINIO_ID,
    minioContainers: [oldMinio],
    ...overrides
  };
}

describe("host migration plan", () => {
  it("resolves the legacy source from the running MinIO container", () => {
    const plan = resolveHostPlan(input());
    expect(plan).toMatchObject({
      bucket: "aiqsa-uploads",
      legacy: { source: "aiqsa_minio_data", type: "volume" },
      legacyContainer: null,
      legacyImage: MINIO_IMAGE,
      legacyOrigin: "minio-container",
      oldMinioContainer: oldMinio.Id,
      project: "aiqsa",
      s3Services: ["app", "memory-worker", "storage-init", "storage-migrate"],
      target: { source: "aiqsa_seaweedfs_data", type: "volume" }
    });
    expect(formatHostPlan(plan)).toContain("legacy_source=aiqsa_minio_data\ntarget_type=volume\n");
  });

  it("matches the old container by reference when the image is no longer present", () => {
    expect(resolveHostPlan(input({ legacyImageId: "" })).legacyOrigin).toBe("minio-container");
  });

  it("uses the existing reader after the storage container was replaced", () => {
    const plan = resolveHostPlan(input({ legacyContainers: [reader], minioContainers: [relay] }));
    expect(plan).toMatchObject({ legacyContainer: reader.Id, legacyOrigin: "minio-legacy-container", oldMinioContainer: null });
  });

  it("falls back to the reader configuration when no container exists", () => {
    expect(resolveHostPlan(input({ minioContainers: [] })).legacyOrigin).toBe("configuration");
    expect(resolveHostPlan(input({ minioContainers: [relay] })).legacyOrigin).toBe("configuration");
  });

  it("refuses a legacy source that the reader or the guard would not mount", () => {
    const bindMinio = container("d4", MINIO_IMAGE, MINIO_ID, [{ Destination: "/data", Source: "/srv/minio/", Type: "bind" }]);
    expect(() => resolveHostPlan(input({ minioContainers: [bindMinio] }))).toThrow(expect.objectContaining({
      code: "storage_legacy_mount_mismatch",
      detail: expect.stringContaining("bind mount /srv/minio; minio-legacy uses volume aiqsa_minio_data")
    }));
    const guard = config({ "storage-init": { volumes: [volume("other", "/legacy")] } });
    (guard.volumes as Record<string, unknown>).other = { name: "aiqsa_other" };
    expect(() => resolveHostPlan(input({ config: guard }))).toThrow(expect.objectContaining({ code: "storage_legacy_mount_mismatch" }));
    const matching = config({
      "minio-legacy": { volumes: [{ source: "/srv/minio", target: "/data", type: "bind" }] },
      "storage-init": { volumes: [{ read_only: true, source: "/srv/minio", target: "/legacy", type: "bind" }] }
    });
    expect(resolveHostPlan(input({ config: matching, minioContainers: [bindMinio] })).legacy)
      .toEqual({ source: "/srv/minio", type: "bind" });
  });

  it("refuses an old override that still maps a data path into the minio service", () => {
    const remapped = config({ minio: { volumes: [volume("minio_data", "/data")] } });
    expect(() => resolveHostPlan(input({ config: remapped }))).toThrow(expect.objectContaining({ code: "storage_minio_data_remapped" }));
  });

  it("refuses a target that is the legacy source", () => {
    const same = config({ seaweedfs: { volumes: [volume("minio_data", "/data")] } });
    expect(() => resolveHostPlan(input({ config: same }))).toThrow(expect.objectContaining({ code: "storage_target_is_legacy" }));
  });

  it("refuses an active migration profile and an external endpoint", () => {
    expect(() => resolveHostPlan(input({ activeServices: ["app", "minio-legacy"] })))
      .toThrow(expect.objectContaining({ code: "storage_profile_active" }));
    const external = config({ app: { environment: { S3_ENDPOINT: "https://s3.example.test" } } });
    expect(() => resolveHostPlan(input({ config: external }))).toThrow(expect.objectContaining({ code: "storage_endpoint_external" }));
  });

  it("refuses ambiguous or incomplete state", () => {
    expect(() => resolveHostPlan(input({ minioContainers: [oldMinio, { ...oldMinio, Id: "e5".padEnd(64, "0") }] })))
      .toThrow(expect.objectContaining({ code: "storage_legacy_ambiguous" }));
    const incomplete = config();
    delete (incomplete.services as Record<string, unknown>)["minio-legacy"];
    expect(() => resolveHostPlan(input({ config: incomplete }))).toThrow(expect.objectContaining({ code: "storage_config_incomplete" }));
    const noMount = container("f6", MINIO_IMAGE, MINIO_ID, []);
    expect(() => resolveHostPlan(input({ minioContainers: [noMount] }))).toThrow(expect.objectContaining({ code: "storage_legacy_source_missing" }));
  });
});
