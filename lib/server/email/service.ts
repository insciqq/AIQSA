import type {
  AdminEmailAttemptCode,
  AdminEmailState,
  AdminEmailTestResponse
} from "../../contracts/email";
import {
  normalizeSmtpProductMessage,
  type SmtpProductMessage
} from "./definitions";
import type {
  EmailRepository,
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

export type AdminEmailService = {
  activate(input: {
    actorUserId: string;
    expectedActiveVersion: number;
    expectedDraftVersion: number;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
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
  saveDraft(input: {
    actorUserId: string;
    configuration: unknown;
    expectedDraftVersion: number;
    passwordAction: unknown;
  }): Promise<EmailRepositoryResult<AdminEmailState>>;
  testDraft(input: {
    expectedDraftVersion: number;
    recipient: string;
  }): Promise<EmailRepositoryResult<AdminEmailTestResponse>>;
};

export function createAdminEmailService(input: {
  attemptGate?: SmtpAttemptGate;
  now?: () => Date;
  repository: EmailRepository;
  transport: SmtpTransport;
}): AdminEmailService {
  const now = input.now ?? (() => new Date());
  const attemptGate = input.attemptGate ?? defaultSmtpAttemptGate;

  async function settleTest(
    draftVersion: number,
    code: AdminEmailAttemptCode
  ): Promise<EmailRepositoryResult<AdminEmailTestResponse>> {
    const stored = await input.repository.recordDraftTest({
      at: now(),
      code,
      draftVersion
    });
    return stored.ok
      ? {
          ok: true,
          value: {
            email: stored.value,
            test: { code, tested: code === "accepted" }
          }
        }
      : stored;
  }

  return {
    read: () => input.repository.readAdminState(),

    saveDraft(request) {
      return input.repository.saveDraft({ ...request, now: now() });
    },

    activate(request) {
      return input.repository.activate({ ...request, now: now() });
    },

    enable(request) {
      return input.repository.enable({ ...request, now: now() });
    },

    disable(request) {
      return input.repository.disable({ ...request, now: now() });
    },

    clear(request) {
      return input.repository.clear({ ...request, now: now() });
    },

    async testDraft(request) {
      const snapshot = await input.repository.loadDraftForTest(request.expectedDraftVersion);
      if (!snapshot.ok) return snapshot;

      let message: SmtpProductMessage;
      try {
        message = normalizeSmtpProductMessage({
          kind: "configuration_test",
          subject: TEST_SUBJECT,
          text: TEST_TEXT,
          to: request.recipient
        });
      } catch {
        return settleTest(snapshot.value.draftVersion, "smtp_invalid_input");
      }

      const release = attemptGate.tryAcquire();
      if (!release) return settleTest(snapshot.value.draftVersion, "overloaded");

      let code: AdminEmailAttemptCode;
      try {
        const outcome = await input.transport.send({
          configuration: snapshot.value.configuration,
          message
        });
        code = outcomeCode(outcome);
      } catch {
        code = "smtp_connection_failed";
      } finally {
        release();
      }
      return settleTest(snapshot.value.draftVersion, code);
    }
  };
}

