import type { EventFields, ObservabilityContext, ProcessRole, EmergencyFailure, Subsystem, LifecycleStage, SubsystemFailure } from "./events";
import type { Writable } from "node:stream";
export const MAX_RECORD_BYTES: number;
export const MAX_OUTPUT_BYTES: number;
/** A tracked transaction holding its rows longer than this is an error: the foreground request budget. */
export const DB_TRANSACTION_FOREGROUND_BUDGET_MS: number;
/** A tracked transaction holding its rows longer than this warns; a shorter one logs nothing. */
export const DB_TRANSACTION_SLOW_MS: number;
export function createTraceId(): string;
export function getContext(): ObservabilityContext | undefined;
/** Derives a frame from the current one. `user_id` comes only from a server-owned
 * run or job row and wins over the user the root's request authenticated as. */
export function runWithContext<T>(fields: Partial<ObservabilityContext>, fn: () => T): T;
/** A new root frame: its own trace and attribution slot, nothing of the caller's. */
export function runInBackground<T>(fn: () => T): T;
export function bindContext<T extends (...args: never[]) => unknown>(fn: T): T;
/** The current root's request authenticated as this server-resolved user; the
 * first one wins and its records carry the id from now on. */
export function attributeRequestUser(userId: string): void;
export function registerRouteTemplates(paths: Iterable<string>): void;
export function setProcessRole(role: ProcessRole): void;
export function logEvent<E extends keyof EventFields>(event: E, fields: EventFields[E]): void;
export function serializeEvent<E extends keyof EventFields>(event: E, fields: EventFields[E]): string | undefined;
export function createWriter(sink: Writable): { logEvent: typeof logEvent };
export function writeEmergencyFailure(fields: EmergencyFailure): void;
/** A validated record exactly as its JSON line carries it, frozen. */
export type ObservedRecord = Readonly<{
  timestamp: string; level: "info" | "warn" | "error" | "fatal"; event: keyof EventFields;
  role: ProcessRole; app_version: string; instance_id: string;
} & Partial<ObservabilityContext> & Record<string, unknown>>;
/** Sets the single in-process record consumer; `null` turns observation off. */
export function setRecordObserver(observer: ((record: ObservedRecord) => void) | null): void;
export function announceProcess(fields?: Omit<EventFields["process.started"], "node_version">): void;
export function reportSubsystemFailure(fields: SubsystemFailure): void;
export function reportSubsystemHealthy(subsystem: Subsystem, stage: LifecycleStage, scopeId?: string): void;
export function reportReadiness(state: "ready" | "not_ready", code?: string, issueCount?: number): void;
