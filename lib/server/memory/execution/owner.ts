import type { Prisma } from "@prisma/client";
import { memoryExecutionFailure } from "./errors";

export type MemoryExecutionOwner =
  | Readonly<{
      memoryJobId: string;
      type: "JOB";
    }>
  | Readonly<{
      retrievalAttemptId: string;
      type: "RETRIEVAL_ATTEMPT";
    }>
  | Readonly<{
      modelRunId: string;
      modelRunToolCallId: string;
      type: "MODEL_RUN_TOOL_CALL";
    }>
  | Readonly<{
      mutationAuthorizationId: string;
      type: "MUTATION_AUTHORIZATION";
    }>
  | Readonly<{
      inboundMcpRequestId: string;
      type: "INBOUND_MCP_REQUEST";
    }>;

type StoredOwnerShape = Readonly<{
  inboundMcpRequestId: string | null;
  memoryJobId: string | null;
  modelRunId: string | null;
  modelRunToolCallId: string | null;
  mutationAuthorizationId: string | null;
  ownerType:
    | "JOB"
    | "INBOUND_MCP_REQUEST"
    | "MODEL_RUN_TOOL_CALL"
    | "MUTATION_AUTHORIZATION"
    | "RETRIEVAL_ATTEMPT";
  retrievalAttemptId: string | null;
}>;

export function isValidMemoryExecutionIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim() === value && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function memoryExecutionOwnerData(owner: MemoryExecutionOwner): {
  inboundMcpRequestId: string | null;
  memoryJobId: string | null;
  modelRunId: string | null;
  modelRunToolCallId: string | null;
  mutationAuthorizationId: string | null;
  ownerType: MemoryExecutionOwner["type"];
  retrievalAttemptId: string | null;
} {
  if (owner.type === "JOB" && isValidMemoryExecutionIdentifier(owner.memoryJobId)) {
    return {
      inboundMcpRequestId: null,
      memoryJobId: owner.memoryJobId,
      modelRunId: null,
      modelRunToolCallId: null,
      mutationAuthorizationId: null,
      ownerType: owner.type,
      retrievalAttemptId: null
    };
  }
  if (
    owner.type === "RETRIEVAL_ATTEMPT" &&
    isValidMemoryExecutionIdentifier(owner.retrievalAttemptId)
  ) {
    return {
      inboundMcpRequestId: null,
      memoryJobId: null,
      modelRunId: null,
      modelRunToolCallId: null,
      mutationAuthorizationId: null,
      ownerType: owner.type,
      retrievalAttemptId: owner.retrievalAttemptId
    };
  }
  if (
    owner.type === "MODEL_RUN_TOOL_CALL" &&
    isValidMemoryExecutionIdentifier(owner.modelRunId) &&
    isValidMemoryExecutionIdentifier(owner.modelRunToolCallId)
  ) {
    return {
      inboundMcpRequestId: null,
      memoryJobId: null,
      modelRunId: owner.modelRunId,
      modelRunToolCallId: owner.modelRunToolCallId,
      mutationAuthorizationId: null,
      ownerType: owner.type,
      retrievalAttemptId: null
    };
  }
  if (
    owner.type === "MUTATION_AUTHORIZATION" &&
    isValidMemoryExecutionIdentifier(owner.mutationAuthorizationId)
  ) {
    return {
      inboundMcpRequestId: null,
      memoryJobId: null,
      modelRunId: null,
      modelRunToolCallId: null,
      mutationAuthorizationId: owner.mutationAuthorizationId,
      ownerType: owner.type,
      retrievalAttemptId: null
    };
  }
  if (
    owner.type === "INBOUND_MCP_REQUEST" &&
    isValidMemoryExecutionIdentifier(owner.inboundMcpRequestId)
  ) {
    return {
      inboundMcpRequestId: owner.inboundMcpRequestId,
      memoryJobId: null,
      modelRunId: null,
      modelRunToolCallId: null,
      mutationAuthorizationId: null,
      ownerType: owner.type,
      retrievalAttemptId: null
    };
  }
  return memoryExecutionFailure("memory_execution_input_invalid");
}

export function memoryExecutionOwnerWhere(
  userId: string,
  owner: MemoryExecutionOwner
): Prisma.MemoryExecutionBindingWhereInput {
  const shape = memoryExecutionOwnerData(owner);
  return {
    inboundMcpRequestId: shape.inboundMcpRequestId,
    memoryJobId: shape.memoryJobId,
    modelRunId: shape.modelRunId,
    modelRunToolCallId: shape.modelRunToolCallId,
    mutationAuthorizationId: shape.mutationAuthorizationId,
    ownerType: shape.ownerType,
    retrievalAttemptId: shape.retrievalAttemptId,
    userId
  };
}

export function storedMemoryExecutionOwner(
  record: StoredOwnerShape
): MemoryExecutionOwner {
  if (
    record.ownerType === "JOB" &&
    record.memoryJobId &&
    record.inboundMcpRequestId === null &&
    record.retrievalAttemptId === null &&
    record.modelRunId === null &&
    record.modelRunToolCallId === null &&
    record.mutationAuthorizationId === null
  ) {
    return { memoryJobId: record.memoryJobId, type: "JOB" };
  }
  if (
    record.ownerType === "RETRIEVAL_ATTEMPT" &&
    record.retrievalAttemptId &&
    record.inboundMcpRequestId === null &&
    record.memoryJobId === null &&
    record.modelRunId === null &&
    record.modelRunToolCallId === null &&
    record.mutationAuthorizationId === null
  ) {
    return { retrievalAttemptId: record.retrievalAttemptId, type: "RETRIEVAL_ATTEMPT" };
  }
  if (
    record.ownerType === "MODEL_RUN_TOOL_CALL" &&
    record.modelRunId &&
    record.modelRunToolCallId &&
    record.inboundMcpRequestId === null &&
    record.memoryJobId === null &&
    record.retrievalAttemptId === null &&
    record.mutationAuthorizationId === null
  ) {
    return {
      modelRunId: record.modelRunId,
      modelRunToolCallId: record.modelRunToolCallId,
      type: "MODEL_RUN_TOOL_CALL"
    };
  }
  if (
    record.ownerType === "MUTATION_AUTHORIZATION" &&
    record.mutationAuthorizationId &&
    record.inboundMcpRequestId === null &&
    record.memoryJobId === null &&
    record.retrievalAttemptId === null &&
    record.modelRunId === null &&
    record.modelRunToolCallId === null
  ) {
    return {
      mutationAuthorizationId: record.mutationAuthorizationId,
      type: "MUTATION_AUTHORIZATION"
    };
  }
  if (
    record.ownerType === "INBOUND_MCP_REQUEST" &&
    record.inboundMcpRequestId &&
    record.memoryJobId === null &&
    record.retrievalAttemptId === null &&
    record.modelRunId === null &&
    record.modelRunToolCallId === null &&
    record.mutationAuthorizationId === null
  ) {
    return {
      inboundMcpRequestId: record.inboundMcpRequestId,
      type: "INBOUND_MCP_REQUEST"
    };
  }
  return memoryExecutionFailure("memory_execution_snapshot_invalid");
}
