const DEFAULT_APP_ORIGIN = "https://aiqsa.invalid";
const FALLBACK_PATH = "/";
const CONTROL_OR_WHITESPACE_PATTERN = /[\u0000-\u001f\u007f\s]/;
const ENCODED_BACKSLASH_PATTERN = /%5c/i;
const SCHEME_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:/;

function appOriginUrl(appOrigin: string): URL {
  try {
    return new URL(appOrigin);
  } catch {
    return new URL(DEFAULT_APP_ORIGIN);
  }
}

export function safeInternalPath(nextPath: string | null | undefined, appOrigin = DEFAULT_APP_ORIGIN): string {
  if (!nextPath) {
    return FALLBACK_PATH;
  }

  if (
    !nextPath.startsWith("/") ||
    nextPath.includes("\\") ||
    ENCODED_BACKSLASH_PATTERN.test(nextPath) ||
    CONTROL_OR_WHITESPACE_PATTERN.test(nextPath) ||
    SCHEME_PATTERN.test(nextPath)
  ) {
    return FALLBACK_PATH;
  }

  if (nextPath.replace(/\\/g, "/").startsWith("//")) {
    return FALLBACK_PATH;
  }

  const origin = appOriginUrl(appOrigin);

  try {
    const resolved = new URL(nextPath, origin);

    if (resolved.origin !== origin.origin) {
      return FALLBACK_PATH;
    }

    return `${resolved.pathname}${resolved.search}${resolved.hash}` || FALLBACK_PATH;
  } catch {
    return FALLBACK_PATH;
  }
}
