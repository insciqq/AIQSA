import type { AuthEmail } from "./mailer";
import type { SmtpProductMessage } from "../email/definitions";

const globalForTestMail = globalThis as unknown as {
  aiqsaTestAuthEmails?: AuthEmail[];
};

function testEmails(): AuthEmail[] {
  globalForTestMail.aiqsaTestAuthEmails ??= [];
  return globalForTestMail.aiqsaTestAuthEmails;
}

export function captureTestAuthEmail(message: SmtpProductMessage): void {
  testEmails().push({
    subject: message.subject,
    text: message.text,
    to: message.to
  });
}

export function clearTestAuthEmails(): void {
  globalForTestMail.aiqsaTestAuthEmails = [];
}

export function listTestAuthEmails(): AuthEmail[] {
  return [...testEmails()];
}
