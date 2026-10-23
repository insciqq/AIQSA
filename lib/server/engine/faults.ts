import { isTestModeAllowedEnv } from "../auth/csrf";
import { markProviderStreamDrop } from "../providers/streamDrop";

/**
 * Injected failures for disposable stands only (`AIQSA_TEST_MODE=1` outside
 * production), so the answer-first paths can be proven against a real
 * provider: `model_502_once` refuses a run's first model request with a
 * synthetic HTTP 502 before anything is sent, `stream_drop_once` breaks its
 * first stream after the first text it receives, and `usage_write_fail`
 * makes every usage write of the run fail. Anywhere else the variable is
 * ignored.
 */
export const NATIVE_ENGINE_TEST_FAULTS_ENV = "AIQSA_NATIVE_ENGINE_TEST_FAULTS";

export type EngineTestFault = "model_502_once" | "stream_drop_once" | "usage_write_fail";
const FAULTS: readonly EngineTestFault[] = ["model_502_once", "stream_drop_once", "usage_write_fail"];

export type EngineTestFaults = Readonly<{
  /** True once per run for a one-time fault, always for a lasting one. */
  take(fault: EngineTestFault): boolean;
}>;

export const NO_ENGINE_TEST_FAULTS: EngineTestFaults = Object.freeze({ take: () => false });

/** The faults one run injects; none outside a disposable test-mode stand. */
export function engineTestFaults(env: Record<string, string | undefined>): EngineTestFaults {
  if (!isTestModeAllowedEnv(env)) return NO_ENGINE_TEST_FAULTS;
  const requested = new Set((env[NATIVE_ENGINE_TEST_FAULTS_ENV] ?? "").split(",").map((value) => value.trim())
    .filter((value): value is EngineTestFault => FAULTS.includes(value as EngineTestFault)));
  if (requested.size === 0) return NO_ENGINE_TEST_FAULTS;
  const taken = new Set<EngineTestFault>();
  return {
    take(fault) {
      if (!requested.has(fault)) return false;
      if (fault === "usage_write_fail") return true;
      if (taken.has(fault)) return false;
      taken.add(fault);
      return true;
    }
  };
}

/** A provider's HTTP 502, as transports report it. */
export function syntheticProviderBadGateway(): Error {
  return Object.assign(new Error("Synthetic HTTP 502 from the native engine's test faults"), { status: 502 });
}

/** A stream that broke before its completion event. */
export function syntheticStreamDrop(): Error {
  return markProviderStreamDrop(new Error("synthetic_stream_drop"), "reset");
}
