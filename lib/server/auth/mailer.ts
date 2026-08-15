import type {
  EmailDispatchResult,
  EmailDispatcher
} from "../email/dispatcher";
import type { SmtpProductMessageKind } from "../email/definitions";

export type AuthEmail = {
  subject: string;
  text: string;
  to: string;
};

export type AuthEmailKind = Exclude<SmtpProductMessageKind, "configuration_test">;

/**
 * AuthMailer is the small injection boundary used by auth handlers.
 *
 * Availability is resolved asynchronously by `send`; there is deliberately no
 * process-start configuration flag.
 */
export type AuthMailer = {
  send(email: AuthEmail, kind?: AuthEmailKind): Promise<EmailDispatchResult | void>;
};

export type AuthMailDelivery =
  | { kind: "accepted" }
  | { kind: "failed"; error: Error }
  | { kind: "unavailable" };

export function createDispatcherAuthMailer(dispatcher: EmailDispatcher): AuthMailer {
  return {
    async send(email, kind) {
      if (!kind) {
        return { code: "smtp_invalid_input", kind: "failed" };
      }
      return dispatcher.send({ ...email, kind });
    }
  };
}

export async function deliverAuthEmail(
  mailer: AuthMailer,
  email: AuthEmail,
  kind: AuthEmailKind
): Promise<AuthMailDelivery> {
  try {
    const result = await mailer.send(email, kind);
    if (!result || result.kind === "accepted") {
      return { kind: "accepted" };
    }
    if (result.kind === "unavailable") {
      return { kind: "unavailable" };
    }
    const code = result.kind === "ambiguous_after_data"
      ? "ambiguous_after_data"
      : result.code;
    return { error: new Error(code), kind: "failed" };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error("email_delivery_failed"),
      kind: "failed"
    };
  }
}
