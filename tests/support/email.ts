import type { EmailTestCapture } from "@/lib/server/email/dispatcher";
import type { SmtpProductMessage } from "@/lib/server/email/definitions";

export type MemoryEmailCapture = EmailTestCapture & {
  readonly messages: readonly SmtpProductMessage[];
  clear(): void;
};

export function createMemoryEmailCapture(): MemoryEmailCapture {
  const messages: SmtpProductMessage[] = [];
  return {
    capture(message) {
      messages.push(structuredClone(message));
    },
    clear() {
      messages.length = 0;
    },
    get messages() {
      return messages;
    }
  };
}
