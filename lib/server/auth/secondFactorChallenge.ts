import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { AuthConfig } from "./config";
import { readCookie } from "./session";

export const SECOND_FACTOR_COOKIE_NAME = "aiqsa_second_factor";
export const SECOND_FACTOR_COOKIE_PATH = "/api/auth/second-factor";
export const SECOND_FACTOR_CHALLENGE_MAX_AGE_SECONDS = 5 * 60;

/** Sign-in methods whose first factor AIQSA verifies itself; only these ask for TOTP. */
export const SECOND_FACTOR_SIGN_IN_METHODS = ["password", "ldap"] as const;

export type SecondFactorSignInMethod = (typeof SECOND_FACTOR_SIGN_IN_METHODS)[number];

const CHALLENGE_KEY_DOMAIN = "aiqsa:second-factor-challenge:v1\0";
const CHALLENGE_TYPE = "aiqsa-second-factor";

/**
 * What a first-factor transaction hands to the challenge. `credential` is the verified
 * password hash (password) or the identity id (LDAP); `factorBinding` is the factor state the
 * decision read. Both reach the cookie only as keyed fingerprints.
 */
export type SecondFactorChallengeSubject = {
  credential: string;
  factorBinding: string;
  identityId: string;
  signInMethod: SecondFactorSignInMethod;
  userId: string;
};

export type VerifiedSecondFactorChallenge = {
  credentialFingerprint: string;
  factorBindingFingerprint: string;
  identityId: string;
  signInMethod: SecondFactorSignInMethod;
  userId: string;
};

export function isSecondFactorSignInMethod(value: unknown): value is SecondFactorSignInMethod {
  return SECOND_FACTOR_SIGN_IN_METHODS.some((method) => method === value);
}

/** Its own key, so neither an OAuth flow cookie nor any other session-secret JWT verifies here. */
function challengeKey(sessionSecret: string): Uint8Array {
  if (!sessionSecret) {
    throw new Error("second_factor_secret_unavailable");
  }

  return createHmac("sha256", sessionSecret).update(CHALLENGE_KEY_DOMAIN, "utf8").digest();
}

function fingerprint(key: Uint8Array, label: string, value: string): string {
  return createHmac("sha256", key).update(label, "utf8").update("\0", "utf8").update(value, "utf8").digest("base64url");
}

function sameFingerprint(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");

  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function signSecondFactorChallenge(
  subject: SecondFactorChallengeSubject,
  input: { now: Date; sessionSecret: string }
): Promise<string> {
  const key = challengeKey(input.sessionSecret);
  const issuedAt = Math.floor(input.now.getTime() / 1000);

  return new SignJWT({
    cf: fingerprint(key, "credential", subject.credential),
    fb: fingerprint(key, "factor", subject.factorBinding),
    iid: subject.identityId,
    m: subject.signInMethod,
    typ: CHALLENGE_TYPE
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(subject.userId)
    .setJti(randomBytes(16).toString("base64url"))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SECOND_FACTOR_CHALLENGE_MAX_AGE_SECONDS)
    .sign(key);
}

export async function verifySecondFactorChallenge(
  token: string,
  input: { now: Date; sessionSecret: string }
): Promise<VerifiedSecondFactorChallenge | null> {
  try {
    const { payload } = await jwtVerify(token, challengeKey(input.sessionSecret), {
      algorithms: ["HS256"],
      currentDate: input.now,
      maxTokenAge: `${SECOND_FACTOR_CHALLENGE_MAX_AGE_SECONDS}s`,
      requiredClaims: ["exp", "iat", "jti", "sub"]
    });

    if (
      payload.typ !== CHALLENGE_TYPE ||
      !isSecondFactorSignInMethod(payload.m) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.iid !== "string" ||
      !payload.iid ||
      typeof payload.cf !== "string" ||
      typeof payload.fb !== "string"
    ) {
      return null;
    }

    return {
      credentialFingerprint: payload.cf,
      factorBindingFingerprint: payload.fb,
      identityId: payload.iid,
      signInMethod: payload.m,
      userId: payload.sub
    };
  } catch {
    return null;
  }
}

/**
 * Whether the account still is what the challenge was issued for: the same password hash (or
 * LDAP identity) and the same factor state. A changed password, a reset or re-enrolled factor,
 * or a second factor already used through this challenge all make it stale.
 */
export function secondFactorChallengeMatches(
  challenge: VerifiedSecondFactorChallenge,
  current: { credential: string; factorBinding: string },
  sessionSecret: string
): boolean {
  const key = challengeKey(sessionSecret);
  const credential = sameFingerprint(fingerprint(key, "credential", current.credential), challenge.credentialFingerprint);
  const factor = sameFingerprint(fingerprint(key, "factor", current.factorBinding), challenge.factorBindingFingerprint);

  return credential && factor;
}

function challengeCookie(value: string, input: { maxAge: number; secure: boolean }): string {
  const attributes = [
    `${SECOND_FACTOR_COOKIE_NAME}=${value}`,
    `Path=${SECOND_FACTOR_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${input.maxAge}`
  ];

  if (input.secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

/** The Set-Cookie a first-factor handler returns instead of a session cookie. */
export async function createSecondFactorChallengeCookie(
  subject: SecondFactorChallengeSubject,
  input: { config: Pick<AuthConfig, "cookieSecure" | "sessionSecret">; now: Date }
): Promise<string> {
  const token = await signSecondFactorChallenge(subject, {
    now: input.now,
    sessionSecret: input.config.sessionSecret
  });

  return challengeCookie(token, { maxAge: SECOND_FACTOR_CHALLENGE_MAX_AGE_SECONDS, secure: input.config.cookieSecure });
}

export function clearSecondFactorChallengeCookie(secure: boolean): string {
  return challengeCookie("", { maxAge: 0, secure });
}

export function readSecondFactorChallengeToken(request: Request): string | undefined {
  return readCookie(request.headers.get("cookie"), SECOND_FACTOR_COOKIE_NAME) || undefined;
}
