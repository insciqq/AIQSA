import {
  DEFAULT_UPLOAD_MAX_BYTES,
  MAX_UPLOAD_MAX_BYTES,
  defaultUploadMaxBytes
} from "../uploads/validation";

export const DEFAULT_AUTH_REQUEST_BODY_MAX_BYTES = 65_536;
export const DEFAULT_JSON_REQUEST_BODY_MAX_BYTES = 1_048_576;
export const DEFAULT_UPLOAD_MULTIPART_OVERHEAD_BYTES = 1_048_576;
export const DEFAULT_UPLOAD_MAX_CONCURRENCY = 4;

const MAX_AUTH_REQUEST_BODY_MAX_BYTES = 1_048_576;
const MAX_JSON_REQUEST_BODY_MAX_BYTES = 16_777_216;
const MAX_UPLOAD_MULTIPART_OVERHEAD_BYTES = 8_388_608;
const MAX_UPLOAD_MAX_CONCURRENCY = 8;

export type RequestBodyConfig = {
  authMaxBytes: number;
  jsonMaxBytes: number;
  uploadMaxConcurrency: number;
  uploadMultipartMaxBytes: number;
  uploadMultipartOverheadBytes: number;
};

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
): number {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : fallback;
}

function boundedUploadMaxBytes(uploadMaxBytes: number): number {
  return Number.isSafeInteger(uploadMaxBytes) && uploadMaxBytes >= 1 && uploadMaxBytes <= MAX_UPLOAD_MAX_BYTES
    ? uploadMaxBytes
    : DEFAULT_UPLOAD_MAX_BYTES;
}

export function getRequestBodyConfig(
  env: Record<string, string | undefined> = process.env,
  uploadMaxBytes = defaultUploadMaxBytes(env)
): RequestBodyConfig {
  const boundedUploadBytes = boundedUploadMaxBytes(uploadMaxBytes);
  const uploadMultipartOverheadBytes = positiveInteger(
    env.AIQSA_UPLOAD_MULTIPART_OVERHEAD_BYTES,
    DEFAULT_UPLOAD_MULTIPART_OVERHEAD_BYTES,
    MAX_UPLOAD_MULTIPART_OVERHEAD_BYTES
  );

  return {
    authMaxBytes: positiveInteger(
      env.AIQSA_AUTH_REQUEST_BODY_MAX_BYTES,
      DEFAULT_AUTH_REQUEST_BODY_MAX_BYTES,
      MAX_AUTH_REQUEST_BODY_MAX_BYTES
    ),
    jsonMaxBytes: positiveInteger(
      env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES,
      DEFAULT_JSON_REQUEST_BODY_MAX_BYTES,
      MAX_JSON_REQUEST_BODY_MAX_BYTES
    ),
    uploadMaxConcurrency: positiveInteger(
      env.AIQSA_UPLOAD_MAX_CONCURRENCY,
      DEFAULT_UPLOAD_MAX_CONCURRENCY,
      MAX_UPLOAD_MAX_CONCURRENCY
    ),
    uploadMultipartMaxBytes: boundedUploadBytes + uploadMultipartOverheadBytes,
    uploadMultipartOverheadBytes
  };
}
