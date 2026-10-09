import { describe, expect, it } from "vitest";
import { hashToken } from "./token";
import {
  createAuthSession, createRequestAuthResolver, resolveAuthToken, revokeRequestSession, type RequestAuthResolver
} from "./requestAuth";
import { getAuthConfig, TEST_AUTH_TOKEN } from "./config";
import { runHttpHandler, TRACE_HEADER } from "../observability/http.cjs";
import { createTelemetryAggregator } from "../telemetry/aggregator";
import { createMemoryAuthSessionStore, createTestUser } from "@/tests/support/auth";
import { captureRunObservation } from "@/tests/support/runObservation";

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
});

describe("request attribution", () => {
  it("names the session's user on its own request's failure incidents and no user without a session", async () => {
    const observation = await captureRunObservation();
    const signIn = async (userId: string) => {
      const sessions = createMemoryAuthSessionStore({ user: createTestUser({ id: userId }) });
      const created = await createAuthSession({ secureCookie: false, sessions, userId });
      return { cookie: created.cookie, resolve: createRequestAuthResolver({ getConfig: () => config, sessions }) };
    };
    const alice = await signIn("11111111-1111-4111-8111-111111111111");
    const bob = await signIn("22222222-2222-4222-8222-222222222222");
    const failing = (resolve: RequestAuthResolver, cookie?: string) => runHttpHandler(
      new Request("http://app.local/api/chats", { method: "POST", ...(cookie ? { headers: { cookie } } : {}) }),
      async (request) => {
        await resolve(request);
        throw new TypeError("PRIVATE_FAILURE_CANARY");
      }
    );
    const [aliceResponse, bobResponse, anonymousResponse] = await Promise.all([
      failing(alice.resolve, alice.cookie), failing(bob.resolve, bob.cookie), failing(alice.resolve)
    ]);

    const aggregator = createTelemetryAggregator();
    for (const record of observation.records()) aggregator.observe(Object.freeze(record));
    const { counters, incidents } = aggregator.drain();
    expect(new Map(incidents.map((incident) => [incident.traceId, incident.userId]))).toEqual(new Map([
      [aliceResponse!.headers.get(TRACE_HEADER), "11111111-1111-4111-8111-111111111111"],
      [bobResponse!.headers.get(TRACE_HEADER), "22222222-2222-4222-8222-222222222222"],
      [anonymousResponse!.headers.get(TRACE_HEADER), null]
    ]));
    expect(incidents.every((incident) => incident.event === "http.request_failed" && !("user_id" in incident.details))).toBe(true);
    expect(JSON.stringify(counters)).not.toMatch(/11111111|22222222/u);
    expect(JSON.stringify(incidents)).not.toContain("PRIVATE_FAILURE_CANARY");
  });
});
