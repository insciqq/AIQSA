import type {
  AdminEmailAttemptCode,
  AdminEmailState,
  AdminEmailTestResponse
} from "../../contracts/email";
import {
  normalizeSmtpProductMessage,
  type SmtpCompleteConfiguration,
  type SmtpProductMessage
} from "./definitions";
import type {
  EmailRepository,
  EmailRepositoryFailureCode,
  EmailRepositoryResult
} from "./repository";
import type { SmtpSendOutcome, SmtpTransport } from "./smtpTransport";

const TEST_SUBJECT = "AIQSA email delivery configuration test";
const TEST_TEXT = [
  "This is an AIQSA email delivery configuration test.",
  "No action is required. This message contains no access or sign-in link."
].join("\n\n");

export class SmtpAttemptGate {
  private active = 0;

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error("smtp_attempt_limit_invalid");
    }
  }

  tryAcquire(): (() => void) | null {
    if (this.active >= this.maximum) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

export const defaultSmtpAttemptGate = new SmtpAttemptGate(4);

function outcomeCode(outcome: SmtpSendOutcome): AdminEmailAttemptCode {
  if (outcome.kind === "accepted") return "accepted";
  if (outcome.kind === "ambiguous_after_data") return "ambiguous_after_data";
  return outcome.code;
}

/**
 * Outcome of `testAndActivate`. `test_failed` means the settings were stored
 * and the message was attempted, but the mail server did not accept it; every
 * other failure code is a repository refusal before or after the send. In all
 * failure cases the previously active configuration is untouched.
 */
export type AdminEmailTestAndActivateResult =
  | { ok: true; value: AdminEmailTestResponse }
  | { ok: false; code: EmailRepositoryFailureCode }
  | { ok: false; code: "test_failed"; value: AdminEmailTestResponse };

export type AdminEmailService = {
  clear(input: {
    actorUserId: string;
    expectedActiveVersion: number;
    expectedDraftVersion: number;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  disable(input: {
    actorUserId: string;
    expectedActiveVersion: number;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  enable(input: {
    actorUserId: string;
    expectedActiveVersion: number;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  read(): Promise<EmailRepositoryResult<AdminEmailState>>;
  testAndActivate(input: {
    actorUserId: string;
    configuration: unknown;
    expectedActiveVersion: number;
    expectedDraftVersion: number;
    passwordAction: unknown;
    testRecipient: string;
  }): Promise<AdminEmailTestAndActivateResult>;
};

export function createAdminEmailService(input: {
  attemptGate?: SmtpAttemptGate;
  now?: () => Date;
  repository: EmailRepository;
  transport: SmtpTransport;
}): AdminEmailService {
  const now = input.now ?? (() => new Date());
  const attemptGate = input.attemptGate ?? defaultSmtpAttemptGate;

  async function attempt(
    configuration: SmtpCompleteConfiguration,
    message: SmtpProductMessage
  ): Promise<AdminEmailAttemptCode> {
    const release = attemptGate.tryAcquire();
    if (!release) return "overloaded";
    try {
      return outcomeCode(await input.transport.send({ configuration, message }));
    } catch {
      return "smtp_connection_failed";
    } finally {
      release();
    }
  }

  return {
    read: () => input.repository.readAdminState(),

    enable(request) {
      return input.repository.enable({ ...request, now: now() });
    },

    disable(request) {
      return input.repository.disable({ ...request, now: now() });
    },

    clear(request) {
      return input.repository.clear({ ...request, now: now() });
    },

    async testAndActivate(request) {
      let message: SmtpProductMessage;
      try {
        message = normalizeSmtpProductMessage({
          kind: "configuration_test",
          subject: TEST_SUBJECT,
          text: TEST_TEXT,
          to: request.testRecipient
        });
      } catch {
        return { ok: false, code: "invalid_configuration" };
      }

      // Refuse before storing or sending anything when the active configuration
      // already moved; the CAS inside `activate` stays the authoritative check.
      const current = await input.repository.readAdminState();
      if (!current.ok) return current;
      if (current.value.active.version !== request.expectedActiveVersion) {
        return { ok: false, code: "active_conflict" };
      }

      const saved = await input.repository.saveDraft({
        actorUserId: request.actorUserId,
        configuration: request.configuration,
        expectedDraftVersion: request.expectedDraftVersion,
        now: now(),
        passwordAction: request.passwordAction
      });
      if (!saved.ok) return saved;
      const draftVersion = saved.value.draft.version;

      const snapshot = await input.repository.loadDraftForTest(draftVersion);
      if (!snapshot.ok) return snapshot;

      const code = await attempt(snapshot.value.configuration, message);
      const recorded = await input.repository.recordDraftTest({ at: now(), code, draftVersion });
      if (!recorded.ok) return recorded;
      if (code !== "accepted") {
        return {
          ok: false,
          code: "test_failed",
          value: { email: recorded.value, test: { code, tested: false } }
        };
      }

      const activated = await input.repository.activate({
        actorUserId: request.actorUserId,
        expectedActiveVersion: request.expectedActiveVersion,
        expectedDraftVersion: draftVersion,
        now: now()
      });
      if (!activated.ok) return activated;
      return {
        ok: true,
        value: { email: activated.value, test: { code: "accepted", tested: true } }
      };
    }
  };
}
