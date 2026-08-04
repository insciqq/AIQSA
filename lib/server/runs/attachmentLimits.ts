import {
  CATALOG_ATTACHMENT_LIMIT_CEILINGS,
  DEFAULT_CATALOG_ATTACHMENT_LIMITS,
  type CatalogAttachmentLimits
} from "../../contracts/catalog";

export const DEFAULT_RUN_ATTACHMENT_MAX_COUNT = DEFAULT_CATALOG_ATTACHMENT_LIMITS.maxCount;
export const DEFAULT_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES =
  DEFAULT_CATALOG_ATTACHMENT_LIMITS.maxMaterializedBytes;
export const DEFAULT_RUN_ATTACHMENT_MAX_ENCODED_BYTES =
  DEFAULT_CATALOG_ATTACHMENT_LIMITS.maxEncodedBytes;
export const DEFAULT_RUN_ATTACHMENT_READ_CONCURRENCY = 2;

export const RUN_ATTACHMENT_MAX_COUNT_CEILING = CATALOG_ATTACHMENT_LIMIT_CEILINGS.maxCount;
export const RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES_CEILING =
  CATALOG_ATTACHMENT_LIMIT_CEILINGS.maxMaterializedBytes;
export const RUN_ATTACHMENT_MAX_ENCODED_BYTES_CEILING =
  CATALOG_ATTACHMENT_LIMIT_CEILINGS.maxEncodedBytes;
export const RUN_ATTACHMENT_READ_CONCURRENCY_CEILING = 8;

export type RunAttachmentLimits = Readonly<{
  maxCount: number;
  maxEncodedBytes: number;
  maxMaterializedBytes: number;
  readConcurrency: number;
}>;

export type RunAttachmentLimitsEnvironment = Readonly<Record<string, string | undefined>>;

function positiveIntegerAtMost(
  value: string | undefined,
  fallback: number,
  ceiling: number
): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ceiling
    ? parsed
    : fallback;
}

export function getRunAttachmentLimits(
  env: RunAttachmentLimitsEnvironment = process.env
): RunAttachmentLimits {
  return {
    maxCount: positiveIntegerAtMost(
      env.AIQSA_RUN_ATTACHMENT_MAX_COUNT,
      DEFAULT_RUN_ATTACHMENT_MAX_COUNT,
      RUN_ATTACHMENT_MAX_COUNT_CEILING
    ),
    maxEncodedBytes: positiveIntegerAtMost(
      env.AIQSA_RUN_ATTACHMENT_MAX_ENCODED_BYTES,
      DEFAULT_RUN_ATTACHMENT_MAX_ENCODED_BYTES,
      RUN_ATTACHMENT_MAX_ENCODED_BYTES_CEILING
    ),
    maxMaterializedBytes: positiveIntegerAtMost(
      env.AIQSA_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES,
      DEFAULT_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES,
      RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES_CEILING
    ),
    readConcurrency: positiveIntegerAtMost(
      env.AIQSA_RUN_ATTACHMENT_READ_CONCURRENCY,
      DEFAULT_RUN_ATTACHMENT_READ_CONCURRENCY,
      RUN_ATTACHMENT_READ_CONCURRENCY_CEILING
    )
  };
}

export function toCatalogAttachmentLimits(
  limits: RunAttachmentLimits
): CatalogAttachmentLimits {
  return {
    maxCount: limits.maxCount,
    maxEncodedBytes: limits.maxEncodedBytes,
    maxMaterializedBytes: limits.maxMaterializedBytes
  };
}
