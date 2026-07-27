import { describe, expect, it } from "vitest";
import { hashToken } from "./token";
import {
  createAuthSession,
  createRequestAuthResolver,
  deleteExpiredSessions,
  resolveAuthToken,
  revokeRequestSession
} from "./requestAuth";
import { getAuthConfig, TEST_AUTH_TOKEN } from "./config";
import { createMemoryAuthSessionStore, createTestUser } from "./testRequestAuth";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: TEST_AUTH_TOKEN,
  AIQSA_AUTH_SESSION_SECRET: "secret"
});

describe("DB-backed request auth", () => {
  it("creates opaque session tokens and stores only their hash", async () => {
    const sessions = createMemoryAuthSessionStore();
    const created = await createAuthSession({
      now: new Date("2026-06-14T00:00:00.000Z"),
      secureCookie: true,
      sessions,
      userId: config.bootstrapUserId
    });

    expect(created.cookie).toContain("Secure");
    expect(created.cookie).toContain("aiqsa_session=");
    expect(sessions.records.has(hashToken(created.token))).toBe(true);
    expect([...sessions.records.values()].some((record) => record.tokenHash === created.token)).toBe(false);
  });

  it("resolves active non-revoked sessions by cookie token hash", async () => {
    const sessions = createMemoryAuthSessionStore();
    const created = await createAuthSession({
      now: new Date("2026-06-14T00:00:00.000Z"),
      secureCookie: false,
      sessions,
      userId: config.bootstrapUserId
    });
    const resolveAuth = createRequestAuthResolver({
      getConfig: () => config,
      now: () => new Date("2026-06-14T00:01:01.000Z"),
      sessions
    });

    const auth = await resolveAuth(
      new Request("http://app.local/api/me", {
        headers: {
          cookie: created.cookie
        }
      })
    );

    expect(auth?.userId).toBe(config.bootstrapUserId);
    expect(sessions.records.get(hashToken(created.token))?.lastSeenAt).toEqual(
      new Date("2026-06-14T00:01:01.000Z")
    );
  });

  it("rejects expired, revoked, and inactive user sessions", async () => {
    const inactiveSessions = createMemoryAuthSessionStore({
      user: createTestUser({ status: "disabled" })
    });
    const expiredSessions = createMemoryAuthSessionStore();
    const revokedSessions = createMemoryAuthSessionStore();
    const inactive = await createAuthSession({
      secureCookie: false,
      sessions: inactiveSessions,
      userId: config.bootstrapUserId
    });
    const expired = await createAuthSession({
      now: new Date("2026-06-01T00:00:00.000Z"),
      secureCookie: false,
      sessions: expiredSessions,
      userId: config.bootstrapUserId
    });
    const revoked = await createAuthSession({
      secureCookie: false,
      sessions: revokedSessions,
      userId: config.bootstrapUserId
    });
    await revokeRequestSession({
      request: new Request("http://app.local/api/auth/logout", {
        headers: {
          cookie: revoked.cookie
        }
      }),
      revokedReason: "logout",
      sessions: revokedSessions
    });

    await expect(resolveAuthToken(inactive.token, { sessions: inactiveSessions })).resolves.toBeNull();
    await expect(
      resolveAuthToken(expired.token, {
        now: new Date("2026-06-20T00:00:00.000Z"),
        sessions: expiredSessions
      })
    ).resolves.toBeNull();
    await expect(resolveAuthToken(revoked.token, { sessions: revokedSessions })).resolves.toBeNull();
  });

  it("revokes the current session and can delete expired rows", async () => {
    const sessions = createMemoryAuthSessionStore();
    const current = await createAuthSession({
      now: new Date("2026-06-01T00:00:00.000Z"),
      secureCookie: false,
      sessions,
      userId: config.bootstrapUserId
    });
    const other = await createAuthSession({
      now: new Date("2026-06-01T00:00:00.000Z"),
      secureCookie: false,
      sessions,
      userId: config.bootstrapUserId
    });

    await expect(
      revokeRequestSession({
        request: new Request("http://app.local/api/auth/logout", {
          headers: {
            cookie: current.cookie
          }
        }),
        revokedReason: "logout",
        sessions
      })
    ).resolves.toBe(1);
    await expect(deleteExpiredSessions({ now: new Date("2026-06-20T00:00:00.000Z"), sessions })).resolves.toBe(2);
    expect(sessions.records.size).toBe(0);
    expect(other.sessionId).toBe("session-2");
  });
});
