const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

const ENFORCED_CSP =
  "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'";
const REPORT_ONLY_CSP =
  "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; connect-src 'self' http: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:";

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function optionalBoolean(value: string | undefined): boolean | null {
  const valueNormalized = normalized(value);

  if (TRUE_ENV_VALUES.has(valueNormalized)) {
    return true;
  }

  if (FALSE_ENV_VALUES.has(valueNormalized)) {
    return false;
  }

  return null;
}

function secureDeploymentEnabled(env: Record<string, string | undefined>): boolean {
  const explicitSecure = optionalBoolean(env.AIQSA_COOKIE_SECURE);

  if (explicitSecure !== null) {
    return explicitSecure;
  }

  try {
    return new URL(env.AIQSA_APP_BASE_URL ?? "http://localhost:3000").protocol === "https:";
  } catch {
    return false;
  }
}

export function runtimeSecurityHeaders(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const secureDeployment = secureDeploymentEnabled(env);
  const enforceCsp = normalized(env.NODE_ENV) === "production" && secureDeployment;

  return {
    "Content-Security-Policy": enforceCsp ? ENFORCED_CSP : "",
    "Content-Security-Policy-Report-Only": enforceCsp ? "" : REPORT_ONLY_CSP,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": secureDeployment
      ? "max-age=15552000; includeSubDomains"
      : "",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

export function applyRuntimeSecurityHeaders(
  headers: Headers,
  env: Record<string, string | undefined> = process.env
): void {
  for (const [name, value] of Object.entries(runtimeSecurityHeaders(env))) {
    if (value) {
      headers.set(name, value);
    } else {
      headers.delete(name);
    }
  }
}
