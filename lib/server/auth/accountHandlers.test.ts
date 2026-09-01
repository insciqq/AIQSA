import { describe, expect, it } from "vitest";
import { getAuthConfig } from "./config";
import {
  createChangePasswordHandler,
  createUpdateAccountProfileHandler,
  type AccountProfileRecord,
  type PasswordChangeRepository
} from "./accountHandlers";
import { createFixedWindowLoginRateLimiter } from "./rateLimit";
import { createTestAuth } from "@/tests/support/auth";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });

function profile(overrides: Partial<AccountProfileRecord> = {}): AccountProfileRecord {
  return {
    displayName: "Local Operator",
    email: "operator@aiqsa.local",
    hasPassword: true,
    role: "admin",
    ...overrides
  };
}

function jsonRequest(path: string, method: string, body: unknown, cookie = auth.cookie): Request {
  return new Request(`http://localhost${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie },
    method
  });
}

function passwordRepository(input: {
  changed?: boolean;
  identity?: { id: string; passwordHash: string | null } | null;
}) {
  const calls: unknown[] = [];
  const repository: PasswordChangeRepository = {
    async changePassword(change) {
      calls.push(change);
      return input.changed ?? true;
    },
    async findPasswordIdentityByUserId() {
      return input.identity === undefined ? { id: "identity-1", passwordHash: "hash-current" } : input.identity;
    }
  };
  return { calls, repository };
}

const verifyPassword = async (password: string, hash: string | null | undefined) =>
  hash === "hash-current" && password === "current-secret-1";
const passwordHasher = async (password: string) => `hash:${password}`;

describe("account profile handlers", () => {
  it("normalizes and bounds the display name, and refuses anonymous updates", async () => {
    const anonymous = createUpdateAccountProfileHandler({
      repository: { updateDisplayName: async () => profile() },
      resolveAuth: auth.resolveAuth
    });
    expect((await anonymous(jsonRequest("/api/me", "PATCH", { displayName: "Ada" }, ""))).status).toBe(401);
    let saved: string | null = null;
    const PATCH = createUpdateAccountProfileHandler({
      repository: {
        updateDisplayName: async (_userId, displayName) => {
          saved = displayName;
          return profile({ displayName });
        }
      },
      resolveAuth: auth.resolveAuth
    });
    expect((await PATCH(jsonRequest("/api/me", "PATCH", { displayName: "   " }))).status).toBe(400);
    expect((await PATCH(jsonRequest("/api/me", "PATCH", { displayName: "x".repeat(81) }))).status).toBe(400);
    expect(saved).toBeNull();
    const response = await PATCH(jsonRequest("/api/me", "PATCH", { displayName: "  Local   Operator " }));
    expect(response.status).toBe(200);
    expect(saved).toBe("Local Operator");
    await expect(response.json()).resolves.toMatchObject({ user: { displayName: "Local Operator" } });
  });
});

describe("password change handler", () => {
  function handler(input: Parameters<typeof passwordRepository>[0] = {}, rateLimiter = createFixedWindowLoginRateLimiter()) {
    const { calls, repository } = passwordRepository(input);
    const POST = createChangePasswordHandler({
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      passwordHasher,
      rateLimiter,
      repository,
      resolveAuth: auth.resolveAuth,
      verifyPassword
    });
    return { calls, POST };
  }

  it("requires a session, both passwords, and a valid new password", async () => {
    const { calls, POST } = handler();
    expect((await POST(jsonRequest("/api/me/password", "POST", { currentPassword: "a", newPassword: "b" }, ""))).status).toBe(401);
    expect((await POST(jsonRequest("/api/me/password", "POST", { currentPassword: "current-secret-1" }))).status).toBe(400);
    const weak = await POST(jsonRequest("/api/me/password", "POST", { currentPassword: "current-secret-1", newPassword: "short" }));
    expect(weak.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refuses external-provider-only accounts and wrong current passwords without revealing which", async () => {
    const external = handler({ identity: null });
    const missing = await external.POST(jsonRequest("/api/me/password", "POST", {
      currentPassword: "current-secret-1",
      newPassword: "next-secret-22"
    }));
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toEqual({ error: "password_not_set" });

    const { calls, POST } = handler();
    const wrong = await POST(jsonRequest("/api/me/password", "POST", {
      currentPassword: "not-the-current",
      newPassword: "next-secret-22"
    }));
    expect(wrong.status).toBe(403);
    await expect(wrong.json()).resolves.toEqual({ error: "current_password_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("rotates the hash with compare-and-set and keeps only the current session", async () => {
    const { calls, POST } = handler();
    const unchanged = await POST(jsonRequest("/api/me/password", "POST", {
      currentPassword: "current-secret-1",
      newPassword: "current-secret-1"
    }));
    expect(unchanged.status).toBe(400);

    const response = await POST(jsonRequest("/api/me/password", "POST", {
      currentPassword: "current-secret-1",
      newPassword: "next-secret-22"
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      {
        expectedPasswordHash: "hash-current",
        identityId: "identity-1",
        keepSessionId: auth.session.id,
        now: new Date("2026-09-01T12:00:00.000Z"),
        passwordHash: "hash:next-secret-22"
      }
    ]);

    const conflict = handler({ changed: false });
    const stale = await conflict.POST(jsonRequest("/api/me/password", "POST", {
      currentPassword: "current-secret-1",
      newPassword: "next-secret-22"
    }));
    expect(stale.status).toBe(409);
  });

  it("rate limits repeated attempts per account", async () => {
    const { POST } = handler({}, createFixedWindowLoginRateLimiter({ maxAttempts: 2 }));
    const attempt = () => POST(jsonRequest("/api/me/password", "POST", {
      currentPassword: "not-the-current",
      newPassword: "next-secret-22"
    }));
    expect((await attempt()).status).toBe(403);
    expect((await attempt()).status).toBe(403);
    expect((await attempt()).status).toBe(429);
  });
});
