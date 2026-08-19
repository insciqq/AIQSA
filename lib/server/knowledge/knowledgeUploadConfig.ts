import { KNOWLEDGE_UPLOAD_RESPONSE_MAX_ITEMS } from "../../contracts/knowledgeUploads";

export const DEFAULT_KNOWLEDGE_UPLOAD_MAX_BATCH_FILES = 100;
export const DEFAULT_KNOWLEDGE_UPLOAD_SESSION_SECONDS = 15 * 60;
export const KNOWLEDGE_UPLOAD_MULTIPART_PART_BYTES = 8 * 1_024 * 1_024;

export type KnowledgeUploadConfig = Readonly<{
  maxBatchFiles: number;
  multipartPartBytes: number;
  sessionSeconds: number;
}>;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^[1-9]\d{0,8}$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function getKnowledgeUploadConfig(
  environment: Record<string, string | undefined> = process.env
): KnowledgeUploadConfig {
  return {
    maxBatchFiles: boundedInteger(
      environment.AIQSA_KNOWLEDGE_MAX_BATCH_FILES,
      DEFAULT_KNOWLEDGE_UPLOAD_MAX_BATCH_FILES,
      1,
      KNOWLEDGE_UPLOAD_RESPONSE_MAX_ITEMS
    ),
    multipartPartBytes: KNOWLEDGE_UPLOAD_MULTIPART_PART_BYTES,
    sessionSeconds: DEFAULT_KNOWLEDGE_UPLOAD_SESSION_SECONDS
  };
}
