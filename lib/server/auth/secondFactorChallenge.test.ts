// @vitest-environment node

import { SignJWT, decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import {
  clearSecondFactorChallengeCookie,
  createSecondFactorChallengeCookie,
  readSecondFactorChallengeToken,
  SECOND_FACTOR_COOKIE_NAME,
  secondFactorChallengeMatches,
  signSecondFactorChallenge,
  verifySecondFactorChallenge,
  type SecondFactorChallengeSubject
} from "./secondFactorChallenge";

const sessionSecret = "challenge-test-session-secret";
const now = new Date("2026-10-08T12:00:00.000Z");
const subject: SecondFactorChallengeSubject = {
  credential: "aiqsa-scrypt-v1$stored-password-hash",
  factorBinding: "1759276800000:58000000:0",
  identityId: "identity-1",
  signInMethod: "password",
  userId: "user-1"
};

function later(seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

describe("second-factor challenge", () => {
  it("carries who and how, never the password hash or factor state in clear", async () => {
    const token = await signSecondFactorChallenge(subject, { now, sessionSecret });
    const claims = decodeJwt(token);

    expect(claims).toMatchObject({ iid: "identity-1", m: "password", sub: "user-1" });
    expect(typeof claims.jti).toBe("string");
    expect(token).not.toContain("scrypt");
    expect(JSON.stringify(claims)).not.toContain(subject.credential);
    expect(JSON.stringify(claims)).not.toContain(subject.factorBinding);
    await expect(verifySecondFactorChallenge(token, { now: later(60), sessionSecret })).resolves.toMatchObject({
      identityId: "identity-1",
      signInMethod: "password",
      userId: "user-1"
    });
  });

  it("expires after five minutes", async () => {
    const token = await signSecondFactorChallenge(subject, { now, sessionSecret });

    await expect(verifySecondFactorChallenge(token, { now: later(299), sessionSecret })).resolves.not.toBeNull();
    await expect(verifySecondFactorChallenge(token, { now: later(301), sessionSecret })).resolves.toBeNull();
  });

  it("refuses another secret, a tampered token and a session-secret JWT of another flow", async () => {
    const token = await signSecondFactorChallenge(subject, { now, sessionSecret });
    const [header, payload, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...decodeJwt(token), sub: "admin-1" })).toString("base64url");
    // An OAuth flow cookie is signed with the raw session secret; it must not pass here.
    const otherFlow = await new SignJWT({ cf: "x", fb: "x", iid: "identity-1", m: "password", typ: "aiqsa-second-factor" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setJti("jti")
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
      .sign(new TextEncoder().encode(sessionSecret));

    await expect(verifySecondFactorChallenge(token, { now, sessionSecret: "another-secret" })).resolves.toBeNull();
    await expect(verifySecondFactorChallenge(`${header}.${forgedPayload}.${signature}`, { now, sessionSecret })).resolves.toBeNull();
    await expect(verifySecondFactorChallenge(`${header}.${payload}.`, { now, sessionSecret })).resolves.toBeNull();
    await expect(verifySecondFactorChallenge(otherFlow, { now, sessionSecret })).resolves.toBeNull();
    await expect(verifySecondFactorChallenge("not-a-jwt", { now, sessionSecret })).resolves.toBeNull();
  });

  it("matches only the same credential and factor state", async () => {
    const challenge = (await verifySecondFactorChallenge(await signSecondFactorChallenge(subject, { now, sessionSecret }), {
      now,
      sessionSecret
    }))!;

    expect(secondFactorChallengeMatches(challenge, subject, sessionSecret)).toBe(true);
    // A password changed between the steps.
    expect(secondFactorChallengeMatches(challenge, { ...subject, credential: "aiqsa-scrypt-v1$new-hash" }, sessionSecret))
      .toBe(false);
    // A second factor already used (or a reset or re-enrolled factor).
    expect(secondFactorChallengeMatches(challenge, { ...subject, factorBinding: "1759276800000:58000001:0" }, sessionSecret))
      .toBe(false);
  });

  it("lives in an HttpOnly cookie scoped to the second-factor route", async () => {
    const cookie = await createSecondFactorChallengeCookie(subject, {
      config: { cookieSecure: true, sessionSecret },
      now
    });

    expect(cookie).toMatch(new RegExp(`^${SECOND_FACTOR_COOKIE_NAME}=[^;]+; `, "u"));
    expect(cookie.split("; ").slice(1)).toEqual([
      "Path=/api/auth/second-factor",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=300",
      "Secure"
    ]);
    expect(clearSecondFactorChallengeCookie(false)).toBe(
      `${SECOND_FACTOR_COOKIE_NAME}=; Path=/api/auth/second-factor; HttpOnly; SameSite=Lax; Max-Age=0`
    );

    const token = cookie.split(";")[0]!.slice(SECOND_FACTOR_COOKIE_NAME.length + 1);
    const request = new Request("http://app.local/api/auth/second-factor", {
      headers: { cookie: `aiqsa_session=s; ${SECOND_FACTOR_COOKIE_NAME}=${token}` }
    });

    expect(readSecondFactorChallengeToken(request)).toBe(token);
    expect(readSecondFactorChallengeToken(new Request("http://app.local/"))).toBeUndefined();
  });
});
