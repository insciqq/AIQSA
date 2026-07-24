import type { AdminEmailAttemptCode } from "../../contracts/email";
import {
  normalizeSmtpProductMessage,
  type SmtpProductMessage
} from "./definitions";
import type { EmailRepository } from "./repository";
import {
  defaultSmtpAttemptGate,
  SmtpAttemptGate
} from "./service";
import type {
  SmtpFailureCode,
  SmtpSendOutcome,
  SmtpTransport
} from "./smtpTransport";

export type EmailDispatchResult =
  | { kind: "accepted" }
  | { code: "invalid_configuration" | "overloaded" | "secret_unreadable" | SmtpFailureCode; kind: "failed" }
  | { kind: "ambiguous_after_data" }
  | { kind: "unavailable" };

export type EmailTestCapture = {
  capture(message: SmtpProductMessage): Promise<void> | void;
};

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

export function createCapturedSmtpTransport(capture: EmailTestCapture): SmtpTransport {
  return {
    async send(input) {
      try {
        await capture.capture(normalizeSmtpProductMessage(input.message));
        return { kind: "accepted" };
      } catch {
        return { code: "smtp_connection_failed", kind: "failed" };
      }
    }
  };
}

function codeFromOutcome(outcome: SmtpSendOutcome): AdminEmailAttemptCode {
  if (outcome.kind === "accepted") return "accepted";
  if (outcome.kind === "ambiguous_after_data") return "ambiguous_after_data";
  return outcome.code;
}

function dispatchResult(code: AdminEmailAttemptCode): EmailDispatchResult {
  if (code === "accepted") return { kind: "accepted" };
  if (code === "ambiguous_after_data") return { kind: "ambiguous_after_data" };
  return { code, kind: "failed" } as EmailDispatchResult;
}

async function recordDeliveryOutcomeBestEffort(
  repository: EmailRepository,
  input: Parameters<EmailRepository["recordDeliveryOutcome"]>[0]
): Promise<void> {
  try {
    await repository.recordDeliveryOutcome(input);
  } catch {
    // Health is observational and must not replace the authoritative delivery outcome.
  }
}

export type EmailDispatcher = {
  send(message: SmtpProductMessage): Promise<EmailDispatchResult>;
};

export function createEmailDispatcher(input: {
  attemptGate?: SmtpAttemptGate;
  now?: () => Date;
  repository: EmailRepository;
  testCapture?: EmailTestCapture;
  transport: SmtpTransport;
}): EmailDispatcher {
  const now = input.now ?? (() => new Date());
  const attemptGate = input.attemptGate ?? defaultSmtpAttemptGate;

  return {
    async send(candidate) {
      let message: SmtpProductMessage;
      try {
        message = normalizeSmtpProductMessage(candidate);
      } catch {
        return { code: "smtp_invalid_input", kind: "failed" };
      }

      // Test mode is the first dispatch decision and cannot observe database SMTP.
      if (input.testCapture) {
        try {
          await input.testCapture.capture(message);
          return { kind: "accepted" };
        } catch {
          return { code: "smtp_connection_failed", kind: "failed" };
        }
      }

      const loaded = await input.repository.loadActiveForSend();
      if (!loaded.ok) {
        const code = loaded.code === "secret_unreadable"
          ? "secret_unreadable"
          : "invalid_configuration";
        return { code, kind: "failed" };
      }
      if (loaded.value.kind === "unavailable") return { kind: "unavailable" };
      if (loaded.value.kind === "failure") {
        await recordDeliveryOutcomeBestEffort(input.repository, {
          activeVersion: loaded.value.activeVersion,
          at: now(),
          code: loaded.value.code
        });
        return { code: loaded.value.code, kind: "failed" };
      }

      const activeVersion = loaded.value.activeVersion;
      const release = attemptGate.tryAcquire();
      if (!release) {
        await recordDeliveryOutcomeBestEffort(input.repository, {
          activeVersion,
          at: now(),
          code: "overloaded"
        });
        return { code: "overloaded", kind: "failed" };
      }

      let code: AdminEmailAttemptCode;
      try {
        code = codeFromOutcome(await input.transport.send({
          configuration: loaded.value.configuration,
          message
        }));
      } catch {
        code = "smtp_connection_failed";
      } finally {
        release();
      }
      await recordDeliveryOutcomeBestEffort(input.repository, { activeVersion, at: now(), code });
      return dispatchResult(code);
    }
  };
}
