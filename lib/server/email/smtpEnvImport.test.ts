import { describe, expect, it, vi } from "vitest";
import {
  importLegacySmtpEnvironment,
  LegacySmtpImportError,
  parseLegacySmtpEnvironment
} from "../../../prisma/scripts/smtp-env-import";
import { decryptSmtpPassword } from "./passwordEnvelope";

describe("legacy SMTP environment import", () => {
  it("treats transport defaults and technical limits alone as unconfigured", () => {
    expect(parseLegacySmtpEnvironment({
      AIQSA_SMTP_COMMAND_TIMEOUT_MS: "15000",
      AIQSA_SMTP_PORT: "587",
      AIQSA_SMTP_STARTTLS: "1"
    })).toBeNull();
  });

  it("maps a complete authenticated STARTTLS configuration", () => {
    expect(parseLegacySmtpEnvironment({
      AIQSA_SMTP_FROM: "AIQSA <mail@example.test>",
      AIQSA_SMTP_HOST: "SMTP.EXAMPLE.TEST.",
      AIQSA_SMTP_PASSWORD: "secret-password",
      AIQSA_SMTP_USER: "mailer@example.test"
    })).toEqual({
      configuration: {
        allowInternalNetwork: false,
        authentication: { mode: "password", username: "mailer@example.test" },
        from: { address: "mail@example.test", displayName: "AIQSA" },
        host: "smtp.example.test",
        port: 587,
        transport: "starttls_required"
      },
      password: "secret-password"
    });
  });

  it("maps implicit TLS and credential-free reviewed plaintext explicitly", () => {
    expect(parseLegacySmtpEnvironment({
      AIQSA_SMTP_FROM: "mail@example.test",
      AIQSA_SMTP_HOST: "smtp.example.test",
      AIQSA_SMTP_SECURE: "1"
    })?.configuration).toMatchObject({ port: 465, transport: "implicit_tls" });
    expect(parseLegacySmtpEnvironment({
      AIQSA_SMTP_FROM: "mail@example.test",
      AIQSA_SMTP_HOST: "smtp.internal",
      AIQSA_SMTP_SECURE: "0",
      AIQSA_SMTP_STARTTLS: "0"
    })?.configuration).toMatchObject({
      allowInternalNetwork: true,
      authentication: { mode: "none" },
      transport: "plaintext_internal_no_auth"
    });
  });

  it.each([
    [{ AIQSA_SMTP_HOST: "smtp.example.test" }, "smtp_env_partial_configuration"],
    [{ AIQSA_SMTP_FROM: "mail@example.test", AIQSA_SMTP_HOST: "smtp.example.test", AIQSA_SMTP_USER: "mailer" }, "smtp_env_partial_credentials"],
    [{ AIQSA_SMTP_FROM: "not-a-mailbox", AIQSA_SMTP_HOST: "smtp.example.test" }, "smtp_env_invalid_from"],
    [{ AIQSA_SMTP_FROM: "mail@example.test", AIQSA_SMTP_HOST: "https://smtp.example.test" }, "smtp_env_invalid_host"],
    [{ AIQSA_SMTP_FROM: "mail@example.test", AIQSA_SMTP_HOST: "smtp.internal", AIQSA_SMTP_PASSWORD: "secret", AIQSA_SMTP_SECURE: "0", AIQSA_SMTP_STARTTLS: "0", AIQSA_SMTP_USER: "mailer" }, "smtp_env_plaintext_credentials_forbidden"]
  ])("rejects partial or invalid input without echoing values", (env, code) => {
    expect(() => parseLegacySmtpEnvironment(env)).toThrowError(
      expect.objectContaining<Partial<LegacySmtpImportError>>({ message: code })
    );
  });

  it("imports one disabled untested v2 draft and skips configured state", async () => {
    const key = Buffer.alloc(32, 0x51);
    const update = vi.fn(async (_input: { data: Record<string, unknown> }) => ({}));
    const empty = {
      activeConfig: null,
      activePasswordEnvelope: null,
      activeSecretGeneration: null,
      activeVersion: 0,
      activatedAt: null,
      activatedByUserId: null,
      configurationUpdatedAt: null,
      configurationUpdatedByUserId: null,
      createdAt: new Date(),
      draftConfig: null,
      draftPasswordEnvelope: null,
      draftSecretGeneration: null,
      draftTestAt: null,
      draftTestCode: null,
      draftTestVersion: null,
      draftVersion: 0,
      enabled: false,
      healthActiveVersion: null,
      id: "installation-smtp",
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      secretGenerationCounter: 0,
      testedDraftVersion: null
    };
    const tx = {
      smtpControl: {
        findUnique: vi.fn(async () => empty),
        update
      }
    };
    await expect(importLegacySmtpEnvironment(tx as never, key, {
      AIQSA_SMTP_FROM: "mail@example.test",
      AIQSA_SMTP_HOST: "smtp.example.test",
      AIQSA_SMTP_PASSWORD: "secret-password",
      AIQSA_SMTP_USER: "mailer"
    })).resolves.toEqual({ imported: true, skippedConfigured: false });

    const data = update.mock.calls[0]?.[0]?.data;
    expect(data).toBeDefined();
    if (!data || typeof data.draftPasswordEnvelope !== "string") {
      throw new Error("Expected an encrypted imported SMTP password.");
    }
    expect(data).toMatchObject({
      draftSecretGeneration: 1,
      draftVersion: 1,
      enabled: false,
      secretGenerationCounter: 1
    });
    expect(data.draftPasswordEnvelope).toMatch(/^v2\./u);
    expect(decryptSmtpPassword({
      envelope: data.draftPasswordEnvelope,
      generation: 1,
      key
    })).toBe("secret-password");

    tx.smtpControl.findUnique.mockResolvedValueOnce({ ...empty, draftVersion: 2 });
    await expect(importLegacySmtpEnvironment(tx as never, key, {
      AIQSA_SMTP_FROM: "mail@example.test",
      AIQSA_SMTP_HOST: "smtp.example.test"
    })).resolves.toEqual({ imported: false, skippedConfigured: true });
  });
});
