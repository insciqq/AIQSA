export const AIQSA_POSTGRES_RUNTIME_OPTIONS_VERSION =
  "aiqsa-postgres-runtime-options-v1";

const jitOffPattern = /(?:^|\s)(?:-c\s*)?jit\s*=\s*off(?:\s|$)/iu;

export function aiqsaPostgresRuntimeOptions(current: string | undefined): string {
  const normalized = current?.trim() ?? "";
  if (jitOffPattern.test(normalized)) return normalized;
  return `${normalized}${normalized ? " " : ""}-c jit=off`;
}

/** Prisma's Rust engine accepts startup options in the URL, not PGOPTIONS. */
export function aiqsaPostgresRuntimeUrl(current: string | undefined): string | undefined {
  // Keep Prisma's lazy missing-configuration validation for build-time imports.
  if (!current) return current;
  // A value this parser cannot rewrite safely goes to Prisma unchanged, as it
  // did before, without the JIT option: startup never fails here. The URL can
  // hold credentials, so nothing about it is thrown or logged.
  if (current.trim() !== current) return current;
  try {
    if (!["postgres:", "postgresql:"].includes(new URL(current).protocol)) return current;
  } catch {
    return current;
  }

  const fragmentAt = current.indexOf("#");
  const fragment = fragmentAt < 0 ? "" : current.slice(fragmentAt);
  const base = fragmentAt < 0 ? current : current.slice(0, fragmentAt);
  const queryAt = base.indexOf("?");
  let hasOptions = false;
  const query = (queryAt < 0 ? "" : base.slice(queryAt + 1)).split("&").map((part) => {
    const options = new URLSearchParams(`&${part}`).get("options");
    if (options === null) return part;
    hasOptions = true;
    const merged = aiqsaPostgresRuntimeOptions(options);
    if (merged === options.trim()) return part;
    const key = part.split("=", 1)[0];
    return `${key}=${encodeURIComponent(merged)}`;
  }).join("&");

  // Do not reserialize credentials, unrelated parameters, or existing JIT-off options.
  if (hasOptions) return `${base.slice(0, queryAt + 1)}${query}${fragment}`;
  const separator = queryAt < 0 ? "?" : /[?&]$/u.test(base) ? "" : "&";
  return `${base}${separator}options=${encodeURIComponent(aiqsaPostgresRuntimeOptions(undefined))}${fragment}`;
}
