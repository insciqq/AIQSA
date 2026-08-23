import type {
  MemoryDeletionOperation,
  MemoryJobKind,
  Prisma
} from "@prisma/client";

export type MemoryJobDescriptor = Readonly<{
  activeLeafMessageId: string | null;
  attemptCount: number;
  branchGeneration: number | null;
  chatId: string | null;
  id: string;
  idempotencyFingerprint: string;
  kind: MemoryJobKind;
  memoryGenerationSnapshot: number;
  memoryRevisionSnapshot: number;
  pipelineVersion: string;
  sourceHash: string | null;
  sourceMessageId: string | null;
  sourceRevision: number | null;
  stage: string | null;
  userId: string;
}>;

export type MemoryJobClaim = MemoryJobDescriptor & Readonly<{
  claimToken: string;
  leaseExpiresAt: Date;
  recoveredLease: boolean;
}>;

export type MemoryWaitingJob = MemoryJobDescriptor;

export type MemoryDeletionClaim = Readonly<{
  admissionAuthorizationId: string | null;
  admittedActiveLeafMessageId: string | null;
  admittedChatSourceRevision: number | null;
  alsoForgetOriginMemories: boolean | null;
  attemptCount: number;
  claimToken: string;
  id: string;
  leaseExpiresAt: Date;
  memoryGeneration: number;
  operation: MemoryDeletionOperation;
  recoveredLease: boolean;
  resumedFromBlocked: boolean;
  targetId: string;
  targetType: string;
  userId: string;
}>;

export type MemoryJobGateDecision =
  | Readonly<{ status: "READY" }>
  | Readonly<{
      errorCode: string;
      status: "WAITING_FOR_EGRESS_CONSENT" | "STALE" | "CANCELLED";
    }>;

export type MemoryJobApply = (
  tx: Prisma.TransactionClient,
  claim: MemoryJobClaim
) => Promise<void>;

export type MemoryDeletionApply = (
  tx: Prisma.TransactionClient,
  claim: MemoryDeletionClaim
) => Promise<void>;

export type MemoryJobExecutionResult = Readonly<{
  acceptedResultHash: string;
  apply?: MemoryJobApply;
  stage?: string | null;
}>;

export type MemoryDeletionExecutionResult = Readonly<{
  apply?: MemoryDeletionApply;
}>;

export type MemoryJobExecutionContext = Readonly<{
  now: () => Date;
  setStage: (stage: string) => Promise<void>;
  signal: AbortSignal;
}>;

export type MemoryDeletionExecutionContext = Readonly<{
  now: () => Date;
  signal: AbortSignal;
}>;

export type MemoryJobHandler = Readonly<{
  execute: (
    claim: MemoryJobClaim,
    context: MemoryJobExecutionContext
  ) => Promise<MemoryJobExecutionResult>;
  kind: MemoryJobKind;
  preflight: (job: MemoryJobDescriptor) => Promise<MemoryJobGateDecision>;
}>;

export type MemoryDeletionHandler = Readonly<{
  execute: (
    claim: MemoryDeletionClaim,
    context: MemoryDeletionExecutionContext
  ) => Promise<MemoryDeletionExecutionResult>;
  operation: MemoryDeletionOperation;
}>;
