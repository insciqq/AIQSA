// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { trustedHeaderSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import type { ResolvedSignInMethods } from "../signInMethods";
import { trustedHeaderLoginState, trustedHeaderLogoutRedirect } from "./loginPage";

const active: ResolvedSignInMethods = {
  trusted_header: {
    activeVersion: 1,
    config: trustedHeaderSignInConfigSchema.parse({ emailHeader: "Remote-Email" }),
    method: "trusted_header",
    secrets: {},
    source: "admin"
  }
};
const trustedProxy = { clientIdentityMode: "trusted_proxy" as const, configured: true };

function state(input: {
  config?: { clientIdentityMode: "direct_loopback" | "direct_peer" | "invalid" | "trusted_proxy"; configured: boolean };
  methods?: ResolvedSignInMethods;
  params?: Record<string, string>;
  session?: boolean;
} = {}) {
  const hasSession = vi.fn(async () => input.session ?? false);
  return {
    hasSession,
    result: trustedHeaderLoginState({
      config: input.config ?? trustedProxy,
      hasSession,
      methods: input.methods ?? active,
      nextPath: "/c/chat-1",
      params: input.params ?? { next: "/c/chat-1" }
    })
  };
}

describe("login page with trusted-header sign-in", () => {
  it("sends a visitor without a session to the sign-in route with the next path", async () => {
    await expect(state().result).resolves.toEqual({
      login: {},
      redirectTo: "/api/auth/trusted-header?next=%2Fc%2Fchat-1"
    });
  });

  it("stays on the page with ?local=1 so other methods remain reachable", async () => {
    const { hasSession, result } = state({ params: { local: "1" } });
    await expect(result).resolves.toEqual({ login: {}, redirectTo: null });
    expect(hasSession).not.toHaveBeenCalled();
  });

  it.each([
    ["a trusted-header outcome", { trusted_header: "missing" }, { outcome: "missing" }],
    ["an unknown trusted-header value", { trusted_header: "bogus" }, {}],
    ["an OAuth outcome", { oauth: "failed" }, {}],
    ["an invitation", { invite: "token" }, {}],
    ["a password reset", { reset: "token" }, {}],
    ["an email verification", { verify: "token" }, {}]
  ])("stays on the page to show %s", async (_case, params, login) => {
    await expect(state({ params }).result).resolves.toEqual({ login, redirectTo: null });
  });

  it("stays on the page for a visitor who already has a session", async () => {
    await expect(state({ session: true }).result).resolves.toEqual({ login: {}, redirectTo: null });
  });

  it("still redirects after an expired session, since the proxy can sign the visitor in again", async () => {
    await expect(state({ params: { reason: "session_expired" } }).result)
      .resolves.toMatchObject({ redirectTo: "/api/auth/trusted-header?next=%2Fc%2Fchat-1" });
  });

  it.each(["direct_loopback", "direct_peer", "invalid"] as const)(
    "offers nothing in %s mode, even with the method active",
    async (clientIdentityMode) => {
      const { hasSession, result } = state({ config: { clientIdentityMode, configured: true } });
      await expect(result).resolves.toEqual({ redirectTo: null });
      expect(hasSession).not.toHaveBeenCalled();
    }
  );

  it("offers nothing while the method is off", async () => {
    await expect(state({ methods: {} }).result).resolves.toEqual({ redirectTo: null });
  });
});

describe("signing out of a trusted-header session", () => {
  it("lands on the login page kept on screen, and leaves other sessions to their own logout", () => {
    expect(trustedHeaderLogoutRedirect({ appBaseUrl: "https://ai.example.test", signInMethod: "trusted_header" }))
      .toBe("https://ai.example.test/login?local=1");
    expect(trustedHeaderLogoutRedirect({ appBaseUrl: "https://ai.example.test", signInMethod: "oidc" })).toBeNull();
    expect(trustedHeaderLogoutRedirect({ appBaseUrl: "https://ai.example.test", signInMethod: null })).toBeNull();
  });
});
