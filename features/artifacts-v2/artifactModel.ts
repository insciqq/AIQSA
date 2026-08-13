import type {
  GeneratedArtifactFormat,
  GeneratedArtifactProjection,
  GeneratedArtifactVersion
} from "./contracts";

export function artifactFormatLabel(format: GeneratedArtifactFormat): string {
  return format.toUpperCase();
}

export function artifactByteSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Размер неизвестен";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function boundArtifactVersion(
  artifact: GeneratedArtifactProjection
): GeneratedArtifactVersion | null {
  if (artifact.status !== "ready") return null;
  return artifact.versions.find((version) => version.id === artifact.boundVersionId) ?? null;
}

export function artifactVersionLabel(version: GeneratedArtifactVersion): string {
  return `v${version.number}`;
}
