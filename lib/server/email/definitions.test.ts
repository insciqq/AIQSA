import { describe, expect, it } from "vitest";
import {
  completeSmtpConfiguration,
  normalizeSmtpCompleteConfiguration,
  normalizeSmtpConfiguration,
  normalizeSmtpProductMessage,
  SmtpDefinitionError
} from "./definitions";

const baseConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "password", username: " mailer@example.test " },
  from: { address: "Notify@Example.TEST", displayName: "AIQSA Notifications" },
  host: "SMTP.Example.TEST.",
  port: 587,
  transport: "starttls_required"
} as const;

function expectCode(operation: () => unknown, code: SmtpDefinitionError["code"]): void {
  try {
    operation();
    throw new Error("Expected SMTP definition validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(SmtpDefinitionError);
    expect(error).toMatchObject({ code, message: code, name: "SmtpDefinitionError" });
  }
}

describe("SMTP configuration definitions", () => {
  it("normalizes one bounded non-secret configuration and completes its password pair", () => {
    const configuration = normalizeSmtpConfiguration(baseConfiguration);

    expect(configuration).toEqual({
      allowInternalNetwork: false,
      authentication: { mode: "password", username: "mailer@example.test" },
      from: { address: "Notify@example.test", displayName: "AIQSA Notifications" },
      host: "smtp.example.test",
      port: 587,
      transport: "starttls_required"
    });
    expect(completeSmtpConfiguration({
      configuration,
      password: " mail password "
    })).toMatchObject({
      authentication: {
        mode: "password",
        password: " mail password ",
        username: "mailer@example.test"
      }
    });
  });

  it("requires auth none to have no hidden username or password", () => {
    const configuration = normalizeSmtpConfiguration({
      ...baseConfiguration,
      authentication: { mode: "none" }
    });

    expect(completeSmtpConfiguration({ configuration, password: null })).toMatchObject({
      authentication: { mode: "none" }
    });
    expectCode(
      () => completeSmtpConfiguration({ configuration, password: "hidden" }),
      "smtp_authentication_invalid"
    );
    expectCode(
      () => normalizeSmtpConfiguration({
        ...baseConfiguration,
        authentication: { mode: "none", username: "hidden" }
      }),
      "smtp_authentication_invalid"
    );
    expectCode(
      () => normalizeSmtpCompleteConfiguration({
        ...baseConfiguration,
        authentication: { mode: "password", password: "", username: "mailer" }
      }),
      "smtp_password_invalid"
    );
  });

  it("requires explicit internal approval for credential-free plaintext", () => {
    expectCode(
      () => normalizeSmtpConfiguration({
        ...baseConfiguration,
        authentication: { mode: "none" },
        transport: "plaintext_internal_no_auth"
      }),
      "smtp_internal_approval_required"
    );

    expect(normalizeSmtpConfiguration({
      ...baseConfiguration,
      allowInternalNetwork: true,
      authentication: { mode: "none" },
      transport: "plaintext_internal_no_auth"
    })).toMatchObject({
      allowInternalNetwork: true,
      authentication: { mode: "none" },
      transport: "plaintext_internal_no_auth"
    });
    expectCode(
      () => normalizeSmtpConfiguration({
        ...baseConfiguration,
        allowInternalNetwork: true,
        transport: "plaintext_internal_no_auth"
      }),
      "smtp_authentication_invalid"
    );
  });

  it.each([
    [{ ...baseConfiguration, host: "https://smtp.example.test" }, "smtp_host_invalid"],
    [{ ...baseConfiguration, host: "smtp.example.test\r\nRCPT TO:x" }, "smtp_host_invalid"],
    [{ ...baseConfiguration, port: 0 }, "smtp_port_invalid"],
    [{ ...baseConfiguration, port: 65_536 }, "smtp_port_invalid"],
    [{ ...baseConfiguration, transport: "opportunistic_tls" }, "smtp_transport_invalid"],
    [{
      ...baseConfiguration,
      from: { address: "sender@example.test\r\nBcc:x@example.test", displayName: null }
    }, "smtp_from_invalid"],
    [{
      ...baseConfiguration,
      from: { address: "sender@example.test", displayName: "AIQSA\r\nBcc" }
    }, "smtp_from_invalid"]
  ] as const)("rejects malformed bounded configuration %#", (value, code) => {
    expectCode(() => normalizeSmtpConfiguration(value), code);
  });
});

describe("SMTP product message definitions", () => {
  it("normalizes only a named product message and a bare mailbox recipient", () => {
    expect(normalizeSmtpProductMessage({
      kind: "configuration_test",
      subject: "AIQSA email delivery test",
      text: "First line\r\nSecond line",
      to: "Admin@Example.TEST"
    })).toEqual({
      kind: "configuration_test",
      subject: "AIQSA email delivery test",
      text: "First line\nSecond line",
      to: "Admin@example.test"
    });
  });

  it.each([
    {
      kind: "arbitrary",
      subject: "Unexpected",
      text: "body",
      to: "admin@example.test"
    },
    {
      kind: "verification",
      subject: "Verify\r\nBcc: hidden@example.test",
      text: "body",
      to: "admin@example.test"
    },
    {
      kind: "verification",
      subject: "Verify",
      text: "body",
      to: "admin@example.test\r\nBcc:hidden@example.test"
    }
  ])("rejects an invalid or injectable product message %#", (message) => {
    expectCode(() => normalizeSmtpProductMessage(message), "smtp_message_invalid");
  });
});
