import { describe, expect, it, vi } from "vitest";
import {
  createDispatcherAuthMailer,
  deliverAuthEmail
} from "./mailer";
import {
  createMemoryAuthMailer,
  createNoopAuthMailer
} from "@/tests/support/authMailers";

const email = {
  subject: "Verify your AIQSA email",
  text: "Open the one-time link.",
  to: "person@example.test"
};

describe("auth mail dispatch adapter", () => {
  it("forwards product kind to the runtime dispatcher without a configuration snapshot", async () => {
    const send = vi.fn(async () => ({ kind: "accepted" as const }));
    const mailer = createDispatcherAuthMailer({ send });

    await expect(deliverAuthEmail(mailer, email, "verification")).resolves.toEqual({
      kind: "accepted"
    });
    expect(send).toHaveBeenCalledWith({ ...email, kind: "verification" });
  });

  it("preserves caller-visible unavailable and failure outcomes", async () => {
    await expect(
      deliverAuthEmail(createNoopAuthMailer(), email, "verification")
    ).resolves.toEqual({ kind: "unavailable" });

    const unavailable = createDispatcherAuthMailer({
      send: async () => ({ kind: "unavailable" })
    });
    await expect(deliverAuthEmail(unavailable, email, "invitation")).resolves.toEqual({
      kind: "unavailable"
    });

    const failed = createDispatcherAuthMailer({
      send: async () => ({ code: "smtp_tls_failed", kind: "failed" })
    });
    await expect(deliverAuthEmail(failed, email, "password_reset")).resolves.toEqual({
      code: "smtp_tls_failed", kind: "failed"
    });

    // A thrown transport error never crosses: no message, stack or recipient.
    const thrown = createDispatcherAuthMailer({
      send: async () => { throw new Error(`PRIVATE ${email.to}`); }
    });
    await expect(deliverAuthEmail(thrown, email, "verification")).resolves.toEqual({
      code: "email_delivery_failed", kind: "failed"
    });
  });

  it("keeps the in-memory double deterministic and value-only", async () => {
    const mailer = createMemoryAuthMailer();
    await expect(deliverAuthEmail(mailer, email, "verification")).resolves.toEqual({
      kind: "accepted"
    });
    expect(mailer.sent).toEqual([email]);
  });
});
