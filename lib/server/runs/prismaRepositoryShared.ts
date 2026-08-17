import {
  Prisma,
  type MessageStatus,
  type ModelRunStatus
} from "@prisma/client";
import { decodeSearchPlan } from "../../domain/search";
import {
  ActiveRunConflictError,
  type DurableRunControlRecord
} from "./runRepositoryContract";
import type { ProjectRunRecoveryAuthority } from "./toolLoopPersistence";

export function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const dispatchableModelRunStatuses: ModelRunStatus[] = [
  "streaming",
  "queued",
  "in_progress"
];

export const activeModelRunStatuses: ModelRunStatus[] = [
  "preparing",
  ...dispatchableModelRunStatuses
];

export const activeMessageStatuses: MessageStatus[] = ["streaming", "queued"];

export function acceptedRunStatus(status: ModelRunStatus): DurableRunControlRecord["status"] {
  if (status === "preparing") {
    throw new Error("memory_preparing_run_not_finalized");
  }
  return status;
}

export function projectRunRecoveryAuthority(binding: Readonly<{
  accessRevision: number;
  instructionsRevision: number;
  memoryRevision: number;
  policyRevision: number;
  projectId: string;
  providerAdmissionFingerprint: string | null;
  providerConnectionId: string | null;
  providerModelId: string | null;
  providerRequiresClientTools: boolean;
  providerSearchPlan: unknown;
}> | null): ProjectRunRecoveryAuthority | undefined {
  if (!binding) return undefined;
  const searchPlan = decodeSearchPlan(binding.providerSearchPlan);
  const revisions = [
    binding.accessRevision,
    binding.instructionsRevision,
    binding.memoryRevision,
    binding.policyRevision
  ];
  if (
    revisions.some((revision) => !Number.isSafeInteger(revision) || revision < 0) ||
    !binding.projectId ||
    !binding.providerAdmissionFingerprint ||
    !binding.providerConnectionId ||
    !binding.providerModelId ||
    !searchPlan.ok
  ) {
    throw new Error("project_run_binding_invalid");
  }
  return {
    accessRevision: binding.accessRevision,
    instructionsRevision: binding.instructionsRevision,
    memoryRevision: binding.memoryRevision,
    policyRevision: binding.policyRevision,
    projectId: binding.projectId,
    providerAdmissionFingerprint: binding.providerAdmissionFingerprint,
    providerConnectionId: binding.providerConnectionId,
    providerModelId: binding.providerModelId,
    providerRequiresClientTools: binding.providerRequiresClientTools,
    providerSearchPlan: searchPlan.plan
  };
}

export function runControlRecord(run: {
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  provider: string;
  providerResponseId: string | null;
  status: ModelRunStatus;
}): DurableRunControlRecord {
  return {
    assistantMessageId: run.assistantMessageId,
    chatId: run.chatId,
    id: run.id,
    modelId: run.modelId,
    provider: run.provider,
    providerResponseId: run.providerResponseId,
    status: acceptedRunStatus(run.status)
  };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("ModelRun_one_active_per_chat_idx") ||
    error.message.includes("ModelRun_one_active_per_user_idx") ||
    error.message.includes("Unique constraint failed") ||
    error.message.includes("duplicate key value violates unique constraint")
  );
}

export async function mapActiveRunConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ActiveRunConflictError();
    }

    throw error;
  }
}
