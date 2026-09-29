import { storageBucketName } from "./marker";
import { isBundledStorageEndpoint } from "./storageInit";

// Resolves the MinIO-to-SeaweedFS host migration from actual Compose and
// Docker state. The host script gathers the effective configuration and
// `docker inspect` output; this pure function decides, so the rules are tested
// here rather than in shell text processing.

export type MountRef = Readonly<{ source: string; type: "bind" | "volume" }>;

export type HostPlanInput = Readonly<{
  /** Services of the ordinary configuration, without an extra profile. */
  activeServices: readonly string[];
  /** `docker compose --profile storage-migration config --format json`. */
  config: unknown;
  /** `docker inspect` of the storage-migration reader containers. */
  legacyContainers: readonly unknown[];
  /** Local image ID of the pinned MinIO reference, or "" when absent. */
  legacyImageId: string;
  /** `docker inspect` of the `minio` service containers. */
  minioContainers: readonly unknown[];
}>;

export type HostPlan = Readonly<{
  bucket: string;
  legacy: MountRef;
  legacyContainer: string | null;
  legacyImage: string;
  legacyOrigin: "configuration" | "minio-container" | "minio-legacy-container";
  oldMinioContainer: string | null;
  project: string;
  s3Services: readonly string[];
  target: MountRef;
}>;

export class HostPlanError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail = "") {
    super(code);
    this.name = "HostPlanError";
    this.code = code;
    this.detail = detail;
  }
}

type Record_ = Record<string, unknown>;

function record(value: unknown): Record_ | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record_ : null;
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
// A bind source must be an absolute host path printable on one line.
const BIND_PATH = /^\/[^\u0000-\u001f\u007f]{0,4095}$/u;

function mountRef(type: unknown, source: unknown): MountRef | null {
  if (type === "volume" && typeof source === "string" && VOLUME_NAME.test(source)) return { source, type };
  if (type === "bind" && typeof source === "string" && BIND_PATH.test(source)) {
    return { source: source.length > 1 ? source.replace(/\/+$/u, "") : source, type };
  }
  return null;
}

export function describeMount(mount: MountRef): string {
  return mount.type === "volume" ? `volume ${mount.source}` : `bind mount ${mount.source}`;
}

function sameMount(left: MountRef, right: MountRef): boolean {
  return left.type === right.type && left.source === right.source;
}

function service(config: Record_, name: string): Record_ {
  const services = record(config.services);
  const found = services ? record(services[name]) : null;
  if (!found) throw new HostPlanError("storage_config_incomplete", `service ${name} is missing`);
  return found;
}

function configMounts(config: Record_, serviceName: string, target: string): MountRef[] {
  const volumes = record(config.volumes) ?? {};
  const mounts: MountRef[] = [];
  const entries = service(config, serviceName).volumes;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const mount = record(entry);
    if (!mount || mount.target !== target) continue;
    if (mount.type === "volume") {
      const key = typeof mount.source === "string" ? mount.source : "";
      const declared = record(volumes[key]);
      const name = declared && typeof declared.name === "string" ? declared.name : "";
      const resolved = mountRef("volume", name);
      if (!resolved) throw new HostPlanError("storage_config_incomplete", `${serviceName} ${target} has no named volume`);
      mounts.push(resolved);
    } else {
      const resolved = mountRef(mount.type, mount.source);
      if (!resolved) throw new HostPlanError("storage_config_incomplete", `${serviceName} ${target} mount is unsupported`);
      mounts.push(resolved);
    }
  }
  return mounts;
}

function singleConfigMount(config: Record_, serviceName: string, target: string): MountRef {
  const mounts = configMounts(config, serviceName, target);
  if (mounts.length !== 1) throw new HostPlanError("storage_config_incomplete", `${serviceName} needs one ${target} mount`);
  return mounts[0]!;
}

function containerId(container: Record_): string {
  const id = typeof container.Id === "string" ? container.Id : "";
  if (!/^[0-9a-f]{12,64}$/u.test(id)) throw new HostPlanError("storage_container_state_invalid");
  return id;
}

function containerDataMount(container: Record_): MountRef | null {
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  for (const entry of mounts) {
    const mount = record(entry);
    if (!mount || mount.Destination !== "/data") continue;
    const resolved = mountRef(mount.Type, mount.Type === "volume" ? mount.Name : mount.Source);
    if (!resolved) throw new HostPlanError("storage_legacy_source_unsupported");
    return resolved;
  }
  return null;
}

function containerImage(container: Record_): { configured: string; id: string } {
  const configuration = record(container.Config);
  return {
    configured: configuration && typeof configuration.Image === "string" ? configuration.Image : "",
    id: typeof container.Image === "string" ? container.Image : ""
  };
}

function environment(config: Record_, serviceName: string): Record_ {
  return record(service(config, serviceName).environment) ?? {};
}

export function resolveHostPlan(input: HostPlanInput): HostPlan {
  const config = record(input.config);
  if (!config) throw new HostPlanError("storage_config_incomplete");
  const project = typeof config.name === "string" ? config.name : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(project)) throw new HostPlanError("storage_config_incomplete", "project name");

  if (input.activeServices.includes("minio-legacy") || input.activeServices.includes("storage-migrate")) {
    throw new HostPlanError("storage_profile_active");
  }
  const endpoint = environment(config, "app").S3_ENDPOINT;
  if (!isBundledStorageEndpoint(typeof endpoint === "string" ? endpoint : undefined)) {
    throw new HostPlanError("storage_endpoint_external");
  }

  let bucket: string;
  try {
    const value = environment(config, "storage-init").S3_BUCKET;
    bucket = storageBucketName(typeof value === "string" ? value : undefined);
  } catch {
    throw new HostPlanError("storage_config_incomplete", "bucket name");
  }

  const legacyService = service(config, "minio-legacy");
  const legacyImage = typeof legacyService.image === "string" ? legacyService.image : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9./_:@-]+$/u.test(legacyImage)) throw new HostPlanError("storage_config_incomplete", "legacy image");
  const configuredLegacy = singleConfigMount(config, "minio-legacy", "/data");
  const guardLegacy = singleConfigMount(config, "storage-init", "/legacy");
  const target = singleConfigMount(config, "seaweedfs", "/data");
  if (configMounts(config, "minio", "/data").length > 0) {
    throw new HostPlanError("storage_minio_data_remapped", "the minio service still has a /data mount");
  }

  const isLegacyMinio = (container: Record_) => {
    const image = containerImage(container);
    return (input.legacyImageId !== "" && image.id === input.legacyImageId) || image.configured === legacyImage;
  };
  const minioContainers = input.minioContainers.map(record).filter((value): value is Record_ => Boolean(value));
  const oldMinio = minioContainers.filter(isLegacyMinio);
  const readers = input.legacyContainers.map(record).filter((value): value is Record_ => Boolean(value));
  if (oldMinio.length > 1 || readers.length > 1) throw new HostPlanError("storage_legacy_ambiguous");

  let legacy: MountRef;
  let legacyOrigin: HostPlan["legacyOrigin"];
  if (oldMinio.length === 1) {
    const mount = containerDataMount(oldMinio[0]!);
    if (!mount) throw new HostPlanError("storage_legacy_source_missing", "the MinIO container has no /data mount");
    legacy = mount;
    legacyOrigin = "minio-container";
  } else if (readers.length === 1) {
    const mount = containerDataMount(readers[0]!);
    if (!mount) throw new HostPlanError("storage_legacy_source_missing", "the minio-legacy container has no /data mount");
    legacy = mount;
    legacyOrigin = "minio-legacy-container";
  } else {
    legacy = configuredLegacy;
    legacyOrigin = "configuration";
  }

  if (!sameMount(legacy, configuredLegacy) || !sameMount(legacy, guardLegacy)) {
    throw new HostPlanError(
      "storage_legacy_mount_mismatch",
      `MinIO data is on ${describeMount(legacy)}; minio-legacy uses ${describeMount(configuredLegacy)}` +
      ` and storage-init uses ${describeMount(guardLegacy)}`
    );
  }
  if (sameMount(target, legacy)) throw new HostPlanError("storage_target_is_legacy", describeMount(target));

  const services = record(config.services) ?? {};
  const s3Services = Object.keys(services).filter((name) =>
    !["minio", "minio-legacy", "seaweedfs"].includes(name) && typeof environment(config, name).S3_ENDPOINT === "string"
  ).sort();

  return {
    bucket,
    legacy,
    legacyContainer: readers.length === 1 ? containerId(readers[0]!) : null,
    legacyImage,
    legacyOrigin,
    oldMinioContainer: oldMinio.length === 1 ? containerId(oldMinio[0]!) : null,
    project,
    s3Services,
    target
  };
}

/** Line protocol for the POSIX host script; every value is one printable line. */
export function formatHostPlan(plan: HostPlan): string {
  const lines = [
    ["project", plan.project],
    ["bucket", plan.bucket],
    ["legacy_image", plan.legacyImage],
    ["legacy_origin", plan.legacyOrigin],
    ["legacy_type", plan.legacy.type],
    ["legacy_source", plan.legacy.source],
    ["target_type", plan.target.type],
    ["target_source", plan.target.source],
    ["old_minio_container", plan.oldMinioContainer ?? ""],
    ["legacy_container", plan.legacyContainer ?? ""],
    ["s3_services", plan.s3Services.join(" ")]
  ];
  return `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}
