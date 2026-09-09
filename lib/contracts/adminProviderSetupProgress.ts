import type { AdminProviderCapabilityCheck } from "./adminProviders";

export const ADMIN_PROVIDER_SETUP_STREAM_TYPE = "application/x-ndjson";

export const ADMIN_PROVIDER_SETUP_PHASES = [
  "validating", "discovering", "checking", "saving", "finishing"
] as const;

/** Content-free progress; saved graph/run ids let cancellation resume safely. */
export type AdminProviderSetupProgress = Readonly<{
  phase: (typeof ADMIN_PROVIDER_SETUP_PHASES)[number];
  completed: number;
  total: number | null;
  connectionId?: string;
  credentialId?: string;
  runId?: string;
  capability?: AdminProviderCapabilityCheck;
}>;

export function decodeAdminProviderSetupProgress(value: unknown): AdminProviderSetupProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["completed", "phase", "total", "connectionId", "credentialId", "runId", "capability"].includes(key)) ||
    ["connectionId", "credentialId", "runId"].some((key) => record[key] !== undefined &&
      (typeof record[key] !== "string" || !record[key] || record[key].length > 256 || /[\u0000-\u001f\u007f]/u.test(record[key]))) ||
    (record.capability !== undefined && !["modelAccess", "structuredOutput", "toolCalling", "forcedToolCall", "parallelToolCalls", "vision", "directPdf", "streaming", "embedding", "reranking"].includes(String(record.capability))) ||
    !ADMIN_PROVIDER_SETUP_PHASES.includes(record.phase as AdminProviderSetupProgress["phase"]) ||
    !Number.isSafeInteger(record.completed) || Number(record.completed) < 0 ||
    (record.total !== null && (!Number.isSafeInteger(record.total) ||
      Number(record.total) < 1 || Number(record.total) > 64 || Number(record.completed) > Number(record.total))) ||
    (record.total === null && record.completed !== 0)) return null;
  return record as AdminProviderSetupProgress;
}
