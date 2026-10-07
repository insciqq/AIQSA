// @vitest-environment node

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AUTH_SESSION_SIGN_IN_METHODS } from "@/lib/contracts/authSignInMethods";
import { getAuthConfig } from "./config";
import { createTokenLoginHandler } from "./handlers";
import { createOAuthCallbackHandler, createOAuthStartHandler, OAUTH_FLOW_COOKIE_NAME } from "./oauthHandlers";
import { createPrismaAuthSessionStore } from "./prismaSessions";
import { readCookie } from "./session";
import { decideSessionIssuance, issueSignInSession } from "./signInCompletion";
import { createMemoryAuthSessionStore, createTestUser } from "@/tests/support/auth";

const session = {
  createdByUserAgent: "Completion Test",
  expiresAt: new Date("2026-10-15T00:00:00.000Z"),
  lastSeenAt: new Date("2026-10-08T00:00:00.000Z"),
  tokenHash: "session-token-hash"
};

function sessionTransaction() {
  const create = vi.fn(async (input: { data: object }) => ({ ...input.data, id: "session-1", user: createTestUser() }));

  return { create, tx: { authSession: { create } } };
}

describe("sign-in completion seam", () => {
  it("ends every sign-in method in a session", async () => {
    for (const signInMethod of AUTH_SESSION_SIGN_IN_METHODS) {
      await expect(decideSessionIssuance({} as never, { signInMethod, userId: "user-1" }))
        .resolves.toEqual({ kind: "session" });
    }
  });

  it("records the method on the session it issues", async () => {
    const { create, tx } = sessionTransaction();

    await expect(issueSignInSession(tx as never, { session, signInMethod: "invite", userId: "user-1" }))
      .resolves.toMatchObject({ kind: "session", session: { id: "session-1" } });
    expect(create).toHaveBeenCalledWith({
      data: {
        createdByIp: null,
        createdByUserAgent: "Completion Test",
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        signInMethod: "invite",
        tokenHash: "session-token-hash",
        userId: "user-1"
      },
      include: { user: true }
    });
  });

  it("issues store sessions of a named sign-in through the seam in a transaction", async () => {
    const { create, tx } = sessionTransaction();
    const plainCreate = vi.fn(async (input: { data: object }) => ({ ...input.data, id: "fixture-session" }));
    const prisma = {
      $transaction: vi.fn(async (operation: (client: object) => Promise<unknown>) => operation(tx)),
      authSession: { create: plainCreate }
    };
    const store = createPrismaAuthSessionStore(prisma as unknown as PrismaClient);

    await store.createSession({ ...session, signInMethod: "bootstrap", userId: "user-1" });
    await store.createSession({ ...session, userId: "user-1" });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ signInMethod: "bootstrap", userId: "user-1" })
    }));
    expect(plainCreate).toHaveBeenCalledTimes(1);
    expect(plainCreate.mock.calls[0]![0].data).not.toHaveProperty("signInMethod");
  });

  it("names the bootstrap token as the sign-in method", async () => {
    const user = createTestUser();
    const sessions = createMemoryAuthSessionStore({ user });
    const createSession = vi.spyOn(sessions, "createSession");
    const response = await createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => getAuthConfig({
        AIQSA_AUTH_SESSION_SECRET: "completion-test-secret",
        AIQSA_BOOTSTRAP_AUTH_TOKEN: "completion-test-bootstrap-token",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1"
      }),
      sessions
    })(new Request("http://app.local/api/auth/token", {
      body: JSON.stringify({ token: "completion-test-bootstrap-token" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));

    expect(response.status).toBe(200);
    expect(createSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ signInMethod: "bootstrap", userId: user.id })
    );
  });

  it.each(["google", "yandex"] as const)("names %s as the sign-in method of its callback", async (provider) => {
    const config = getAuthConfig({
      AIQSA_APP_BASE_URL: "https://aiqsa.example",
      AIQSA_AUTH_SESSION_SECRET: "completion-test-secret",
      AIQSA_GOOGLE_OAUTH_CLIENT_ID: "google-client",
      AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      AIQSA_TRUST_PROXY_HEADERS: "1",
      AIQSA_YANDEX_OAUTH_CLIENT_ID: "yandex-client",
      AIQSA_YANDEX_OAUTH_CLIENT_SECRET: "yandex-secret"
    });
    const start = await createOAuthStartHandler({ getConfig: () => config })(
      new Request(`https://aiqsa.example/api/auth/oauth/${provider}`),
      { params: { provider } }
    );
    const flowToken = readCookie(start.headers.get("set-cookie"), OAUTH_FLOW_COOKIE_NAME)!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const sessions = createMemoryAuthSessionStore({ user: createTestUser({ id: "oauth-user" }) });
    const createSession = vi.spyOn(sessions, "createSession");
    const callback = new URL(`https://aiqsa.example/api/auth/oauth/${provider}/callback`);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", state);

    const response = await createOAuthCallbackHandler({
      exchangeCode: async () => ({ displayName: "OAuth User", email: "oauth.user@example.test", providerAccountId: "subject" }),
      getConfig: () => config,
      repository: { settleIdentity: async () => ({ status: "active", userId: "oauth-user" }) },
      sessions
    })(new Request(callback, {
      headers: { cookie: `${OAUTH_FLOW_COOKIE_NAME}=${flowToken}`, "x-forwarded-for": "2001:db8:51::1" }
    }), { params: { provider } });

    expect(response.status).toBe(303);
    expect(createSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ signInMethod: provider, userId: "oauth-user" })
    );
  });
});
