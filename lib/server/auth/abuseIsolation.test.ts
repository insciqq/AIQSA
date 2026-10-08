// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createTestPasswordIdentity } from "@/tests/support/auth";
import { createMemoryAuthMailer } from "@/tests/support/authMailers";
import { createMemoryDurableLoginRateLimitStore } from "@/tests/support/authRateLimit";
import { getAuthConfig } from "./config";
import {
  createPasswordLoginHandler,
  createPasswordResetCompleteHandler,
  createPasswordResetRequestHandler
} from "./handlers";
import type { PasswordAuthRepository, PasswordIdentityRecord } from "./passwordRepository";
import { createDurableLoginRateLimiter } from "./prismaRateLimit";

const config = getAuthConfig({
  AIQSA_APP_BASE_URL: "https://aiqsa.example",
  AIQSA_AUTH_SESSION_SECRET: "abuse-isolation-test-secret",
  AIQSA_TRUST_PROXY_HEADERS: "1",
  AIQSA_TRUSTED_PROXY_COUNT: "1"
});

/** Synthetic accounts whose stored hash is a readable marker, so verification is cheap to count. */
function syntheticDirectory(passwords: Record<string, string>): PasswordAuthRepository {
  const identities = new Map<string, PasswordIdentityRecord>(
    Object.entries(passwords).map(([email, password], index) => [
      email,
      createTestPasswordIdentity({
        id: `identity-${index}`,
        normalizedEmail: email,
        passwordHash: `plain:${password}`,
        user: { id: `user-${index}` }
      })
    ])
  );
  const resetTokens = new Map<string, { consumed: boolean; email: string }>();

  return {
    async completePasswordReset(input) {
      const token = resetTokens.get(input.tokenHash);
      const identity = token && !token.consumed ? identities.get(token.email) : undefined;

      if (!token || !identity) return null;
      token.consumed = true;
      identity.passwordHash = input.passwordHash;
      return { normalizedEmail: identity.normalizedEmail, userId: identity.userId };
    },
    async createPasswordResetToken(input) {
      resetTokens.set(input.tokenHash, { consumed: false, email: input.normalizedEmail });
      return true;
    },
    async createSessionForCurrentPassword(input) {
      const identity = [...identities.values()].find((candidate) => candidate.id === input.identityId);

      return identity?.passwordHash === input.passwordHash ? { kind: "session", user: identity.user } : null;
    },
    async findPasswordIdentityByEmail(email) {
      return identities.get(email) ?? null;
    }
  };
}

describe("synthetic auth abuse scenario", () => {
  it("isolates sources and accounts behind one shared limiter while bounding verification and mail", async () => {
    const office = Array.from({ length: 12 }, (_, index) => `office-${index}@example.test`);
    const repository = syntheticDirectory({
      "attacker@example.test": "attacker-secret",
      "owner@example.test": "owner-secret",
      ...Object.fromEntries(office.map((email) => [email, `${email}-secret`]))
    });
    // The routes share one durable auth limiter, so every key family lives in one store here
    // too, and that store keeps the table's attemptCount >= 1 check.
    const limiter = createDurableLoginRateLimiter({
      clock: () => 0,
      keySecret: () => "abuse-isolation-limiter-secret",
      store: createMemoryDurableLoginRateLimitStore()
    });
    const verifyPassword = vi.fn(async (password: string, hash: string | null | undefined) => hash === `plain:${password}`);
    const mailer = createMemoryAuthMailer();
    const handlers = {
      complete: createPasswordResetCompleteHandler({
        getConfig: () => config,
        loginRateLimiter: limiter,
        now: () => new Date("2026-09-27T00:05:00.000Z"),
        passwordHasher: async (password) => `plain:${password}`,
        repository,
        resetCompleteRateLimiter: limiter
      }),
      login: createPasswordLoginHandler({ getConfig: () => config, loginRateLimiter: limiter, repository, verifyPassword }),
      reset: createPasswordResetRequestHandler({
        getConfig: () => config,
        mailer,
        now: () => new Date("2026-09-27T00:00:00.000Z"),
        repository,
        resetRateLimiter: limiter,
        responseFloorMs: 0
      })
    };
    const post = async (route: keyof typeof handlers, source: string, body: Record<string, string>) => {
      const request = new Request(`https://aiqsa.example/api/auth/${route}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-forwarded-for": source },
        method: "POST"
      });

      return (await handlers[route](request)).status;
    };
    const signIn = (source: string, email: string, password: string) => post("login", source, { email, password });
    const verifications = () => verifyPassword.mock.calls.length;

    // An office behind one NAT address signs everyone in; successes do not fill its budget.
    expect(await signIn("198.51.100.10", office[0]!, "typo")).toBe(401);
    for (const email of office) {
      expect(await signIn("198.51.100.10", email, `${email}-secret`)).toBe(200);
    }

    // An IPv6 attacker rotates through its /64 and logs into its own account between sprays.
    const beforeSpray = verifications();
    const sprays: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const address = `2001:db8:bad:1::${(index + 1).toString(16)}`;

      if (index % 4 === 3) {
        await signIn(address, "attacker@example.test", "attacker-secret");
      } else {
        sprays.push(await signIn(address, office[index % office.length]!, "Winter2026!"));
      }
    }
    expect(sprays.filter((status) => status === 401)).toHaveLength(10);
    // Ten failed guesses plus the three own logins admitted before the budget ran out.
    expect(verifications() - beforeSpray).toBe(13);

    // Four IPv4 sources guess the owner's password: two exhaust their budgets, which reaches
    // the account ceiling, and the other two keep one guess each.
    const beforeGuessing = verifications();
    for (const source of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"]) {
      for (let index = 0; index < 10; index += 1) {
        await signIn(source, "owner@example.test", `guess-${index}`);
      }
    }
    expect(verifications() - beforeGuessing).toBe(22);

    // The same sources flood the owner's reset mail; the mail budget caps what reaches the owner.
    for (const source of ["203.0.113.5", "203.0.113.6", "203.0.113.7"]) {
      for (let index = 0; index < 5; index += 1) {
        expect(await post("reset", source, { email: "owner@example.test" })).toBe(200);
      }
    }
    expect(mailer.sent).toHaveLength(10);
    expect(mailer.sent.every((mail) => mail.to === "owner@example.test")).toBe(true);

    // The owner still signs in from home, still gets the generic reset answer, and any of the
    // flood's links restores access with a new password.
    expect(await signIn("198.51.100.20", "owner@example.test", "owner-secret")).toBe(200);
    expect(await post("reset", "198.51.100.20", { email: "owner@example.test" })).toBe(200);
    expect(mailer.sent).toHaveLength(10);
    const token = new URL(mailer.sent[0]!.text.match(/https:\S+/)![0]).searchParams.get("reset")!;
    expect(await post("complete", "198.51.100.20", { password: "owner-new-secret", token })).toBe(200);
    expect(await signIn("198.51.100.20", "owner@example.test", "owner-new-secret")).toBe(200);
  });
});
