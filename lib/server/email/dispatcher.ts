import type { AdminEmailAttemptCode } from "../../contracts/email";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { logEmailAttempt } from "./observability";
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
    const confirmed = await repository.recordDeliveryOutcome(input);
    logEvent("job_persistence", { subsystem: "email", stage: "health", outcome: confirmed ? "confirmed" : "not_applied" });
  } catch (error) {
    // Health is observational and must not replace the authoritative delivery outcome.
    logEvent("job_persistence", { subsystem: "email", stage: "health", outcome: "unconfirmed", prisma_code: databaseFailureCode(error) });
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
      const started = performance.now();
      let message: SmtpProductMessage;
      try {
        message = normalizeSmtpProductMessage(candidate);
      } catch {
        logEmailAttempt("smtp_invalid_input", "dispatch", performance.now() - started);
        return { code: "smtp_invalid_input", kind: "failed" };
      }

      // Test mode is the first dispatch decision and cannot observe database SMTP.
      if (input.testCapture) {
        try {
          await input.testCapture.capture(message);
          logEmailAttempt("accepted", "dispatch", performance.now() - started);
          return { kind: "accepted" };
        } catch {
          logEmailAttempt("smtp_connection_failed", "dispatch", performance.now() - started);
          return { code: "smtp_connection_failed", kind: "failed" };
        }
      }

      const loaded = await input.repository.loadActiveForSend().catch((error: unknown) => {
        logEvent("service_operation", { subsystem: "email", stage: "read", outcome: "failed", code: "email_repository_failed", prisma_code: databaseFailureCode(error) });
        throw error;
      });
      if (!loaded.ok) {
        const code = loaded.code === "secret_unreadable"
          ? "secret_unreadable"
          : "invalid_configuration";
        logEmailAttempt(code, "dispatch", performance.now() - started);
        return { code, kind: "failed" };
      }
      if (loaded.value.kind === "unavailable") {
        logEvent("service_operation", { subsystem: "email", stage: "dispatch", outcome: "skipped", code: "not_configured" });
        return { kind: "unavailable" };
      }
      if (loaded.value.kind === "failure") {
        logEmailAttempt(loaded.value.code, "dispatch", performance.now() - started);
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
        logEmailAttempt("overloaded", "dispatch", performance.now() - started);
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
      logEmailAttempt(code, "dispatch", performance.now() - started);
      await recordDeliveryOutcomeBestEffort(input.repository, { activeVersion, at: now(), code });
      return dispatchResult(code);
    }
  };
}
