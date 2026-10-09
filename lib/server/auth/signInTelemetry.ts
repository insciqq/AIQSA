import { logEvent } from "../observability";
import type { SignInOutcome, SignInStep, SignInTelemetryMethod } from "../observability/events";
import signInCodeLevels from "../observability/signInCodes.json";

/** A closed sign-in outcome code; signInCodes.json gives the level a step ending on it logs at. */
export type SignInCode = keyof typeof signInCodeLevels;

/** A method's own content-free code, or `sign_in_failed` for any value outside the closed list. */
export function signInCode(value: string): SignInCode {
  return Object.hasOwn(signInCodeLevels, value) ? (value as SignInCode) : "sign_in_failed";
}

/** One call of a sign-in step's handler, which classifies how it ended. */
export type SignInAttempt = {
  /** The method, set by a step that learns it late (a second factor from its challenge). */
  method: SignInTelemetryMethod | undefined;
  /**
   * How the step ended, returning `result` unchanged. The first classification counts; the record
   * is written once the handler has returned, so its duration covers response floors.
   */
  end<T>(result: T, outcome: SignInOutcome, code: SignInCode, error?: unknown): T;
  /** A step that does not end the attempt (a redirect to the IdP): a later step records it. */
  handOff<T>(result: T): T;
};

type Ending = Readonly<{ code: SignInCode; error?: unknown; outcome: SignInOutcome }> | "handed_off";

/**
 * Wraps a sign-in step's handler so each call leaves exactly one content-free `sign_in` record:
 * the method, the step, the outcome, a closed code and the duration, never an address, name,
 * subject, group, token or IdP response. A return the handler left unclassified records an
 * unexpected failure; a thrown error records one with the error's projection and propagates
 * unchanged. Recording never alters or fails the response.
 */
export function observeSignInStep<Args extends unknown[]>(
  input: { clock?: () => number; method?: SignInTelemetryMethod; step: SignInStep },
  handler: (attempt: SignInAttempt, ...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  const clock = input.clock ?? (() => performance.now());

  return async (...args) => {
    const startedAt = clock();
    const state: { ending: Ending | null } = { ending: null };
    const attempt: SignInAttempt = {
      end(result, outcome, code, error) {
        state.ending ??= { code, error, outcome };
        return result;
      },
      handOff(result) {
        state.ending ??= "handed_off";
        return result;
      },
      method: input.method
    };
    const record = (final: Ending) => {
      if (final === "handed_off") return;
      try {
        logEvent("sign_in", {
          code: final.code,
          duration_ms: clock() - startedAt,
          error: final.error,
          outcome: final.outcome,
          sign_in_method: attempt.method,
          step: input.step
        });
      } catch { /* Telemetry never changes a sign-in. */ }
    };

    let response: Response;
    try {
      response = await handler(attempt, ...args);
    } catch (error) {
      record({ code: "sign_in_failed", error, outcome: "failed" });
      throw error;
    }
    record(state.ending ?? { code: "sign_in_failed", outcome: "failed" });
    return response;
  };
}
