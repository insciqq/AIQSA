import { isSignInOutcomeCode } from "@/lib/contracts/adminSignIn";
import type { AuthSignInMethod } from "@/lib/contracts/authSignInMethods";
import { logEvent } from "../../observability";
import type { ResolvedSignInMethod } from "../signInMethods";
import type { SignInSettingsRepository } from "./repository";

/**
 * Records how one sign-in through an admin-configured method ended, for the method's health
 * line in the admin panel: `accepted`, or a content-free failure code of the method's own
 * (`exchange_failed`, `account_conflict`, ...), never a message, claim or provider response.
 * Environment configurations have no health row. Recording never fails the sign-in.
 */
export type SignInHealthRecorder = (
  method: Pick<ResolvedSignInMethod<AuthSignInMethod>, "activeVersion" | "method" | "source">,
  code: string
) => Promise<void>;

export function createSignInHealthRecorder(input: {
  now?: () => Date;
  repository: Pick<SignInSettingsRepository, "recordHealth">;
}): SignInHealthRecorder {
  const now = input.now ?? (() => new Date());

  return async (method, code) => {
    if (method.source !== "admin" || method.activeVersion === undefined) return;
    const safeCode = isSignInOutcomeCode(code) ? code : "sign_in_failed";
    try {
      await input.repository.recordHealth({
        activeVersion: method.activeVersion,
        at: now(),
        code: safeCode,
        method: method.method
      });
    } catch {
      logEvent("service_operation", { subsystem: "admin", stage: "health", outcome: "degraded", code: "sign_in_health_unrecorded" });
    }
  };
}
