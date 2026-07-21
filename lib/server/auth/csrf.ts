const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

function normalizedEnvValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function truthy(value: string | undefined): boolean {
  return TRUE_ENV_VALUES.has(normalizedEnvValue(value));
}

function originFromUrl(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function parsedOrigin(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isEquivalentLoopbackOrigin(origin: string, allowedOrigin: string): boolean {
  const originUrl = parsedOrigin(origin);
  const allowedUrl = parsedOrigin(allowedOrigin);

  if (!originUrl || !allowedUrl) {
    return false;
  }

  return (
    originUrl.protocol === allowedUrl.protocol &&
    originUrl.port === allowedUrl.port &&
    isLoopbackHostname(originUrl.hostname) &&
    isLoopbackHostname(allowedUrl.hostname)
  );
}

export function isNonLocalRuntimeEnv(env: Record<string, string | undefined>): boolean {
  const appEnv = normalizedEnvValue(env.APP_ENV);

  if (appEnv) {
    return appEnv !== "local";
  }

  return normalizedEnvValue(env.NODE_ENV) === "production";
}

export function isProductionNodeEnv(env: Record<string, string | undefined>): boolean {
  return normalizedEnvValue(env.NODE_ENV) === "production";
}

export function isTestAuthAllowedEnv(env: Record<string, string | undefined>): boolean {
  return (
    env.PLAYWRIGHT_TEST_AUTH === "1" &&
    normalizedEnvValue(env.APP_ENV) === "local" &&
    !isProductionNodeEnv(env)
  );
}

export function isBootstrapLoginPublicEnv(env: Record<string, string | undefined>): boolean {
  return truthy(env.AIQSA_BOOTSTRAP_LOGIN_ENABLED) || isTestAuthAllowedEnv(env);
}

export function isProtectedMutationPath(method: string, pathname: string): boolean {
  if (!["POST", "PATCH", "DELETE", "PUT"].includes(method.toUpperCase())) {
    return false;
  }

  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isAllowedMutationOrigin(input: {
  appBaseUrl?: string;
  origin: string | null;
  requestOrigin: string;
  secFetchSite?: string | null;
}): boolean {
  if (!input.origin) {
    const secFetchSite = input.secFetchSite?.trim().toLowerCase();

    return !secFetchSite || secFetchSite === "same-origin" || secFetchSite === "none";
  }

  const allowedOrigins = new Set([input.requestOrigin]);
  const appOrigin = originFromUrl(input.appBaseUrl);

  if (appOrigin) {
    allowedOrigins.add(appOrigin);
  }

  if (allowedOrigins.has(input.origin)) {
    return true;
  }

  return Array.from(allowedOrigins).some((allowedOrigin) => isEquivalentLoopbackOrigin(input.origin!, allowedOrigin));
}
