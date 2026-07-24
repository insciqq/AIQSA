import { describe, expect, it } from "vitest";
import { decryptSecretEnvelope, SecretEnvelopeError } from "../secrets/envelope";
import {
  applySmtpPasswordAction,
  decryptSmtpPassword,
  encryptSmtpPassword,
  normalizeSmtpPasswordAction,
  SMTP_CONTROL_OWNER_ID,
  SMTP_PASSWORD_PURPOSE,
  SmtpPasswordEnvelopeError
} from "./passwordEnvelope";

const KEY = Buffer.alloc(32, 0x42);

function expectActionError(operation: () => unknown): void {
  try {
    operation();
    throw new Error("Expected SMTP password action validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(SmtpPasswordEnvelopeError);
    expect(error).toMatchObject({
      message: "smtp_password_action_invalid",
      name: "SmtpPasswordEnvelopeError"
    });
  }
}

describe("SMTP v2 password envelope", () => {
  it("binds ciphertext to the fixed singleton, purpose, and generation", () => {
    const envelope = encryptSmtpPassword({
      generation: 7,
      key: KEY,
      password: "smtp-password"
    });

    expect(envelope).toMatch(/^v2\./u);
    expect(envelope).not.toContain("smtp-password");
    expect(decryptSmtpPassword({ envelope, generation: 7, key: KEY })).toBe("smtp-password");
    expect(() => decryptSmtpPassword({ envelope, generation: 8, key: KEY })).toThrow(
      "secret_encryption_invalid_envelope"
    );
    expect(() => decryptSecretEnvelope(envelope, KEY, {
      ownerId: "another-installation",
      purpose: SMTP_PASSWORD_PURPOSE,
      valueId: "7"
    })).toThrow(SecretEnvelopeError);
    expect(() => decryptSecretEnvelope(envelope, KEY, {
      ownerId: SMTP_CONTROL_OWNER_ID,
      purpose: "provider_credential",
      valueId: "7"
    })).toThrow(SecretEnvelopeError);
  });

  it("preserves the exact tested reference, clears only with confirmation, and replaces at a newer generation", () => {
    const current = {
      envelope: encryptSmtpPassword({ generation: 3, key: KEY, password: "old-password" }),
      generation: 3
    };

    expect(applySmtpPasswordAction({
      action: { kind: "preserve" },
      current,
      key: KEY
    })).toEqual(current);
    expect(applySmtpPasswordAction({
      action: { confirm: true, kind: "clear" },
      current,
      key: KEY
    })).toBeNull();

    const replacement = applySmtpPasswordAction({
      action: { kind: "replace", password: "new-password" },
      current,
      key: KEY,
      replacementGeneration: 9
    });
    expect(replacement).toMatchObject({ generation: 9 });
    expect(replacement?.envelope).not.toBe(current.envelope);
    expect(decryptSmtpPassword({
      envelope: replacement?.envelope ?? "",
      generation: replacement?.generation ?? 0,
      key: KEY
    })).toBe("new-password");
  });

  it("rejects ambiguous empty replacement, unconfirmed clear, extra fields, and generation reuse", () => {
    for (const action of [
      { kind: "replace", password: "" },
      { kind: "clear" },
      { confirm: false, kind: "clear" },
      { kind: "preserve", password: "hidden" }
    ]) {
      expectActionError(() => normalizeSmtpPasswordAction(action));
    }

    const current = {
      envelope: encryptSmtpPassword({ generation: 4, key: KEY, password: "old-password" }),
      generation: 4
    };
    expect(() => applySmtpPasswordAction({
      action: { kind: "replace", password: "new-password" },
      current,
      key: KEY,
      replacementGeneration: 4
    })).toThrow("smtp_password_reference_invalid");
  });
});

