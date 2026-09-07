import type { AdminEmailConfiguration, AdminEmailState } from "@/lib/contracts/email";
import { describe, expect, it } from "vitest";
import {
  emailDeliveryStatus,
  emailDraftFrom,
  emailFormDirty,
  emailFormEdits,
  emailFormFrom,
  emailFormValidation,
  emailFormWithTransport
} from "./emailView";

const bannedWords = /\bdraft\b|revision|pending|probe|evidence|adapter|fingerprint|\bversion\b/iu;

const configuration: AdminEmailConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "password", username: "mailer@example.com" },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.example.com",
  port: 587,
  transport: "starttls_required"
};

function state(overrides: Partial<AdminEmailState> = {}): AdminEmailState {
  return {
    active: {
      activatedAt: "2026-07-23T12:00:00.000Z",
      activatedByUserId: "admin-1",
      configuration,
      enabled: true,
      passwordConfigured: true,
      version: 7
    },
    configurationUpdatedAt: "2026-07-23T12:05:00.000Z",
    configurationUpdatedByUserId: "admin-1",
    draft: { configuration, passwordConfigured: true, test: null, version: 8 },
    health: {
      activeVersion: 7,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    },
    ...overrides
  };
}

describe("emailDeliveryStatus", () => {
  it("names the four delivery states with where mail goes out from", () => {
    const working = emailDeliveryStatus(state());
    expect(working).toMatchObject({ detail: null, label: "Working", tone: "ok" });
    expect(working.summary).toBe("Delivering from noreply@example.com via smtp.example.com:587 (STARTTLS).");

    const email = state();
    expect(emailDeliveryStatus({ ...email, active: { ...email.active, enabled: false } })).toMatchObject({
      label: "Disabled",
      tone: "neutral"
    });
    expect(emailDeliveryStatus({
      ...email,
      active: { ...email.active, configuration: null, enabled: false }
    })).toMatchObject({ label: "Not configured", tone: "neutral" });

    const failing = emailDeliveryStatus({
      ...email,
      health: {
        ...email.health,
        degraded: true,
        lastFailureAt: "2026-07-23T12:07:00.000Z",
        lastFailureCode: "smtp_command_timeout"
      }
    });
    expect(failing).toMatchObject({ label: "Failing", tone: "critical" });
    expect(failing.detail).toContain("Last delivery failed: The mail server stopped responding.");
  });

  it("reports the last test outcome only for the current settings and in plain words", () => {
    const email = state();
    const failed = emailDeliveryStatus({
      ...email,
      draft: {
        ...email.draft,
        configuration: { ...configuration, host: "smtp-next.example.com" },
        test: { attemptedAt: "2026-07-23T12:06:00.000Z", code: "smtp_authentication_failed", tested: false, version: 8 }
      }
    });
    expect(failed.label).toBe("Working");
    expect(failed.detail).toContain("Last test failed: The mail server rejected the username or password.");
    expect(`${failed.summary} ${failed.detail}`).not.toMatch(bannedWords);

    const stale = emailDeliveryStatus({
      ...email,
      draft: {
        ...email.draft,
        test: { attemptedAt: "2026-07-23T12:06:00.000Z", code: "accepted", tested: true, version: 7 }
      }
    });
    expect(stale.detail).toBeNull();
  });
});

describe("email form", () => {
  it("seeds from the last stored settings without the password and tracks only stored fields as edits", () => {
    const form = emailFormFrom(state(), "admin@example.com");
    expect(form).toMatchObject({
      authenticationMode: "password",
      fromAddress: "noreply@example.com",
      fromName: "AIQSA",
      host: "smtp.example.com",
      password: "",
      plaintextAcknowledged: false,
      port: "587",
      testRecipient: "admin@example.com",
      username: "mailer@example.com"
    });
    expect(emailFormDirty(form, form)).toBe(false);
    expect(emailFormDirty({ ...form, testRecipient: "other@example.com", plaintextAcknowledged: true }, form)).toBe(false);
    expect(emailFormDirty({ ...form, password: "typed" }, form)).toBe(true);
    expect(emailFormDirty({ ...form, host: "smtp2.example.com" }, form)).toBe(true);
    expect(emailFormEdits({ ...form, host: "smtp2.example.com", port: "2525", testRecipient: "x@example.com" }, form))
      .toEqual({ host: "smtp2.example.com", port: "2525" });

    const empty = emailFormFrom(state({
      active: { activatedAt: null, activatedByUserId: null, configuration: null, enabled: false, passwordConfigured: false, version: 0 },
      draft: { configuration: null, passwordConfigured: false, test: null, version: 0 }
    }), "");
    expect(empty).toMatchObject({ fromName: "AIQSA", port: "587", transport: "starttls_required" });
  });

  it("swaps the default port with the transport and strips sign-in for an unencrypted relay", () => {
    const form = emailFormFrom(state(), "");
    expect(emailFormWithTransport(form, "implicit_tls")).toMatchObject({ port: "465", transport: "implicit_tls" });
    expect(emailFormWithTransport({ ...form, port: "2525" }, "implicit_tls").port).toBe("2525");
    expect(emailFormWithTransport({ ...form, password: "typed", plaintextAcknowledged: true }, "plaintext_internal_no_auth"))
      .toMatchObject({ authenticationMode: "none", password: "", plaintextAcknowledged: false, port: "25" });
  });

  it("validates inline: required fields, the password unless one is stored, and the unencrypted relay gates", () => {
    const form = emailFormFrom(state(), "admin@example.com");
    expect(emailFormValidation(form, true)).toEqual({});
    expect(emailFormValidation(form, false)).toEqual({ password: "Enter the password." });
    expect(emailFormValidation({ ...form, host: " ", port: "70000", fromAddress: "nope", testRecipient: "", username: "" }, true))
      .toEqual({
        fromAddress: "Enter the sender address.",
        host: "Enter the mail server host name.",
        port: "Enter a port between 1 and 65535.",
        testRecipient: "Enter the address that receives the test message.",
        username: "Enter the username."
      });

    const plaintext = emailFormWithTransport(form, "plaintext_internal_no_auth");
    expect(Object.keys(emailFormValidation(plaintext, true)).sort()).toEqual(["allowInternalNetwork", "plaintextAcknowledged"]);
    expect(emailFormValidation({ ...plaintext, allowInternalNetwork: true, plaintextAcknowledged: true }, true)).toEqual({});
  });

  it("sends the password only when typed and clears it explicitly for no sign-in", () => {
    const email = state();
    const form = emailFormFrom(email, "admin@example.com");
    expect(emailDraftFrom(form, email)).toEqual({
      configuration,
      expectedDraftVersion: 8,
      passwordAction: { kind: "preserve" }
    });
    expect(emailDraftFrom({ ...form, password: "new-secret", fromName: " " }, email)).toMatchObject({
      configuration: { from: { address: "noreply@example.com", displayName: null } },
      passwordAction: { kind: "replace", password: "new-secret" }
    });
    expect(emailDraftFrom({ ...form, authenticationMode: "none" }, email)).toMatchObject({
      configuration: { authentication: { mode: "none" } },
      passwordAction: { confirm: true, kind: "clear" }
    });
  });
});
