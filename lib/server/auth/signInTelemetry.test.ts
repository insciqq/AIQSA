// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { captureSignInRecords, captureSignIns } from "@/tests/support/signInRecords";
import { observeSignInStep, signInCode } from "./signInTelemetry";

const logging = vi.hoisted(() => ({ fail: false }));
vi.mock("../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../observability")>();
  return {
    ...actual,
    logEvent: ((event, fields) => {
      if (logging.fail) throw new Error("logging unavailable");
      actual.logEvent(event, fields);
    }) satisfies typeof actual.logEvent
  };
});

const ok = () => new Response(null, { status: 204 });

describe("sign-in step observation", () => {
  it("writes one record per call when the handler returns, with the step's duration", async () => {
    let now = 1_000;
    const handler = observeSignInStep({ clock: () => now, method: "token", step: "credentials" }, async (attempt, status: number) => {
      now += 250;
      return attempt.end(new Response(null, { status }), "failed", "invalid_credentials");
    });

    const records = await captureSignInRecords(async () => {
      expect((await handler(401)).status).toBe(401);
    });

    expect(records).toEqual([expect.objectContaining({
      code: "invalid_credentials", duration_ms: 250, level: "warn", outcome: "failed", sign_in_method: "token", step: "credentials"
    })]);
  });

  it("keeps the first classification and lets a step name its method late", async () => {
    const handler = observeSignInStep({ step: "second_factor" }, async (attempt) => {
      attempt.method = "ldap";
      attempt.end(null, "failed", "invalid_code");
      return attempt.end(ok(), "succeeded", "accepted");
    });

    await expect(captureSignIns(() => handler())).resolves.toEqual([
      { code: "invalid_code", level: "warn", outcome: "failed", sign_in_method: "ldap", step: "second_factor" }
    ]);
  });

  it("records nothing for a hand-off and an unexpected failure for an unclassified return", async () => {
    const handedOff = observeSignInStep({ method: "saml", step: "start" }, async (attempt) => attempt.handOff(ok()));
    const unclassified = observeSignInStep({ method: "saml", step: "callback" }, async () => ok());

    await expect(captureSignIns(() => handedOff())).resolves.toEqual([]);
    await expect(captureSignIns(() => unclassified())).resolves.toEqual([
      { code: "sign_in_failed", level: "error", outcome: "failed", sign_in_method: "saml", step: "callback" }
    ]);
  });

  it("records a thrown error by its content-free projection and rethrows it unchanged", async () => {
    const failure = new RangeError("PRIVATE_alice@example.test");
    const handler = observeSignInStep({ method: "password", step: "credentials" }, async (attempt) => {
      attempt.end(null, "succeeded", "accepted");
      throw failure;
    });

    const records = await captureSignInRecords(async () => {
      await expect(handler()).rejects.toBe(failure);
    });

    expect(records).toEqual([expect.objectContaining({
      code: "sign_in_failed", error_class: "RangeError", level: "error", outcome: "failed", sign_in_method: "password"
    })]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });

  it("never lets a recording failure change the response", async () => {
    const response = ok();
    const handler = observeSignInStep({ method: "oidc", step: "callback" }, async (attempt) =>
      attempt.end(response, "succeeded", "accepted"));
    logging.fail = true;
    try {
      await expect(handler()).resolves.toBe(response);
    } finally {
      logging.fail = false;
    }
  });

  it("keeps a method's own code only when the closed list has it", () => {
    expect(signInCode("token_exchange_failed")).toBe("token_exchange_failed");
    expect(signInCode("invalid_client: alice@example.test")).toBe("sign_in_failed");
    expect(signInCode("toString")).toBe("sign_in_failed");
  });
});
