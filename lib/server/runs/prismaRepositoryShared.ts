import {
  Prisma,
  type MessageStatus,
  type ModelRunStatus
} from "@prisma/client";
import {
  ActiveRunConflictError,
  type DurableRunControlRecord
} from "./runRepositoryContract";

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
