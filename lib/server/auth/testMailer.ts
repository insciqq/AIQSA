import type { AuthEmail, AuthMailer } from "./mailer";
import type { EmailTestCapture } from "../email/dispatcher";

const globalForTestMail = globalThis as unknown as {
  aiqsaTestAuthEmails?: AuthEmail[];
};

function testEmails(): AuthEmail[] {
  globalForTestMail.aiqsaTestAuthEmails ??= [];
  return globalForTestMail.aiqsaTestAuthEmails;
}

export function createTestAuthMailer(): AuthMailer {
  return {
    async send(email) {
      testEmails().push(email);
    }
  };
}

export function createTestEmailCapture(): EmailTestCapture {
  return {
    capture(message) {
      testEmails().push({
        subject: message.subject,
        text: message.text,
        to: message.to
      });
    }
  };
}

export function clearTestAuthEmails(): void {
  globalForTestMail.aiqsaTestAuthEmails = [];
}

export function listTestAuthEmails(): AuthEmail[] {
  return [...testEmails()];
}
