import type { AdminEmailAttemptCode } from "../../contracts/email";
import { logEvent } from "../observability";

/** The SMTP owner reports the attempt before any observational health write. */
export function logEmailAttempt(code: AdminEmailAttemptCode, stage: "dispatch" | "probe", durationMs: number): void {
  logEvent("service_operation", {
    subsystem: "email", stage, code, duration_ms: durationMs,
    outcome: code === "accepted" ? "completed" : code === "ambiguous_after_data" ? "degraded" : "failed"
  });
}
