import { prisma } from "../prisma";
import { startTelemetryRecorder, type TelemetryRecorder } from "./recorder";

/** The application process records its telemetry and alone prunes the tables. */
export function startDefaultTelemetryRecorder(): TelemetryRecorder {
  return startTelemetryRecorder({ prisma, retention: true });
}
