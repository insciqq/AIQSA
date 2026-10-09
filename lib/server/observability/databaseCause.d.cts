import type { DatabaseFailureKind } from "./events";
export type { DatabaseFailureKind };
export type DatabaseFailureProjection = Readonly<{ prisma_code?: string; db_failure?: DatabaseFailureKind }>;
export function describeDatabaseFailure(value: unknown): DatabaseFailureProjection;
/** Every fact one link proves itself, or what its boundary remembered for it. */
export type DatabaseLinkFacts = DatabaseFailureProjection & Readonly<{ sqlstate?: string; tx_timeout_ms?: number; tx_elapsed_ms?: number }>;
export function databaseLinkFacts(link: unknown, source?: "own" | "remembered"): DatabaseLinkFacts | null;
export function rememberDatabaseFailure(wrapper: unknown, projection: DatabaseFailureProjection): void;
