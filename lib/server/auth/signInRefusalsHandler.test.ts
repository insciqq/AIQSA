// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAdminSignInRefusalsResponse } from "@/lib/contracts/adminSignInRefusals";
import { createTestAuth } from "@/tests/support/auth";
import type { SignInRefusalListRow } from "./signInRefusals";
import { createAdminSignInRefusalsHandler } from "./signInRefusalsHandler";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const admin = createTestAuth({ user: { id: "admin-1", role: "admin" } });
const member = createTestAuth({ token: "member-token", user: { id: "user-1", role: "user" } });
const disabledAdmin = createTestAuth({ token: "disabled-admin-token", user: { id: "admin-2", role: "admin", status: "disabled" } });
const resolveAuth = async (request: Request) =>
  await admin.resolveAuth(request) ?? await member.resolveAuth(request) ?? disabledAdmin.resolveAuth(request);

const dana = { displayName: "Dana Lee", email: "dana@example.com", id: "user-dana", status: "disabled" as const };

function row(overrides: Partial<SignInRefusalListRow> = {}): SignInRefusalListRow {
  return {
    account: null,
    attempts: 2,
    code: "not_allowed",
    email: "ana@example.com",
    firstSeenAt: new Date("2026-10-16T06:31:00.000Z"),
    id: "refusal-1",
    lastSeenAt: new Date("2026-10-16T06:32:00.000Z"),
    method: "yandex",
    subjectKey: "email:ana@example.com",
    userId: null,
    ...overrides
  };
}

function get(cookie = admin.cookie): Request {
  return new Request("http://app.local/api/admin/sign-in/refusals", { headers: { cookie: cookie.split(";")[0]! }, method: "GET" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin refused sign-ins", () => {
  it("lists the last 30 days' refusals with the email or account each names, newest first", async () => {
    const read = vi.fn().mockResolvedValue({
      rows: [
        row(),
        row({ account: dana, email: dana.email, id: "refusal-2", method: "google", subjectKey: `email:${dana.email}` }),
        row({
          account: dana, code: "invalid_credentials", email: null, id: "refusal-3", method: "password",
          subjectKey: `user:${dana.id}`, userId: dana.id
        }),
        row({ email: null, id: "refusal-4", method: "saml", subjectKey: "no_verified_email" }),
        row({ attempts: 7, email: null, id: "refusal-5", method: "google", subjectKey: "overflow" })
      ],
      total: 5
    });
    const response = await createAdminSignInRefusalsHandler({ now: () => NOW, read, resolveAuth })(get());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(read).toHaveBeenCalledExactlyOnceWith({ from: new Date("2026-09-18T12:00:00.000Z"), limit: 500 });
    const body: unknown = await response.json();
    expect(decodeAdminSignInRefusalsResponse(body)).toEqual(body);
    const times = { firstSeenAt: "2026-10-16T06:31:00.000Z", lastSeenAt: "2026-10-16T06:32:00.000Z" };
    expect(body).toEqual({ signInRefusals: {
      generatedAt: NOW.toISOString(),
      refusals: [
        { attempts: 2, code: "not_allowed", id: "refusal-1", method: "yandex", subject: { account: null, email: "ana@example.com", kind: "email" }, ...times },
        { attempts: 2, code: "not_allowed", id: "refusal-2", method: "google", subject: { account: dana, email: dana.email, kind: "email" }, ...times },
        { attempts: 2, code: "invalid_credentials", id: "refusal-3", method: "password", subject: { account: dana, kind: "account" }, ...times },
        { attempts: 2, code: "not_allowed", id: "refusal-4", method: "saml", subject: { kind: "no_verified_email" }, ...times },
        { attempts: 7, code: "not_allowed", id: "refusal-5", method: "google", subject: { kind: "overflow" }, ...times }
      ],
      total: 5,
      truncated: false
    } });
  });

  it("flags a list cut at its limit and leaves out rows it cannot name", async () => {
    const read = vi.fn().mockResolvedValue({
      rows: [
        row(),
        row({ code: "rate_limited", id: "refusal-unknown-code" }),
        row({ account: null, email: null, id: "refusal-gone", method: "password", subjectKey: "user:gone", userId: "gone" })
      ],
      total: 640
    });
    const response = await createAdminSignInRefusalsHandler({ now: () => NOW, read, resolveAuth })(get());

    const body = await response.json() as { signInRefusals: { refusals: { id: string }[]; total: number; truncated: boolean } };
    expect(body.signInRefusals.refusals.map((refusal) => refusal.id)).toEqual(["refusal-1"]);
    expect(body.signInRefusals).toMatchObject({ total: 638, truncated: true });
  });

  it("is for active administrators only", async () => {
    const read = vi.fn();
    const handler = createAdminSignInRefusalsHandler({ now: () => NOW, read, resolveAuth });

    expect((await handler(new Request("http://app.local/api/admin/sign-in/refusals"))).status).toBe(401);
    const forbidden = await handler(get(member.cookie));
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "forbidden" });
    expect((await handler(get(disabledAdmin.cookie))).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers a failed read with a stable code", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const read = vi.fn().mockRejectedValue(new Error("database down"));
    const response = await createAdminSignInRefusalsHandler({ now: () => NOW, read, resolveAuth })(get());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "sign_in_refusals_failed" });
  });
});
