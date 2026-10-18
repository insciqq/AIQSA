import { describe, expect, it } from "vitest";
import {
  ADMIN_SIGN_IN_REFUSAL_LIMIT,
  decodeAdminSignInRefusalsResponse,
  type AdminSignInRefusal
} from "./adminSignInRefusals";

const account = { displayName: "Dana Lee", email: "dana@example.com", id: "user-dana", status: "pending" as const };

function refusal(overrides: Record<string, unknown> = {}): AdminSignInRefusal & Record<string, unknown> {
  return {
    attempts: 3,
    code: "not_allowed",
    firstSeenAt: "2026-10-16T06:31:00.000Z",
    id: "refusal-1",
    lastSeenAt: "2026-10-16T06:40:00.000Z",
    method: "yandex",
    subject: { account: null, email: "ana@example.com", kind: "email" },
    ...overrides
  } as AdminSignInRefusal & Record<string, unknown>;
}

function page(refusals: unknown[], overrides: Record<string, unknown> = {}) {
  return { signInRefusals: { generatedAt: "2026-10-18T12:00:00.000Z", refusals, total: refusals.length, truncated: false, ...overrides } };
}

describe("admin refused sign-ins contract", () => {
  it("decodes every subject kind", () => {
    const value = page([
      refusal(),
      refusal({ id: "refusal-2", subject: { account, email: "dana@example.com", kind: "email" } }),
      refusal({ code: "invalid_code", id: "refusal-3", method: "ldap", subject: { account: { ...account, email: null }, kind: "account" } }),
      refusal({ code: "email_missing", id: "refusal-4", method: "oidc", subject: { kind: "no_verified_email" } }),
      refusal({ id: "refusal-5", subject: { kind: "overflow" } })
    ], { total: 9, truncated: true });

    expect(decodeAdminSignInRefusalsResponse(value)).toEqual(value);
  });

  it("drops fields the contract does not carry", () => {
    const decoded = decodeAdminSignInRefusalsResponse(page([
      refusal({ ip: "203.0.113.7", subject: { account: null, email: "ana@example.com", kind: "email", typed: "Ana@Example.com" } })
    ]));

    expect(JSON.stringify(decoded)).not.toMatch(/203\.0\.113\.7|typed/u);
  });

  it.each([
    ["an unknown method", refusal({ method: "github" })],
    ["an unknown reason", refusal({ code: "rate_limited" })],
    ["no attempts", refusal({ attempts: 0 })],
    ["an unreadable time", refusal({ lastSeenAt: "yesterday" })],
    ["an unknown subject", refusal({ subject: { kind: "ip" } })],
    ["an email subject without an email", refusal({ subject: { account: null, kind: "email" } })],
    ["an account subject without its account", refusal({ subject: { kind: "account" } })],
    ["an account with an unknown status", refusal({ subject: { account: { ...account, status: "archived" }, kind: "account" } })]
  ])("rejects a page with %s", (_label, entry) => {
    expect(decodeAdminSignInRefusalsResponse(page([entry]))).toBeNull();
  });

  it("rejects a page longer than the listing limit or with a malformed total", () => {
    expect(decodeAdminSignInRefusalsResponse(page(Array.from({ length: ADMIN_SIGN_IN_REFUSAL_LIMIT + 1 }, (_, index) =>
      refusal({ id: `refusal-${index}` }))))).toBeNull();
    expect(decodeAdminSignInRefusalsResponse(page([refusal()], { total: -1 }))).toBeNull();
    expect(decodeAdminSignInRefusalsResponse({ refusals: [] })).toBeNull();
  });
});
