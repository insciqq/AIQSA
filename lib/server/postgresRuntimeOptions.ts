export const AIQSA_POSTGRES_RUNTIME_OPTIONS_VERSION =
  "aiqsa-postgres-runtime-options-v1";

const jitOffPattern = /(?:^|\s)(?:-c\s*)?jit\s*=\s*off(?:\s|$)/iu;

export function aiqsaPostgresRuntimeOptions(current: string | undefined): string {
  const normalized = current?.trim() ?? "";
  if (jitOffPattern.test(normalized)) return normalized;
  return `${normalized}${normalized ? " " : ""}-c jit=off`;
}
