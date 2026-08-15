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
    const result = await deliverAuthEmail(failed, email, "password_reset");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error.message).toBe("smtp_tls_failed");
    }
  });

  it("keeps the in-memory double deterministic and value-only", async () => {
    const mailer = createMemoryAuthMailer();
    await expect(deliverAuthEmail(mailer, email, "verification")).resolves.toEqual({
      kind: "accepted"
    });
    expect(mailer.sent).toEqual([email]);
  });
});
