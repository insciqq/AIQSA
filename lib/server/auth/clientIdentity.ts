import { isIP } from "node:net";

const MAX_FORWARDED_FOR_LENGTH = 512;

function canonicalIp(value: string): string | null {
  const trimmed = value.trim();
  const family = isIP(trimmed);

  if (family === 4) {
    return trimmed
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  }

  if (family === 6) {
    try {
      return new URL(`http://[${trimmed}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return null;
    }
  }

  return null;
}

export function getLoginRateLimitKey(
  request: Request,
  trustForwardedFor: boolean,
  trustedProxyCount = trustForwardedFor ? 1 : 0
): string | null {
  if (!trustForwardedFor || trustedProxyCount < 1) {
    return null;
  }

  const value = request.headers.get("x-forwarded-for");

  if (!value || value.length > MAX_FORWARDED_FOR_LENGTH) {
    return null;
  }

  const entries = value.split(",");

  if (entries.length !== trustedProxyCount) {
    return null;
  }

  const chain = entries.map(canonicalIp);

  if (chain.some((entry) => !entry)) {
    return null;
  }

  return `ip:${chain[0]}`;
}
