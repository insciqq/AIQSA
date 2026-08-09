import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import {
  createPrismaMemoryExecutionAdmission,
  type MemoryExecutionAdmission
} from "./admission";
import type { MemoryExecutionAuthorityDependencies } from "./authority";
import {
  createPrismaMemoryExecutionLifecycle,
  type MemoryExecutionLifecycle
} from "./lifecycle";

export type PrismaMemoryExecutionService = Readonly<{
  admission: MemoryExecutionAdmission;
  lifecycle: MemoryExecutionLifecycle;
}>;

/** The only production-facing Memory external-execution boundary. Callers
 * must commit `admission.bind`, win `admission.start`, perform exactly one
 * external operation, and then settle it through `lifecycle`. */
export function createPrismaMemoryExecutionService(
  dependencies: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma
): PrismaMemoryExecutionService {
  return Object.freeze({
    admission: createPrismaMemoryExecutionAdmission(dependencies, client),
    lifecycle: createPrismaMemoryExecutionLifecycle(dependencies, client)
  });
}

export * from "./admission";
export * from "./authority";
export * from "./errors";
export * from "./lifecycle";
export * from "./owner";
export * from "./policy";
export * from "./qualification";
export * from "./roles";
export * from "./snapshot";
