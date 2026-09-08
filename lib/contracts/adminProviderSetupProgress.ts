export const ADMIN_PROVIDER_SETUP_STREAM_TYPE = "application/x-ndjson";

export const ADMIN_PROVIDER_SETUP_PHASES = [
  "validating", "discovering", "checking", "saving", "finishing"
] as const;

/** Request-scoped progress has no credential, endpoint or authority identifiers. */
export type AdminProviderSetupProgress = Readonly<{
  phase: (typeof ADMIN_PROVIDER_SETUP_PHASES)[number];
  completed: number;
  total: number | null;
}>;

export function decodeAdminProviderSetupProgress(value: unknown): AdminProviderSetupProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "completed,phase,total" ||
    !ADMIN_PROVIDER_SETUP_PHASES.includes(record.phase as AdminProviderSetupProgress["phase"]) ||
    !Number.isSafeInteger(record.completed) || Number(record.completed) < 0 ||
    (record.total !== null && (!Number.isSafeInteger(record.total) ||
      Number(record.total) < 1 || Number(record.total) > 64 || Number(record.completed) > Number(record.total))) ||
    (record.total === null && record.completed !== 0)) return null;
  return record as AdminProviderSetupProgress;
}
