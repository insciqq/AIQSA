import type { ErrorResponse } from "./http";

export type AdminReleaseStatus = {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  publishedAt: string | null;
  releaseUrl: string | null;
  state: "current" | "unavailable" | "update_available";
};

export type AdminReleaseStatusErrorResponse = ErrorResponse<"forbidden" | "unauthorized">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function nullableBoundedString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  return boundedString(value, maxLength) ?? undefined;
}

export function decodeAdminReleaseStatus(value: unknown): AdminReleaseStatus | null {
  if (!isRecord(value)) return null;
  const checkedAt = boundedString(value.checkedAt, 64);
  const currentVersion = boundedString(value.currentVersion, 64);
  const latestVersion = nullableBoundedString(value.latestVersion, 64);
  const publishedAt = nullableBoundedString(value.publishedAt, 64);
  const releaseUrl = nullableBoundedString(value.releaseUrl, 512);
  const state = value.state === "current" || value.state === "unavailable" ||
    value.state === "update_available"
    ? value.state
    : null;
  if (
    !checkedAt ||
    !currentVersion ||
    latestVersion === undefined ||
    publishedAt === undefined ||
    releaseUrl === undefined ||
    !state ||
    !Number.isFinite(Date.parse(checkedAt)) ||
    (publishedAt !== null && !Number.isFinite(Date.parse(publishedAt))) ||
    (releaseUrl !== null && !releaseUrl.startsWith("https://github.com/insciqq/AIQSA/releases/tag/")) ||
    (state === "unavailable" && (latestVersion !== null || publishedAt !== null || releaseUrl !== null)) ||
    (state !== "unavailable" && (!latestVersion || !publishedAt || !releaseUrl))
  ) {
    return null;
  }
  return {
    checkedAt,
    currentVersion,
    latestVersion,
    publishedAt,
    releaseUrl,
    state
  };
}
