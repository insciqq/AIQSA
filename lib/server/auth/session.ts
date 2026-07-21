import { randomBytes } from "node:crypto";
import { SESSION_COOKIE_NAME } from "./constants";

export { SESSION_COOKIE_NAME };
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type SessionCookieOptions = {
  secure?: boolean;
};

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
}

export function createSessionSetCookie(token: string, options: SessionCookieOptions = {}): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`
  ];

  if (options.secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function createSessionClearCookie(options: SessionCookieOptions = {}): string {
  const attributes = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];

  if (options.secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");

    if (rawKey === name) {
      return rawValue.join("=");
    }
  }

  return undefined;
}

export function getSessionFromRequest(
  request: Request
): string | undefined {
  return readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
}
