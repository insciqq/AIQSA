import type { AuthEmail, AuthMailer } from "./mailer";

const globalForTestMail = globalThis as unknown as {
  aiqsaTestAuthEmails?: AuthEmail[];
};

function testEmails(): AuthEmail[] {
  globalForTestMail.aiqsaTestAuthEmails ??= [];
  return globalForTestMail.aiqsaTestAuthEmails;
}

export function createTestAuthMailer(): AuthMailer {
  return {
    deliveryConfigured: true,
    async send(email) {
      testEmails().push(email);
    }
  };
}

export function clearTestAuthEmails(): void {
  globalForTestMail.aiqsaTestAuthEmails = [];
}

export function listTestAuthEmails(): AuthEmail[] {
  return [...testEmails()];
}
