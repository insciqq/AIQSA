import type { DatabaseFailureKind } from "./events";
export type { DatabaseFailureKind };
export type DatabaseFailureProjection = Readonly<{ prisma_code?: string; db_failure?: DatabaseFailureKind }>;
export function describeDatabaseFailure(value: unknown): DatabaseFailureProjection;
export function rememberDatabaseFailure(wrapper: unknown, projection: DatabaseFailureProjection): void;
