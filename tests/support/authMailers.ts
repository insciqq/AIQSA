import type { AuthEmail, AuthMailer } from "@/lib/server/auth/mailer";

export function createNoopAuthMailer(): AuthMailer {
  return {
    async send() {
      return { kind: "unavailable" };
    }
  };
}

export function createMemoryAuthMailer(): AuthMailer & { sent: AuthEmail[] } {
  const sent: AuthEmail[] = [];

  return {
    sent,
    async send(email) {
      sent.push(structuredClone(email));
    }
  };
}
