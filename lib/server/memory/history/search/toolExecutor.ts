import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decodeMemoryHistorySearchInput,
  type MemoryHistorySearchInput,
  type MemoryHistorySearchResponse
} from "../../../../contracts/memory";
import type {
  ModelToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from "../../../tools/types";
import { prisma } from "../../../prisma";
import { memorySha256 } from "../../persistence/lexical";
import type { MemoryHistorySearchService } from "./service";
import {
  MEMORY_HISTORY_SEARCH_MAX_CALLS,
  MEMORY_HISTORY_SEARCH_TOOL_NAME,
  memoryHistorySearchTool
} from "./tool";

const HISTORY_PROVIDER_RESULT_MAX_BYTES = 256 * 1024;

type HistoryReceipt = Readonly<{
  created: boolean;
  id: string;
  providerResult: Prisma.JsonValue | null;
  retentionState: "RETAINED" | "SCRUBBED";
  state: "RUNNING" | "COMPLETE" | "ERROR" | "CANCELLED";
}>;

export type MemoryHistoryToolExecutor = Readonly<{
  accepts(toolName: string): boolean;
  execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  tool: typeof memoryHistorySearchTool;
}>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function decodeToolInput(value: Record<string, unknown>): MemoryHistorySearchInput | null {
  if (!exactKeys(value, ["query", "time_range", "chat_ids", "folder_id", "cursor"])) {
    return null;
  }
  const range = value.time_range;
  if (
    range !== undefined &&
    range !== null &&
    (typeof range !== "object" || Array.isArray(range) ||
      !exactKeys(range as Record<string, unknown>, ["from", "to"]))
  ) {
    return null;
  }
  const timeRange = (range ?? {}) as Record<string, unknown>;
  const decoded = decodeMemoryHistorySearchInput({
    chatIds: value.chat_ids ?? [],
    cursor: value.cursor ?? null,
    folderId: value.folder_id ?? null,
    from: timeRange.from ?? null,
    pageSize: 20,
    query: value.query,
    to: timeRange.to ?? null
  });
  return decoded.ok ? decoded.value : null;
}

function executionIdentity(context: ToolExecutionContext): Readonly<{
  modelRunId: string;
  persistedToolCallId: string;
  userId: string;
}> {
  if (!context.runId || !context.persistedToolCallId || !context.userId) {
    throw new Error("memory_history_authorization_missing");
  }
  return {
    modelRunId: context.runId,
    persistedToolCallId: context.persistedToolCallId,
    userId: context.userId
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/u.test(error.message)
    ? error.message
    : "memory_action_failed";
}

function failed(call: ModelToolCall, code: string): ToolExecutionResult {
  return {
    callId: call.id,
    content: [{ type: "json", value: { error: code } }],
    name: call.name,
    rawPreview: { error: code, resultType: "private_history" },
    status: "error"
  };
}

function complete(
  call: ModelToolCall,
  response: MemoryHistorySearchResponse
): ToolExecutionResult {
  return {
    callId: call.id,
    content: [{
      type: "json",
      value: {
        ...response,
        untrusted: true
      }
    }],
    name: call.name,
    rawPreview: {
      degradationCode: response.indexing.degradationCode,
      hasNextPage: response.nextCursor !== null,
      resultCount: response.results.length,
      resultType: "private_history"
    },
    status: "complete"
  };
}

function parseStoredResult(value: Prisma.JsonValue | null): ToolExecutionResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.callId === "string" && typeof candidate.name === "string" &&
    (candidate.status === "complete" || candidate.status === "error") &&
    Array.isArray(candidate.content)
    ? candidate as ToolExecutionResult
    : null;
}

function boundedProviderResult(value: ToolExecutionResult): Prisma.InputJsonValue {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > HISTORY_PROVIDER_RESULT_MAX_BYTES) {
    throw new Error("memory_history_result_too_large");
  }
  return json(JSON.parse(encoded));
}

function outcome(response: MemoryHistorySearchResponse) {
  if (response.indexing.lexicalState === "DISABLED") return "DISABLED" as const;
  if (response.indexing.degradationCode !== null ||
    response.indexing.lexicalState === "UNAVAILABLE" ||
    response.indexing.vectorState === "DEGRADED") {
    return "DEGRADED" as const;
  }
  return response.results.length > 0 ? "RESULTS" as const : "EMPTY" as const;
}

async function beginReceipt(
  client: PrismaClient,
  identity: ReturnType<typeof executionIdentity>,
  request: MemoryHistorySearchInput
): Promise<HistoryReceipt> {
  return client.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ id: string; userId: string }>>(Prisma.sql`
      SELECT "id", "userId"
      FROM "ModelRun"
      WHERE "id" = ${identity.modelRunId} AND "userId" = ${identity.userId}
      FOR UPDATE
    `);
    if (!runs[0]) throw new Error("memory_history_authorization_missing");
    const call = await tx.modelRunToolCall.findFirst({
      select: { id: true, toolName: true },
      where: {
        id: identity.persistedToolCallId,
        modelRunId: identity.modelRunId
      }
    });
    if (!call || call.toolName !== MEMORY_HISTORY_SEARCH_TOOL_NAME) {
      throw new Error("memory_history_authorization_missing");
    }
    const existing = await tx.memoryHistoryRun.findUnique({
      select: {
        id: true,
        providerResult: true,
        retentionState: true,
        state: true
      },
      where: { modelRunToolCallId: call.id }
    });
    if (existing) return { ...existing, created: false };
    const count = await tx.memoryHistoryRun.count({
      where: { modelRunId: identity.modelRunId }
    });
    if (count >= MEMORY_HISTORY_SEARCH_MAX_CALLS) {
      throw new Error("memory_history_call_limit");
    }
    const created = await tx.memoryHistoryRun.create({
      data: {
        indexingEvidence: {},
        invocationOrdinal: count + 1,
        modelRunId: identity.modelRunId,
        modelRunToolCallId: call.id,
        privateRequest: json(request),
        query: request.query,
        queryHash: memorySha256(request.query),
        userId: identity.userId
      },
      select: {
        id: true,
        providerResult: true,
        retentionState: true,
        state: true
      }
    });
    return { ...created, created: true };
  });
}

async function settleReceipt(input: Readonly<{
  client: PrismaClient;
  durationMs: number;
  identity: ReturnType<typeof executionIdentity>;
  receiptId: string;
  response?: MemoryHistorySearchResponse;
  result: ToolExecutionResult;
}>): Promise<ToolExecutionResult> {
  const stored = boundedProviderResult(input.result);
  const settlement = await input.client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      retentionState: string;
      state: string;
    }>>(Prisma.sql`
      SELECT
        history."id",
        history."retentionState"::text AS "retentionState",
        history."state"::text AS "state"
      FROM "MemoryHistoryRun" AS history
      INNER JOIN "ModelRun" AS run
        ON run."userId" = history."userId" AND run."id" = history."modelRunId"
      WHERE history."id" = ${input.receiptId}
        AND history."userId" = ${input.identity.userId}
        AND history."modelRunId" = ${input.identity.modelRunId}
      FOR UPDATE OF history
    `);
    const row = rows[0];
    if (!row) throw new Error("memory_history_receipt_missing");
    if (row.state !== "RUNNING" || row.retentionState !== "RETAINED") {
      return row.retentionState === "SCRUBBED"
        ? "memory_history_receipt_scrubbed" as const
        : "memory_history_outcome_unknown" as const;
    }
    const now = new Date();
    if (input.response) {
      await tx.memoryHistoryRun.update({
        data: {
          completedAt: now,
          durationMs: input.durationMs,
          indexingEvidence: json(input.response.indexing),
          outcome: outcome(input.response),
          providerResult: stored,
          resultCount: input.response.results.length,
          resultHash: memorySha256(input.result),
          results: json(input.response),
          state: "COMPLETE"
        },
        where: { id: input.receiptId }
      });
      return "settled" as const;
    }
    const code = String((input.result.content[0] as { value?: { error?: unknown } } | undefined)
      ?.value?.error ?? "memory_action_failed");
    await tx.memoryHistoryRun.update({
      data: {
        completedAt: now,
        durationMs: input.durationMs,
        errorCode: /^[A-Za-z0-9._-]{1,128}$/u.test(code) ? code : "memory_action_failed",
        outcome: "FAILED",
        providerResult: stored,
        resultHash: memorySha256(input.result),
        state: "ERROR"
      },
      where: { id: input.receiptId }
    });
    return "settled" as const;
  });
  return settlement === "settled"
    ? input.result
    : {
        callId: input.result.callId,
        content: [{ type: "json", value: { error: settlement } }],
        name: input.result.name,
        rawPreview: { error: settlement, resultType: "private_history" },
        status: "error"
      };
}

export function createMemoryHistoryToolExecutor(input: Readonly<{
  client?: PrismaClient;
  service: MemoryHistorySearchService;
}>): MemoryHistoryToolExecutor {
  const client = input.client ?? prisma;
  return Object.freeze({
    accepts(toolName) {
      return toolName === MEMORY_HISTORY_SEARCH_TOOL_NAME;
    },
    async execute(call, context) {
      if (call.name !== MEMORY_HISTORY_SEARCH_TOOL_NAME) {
        return failed(call, "memory_history_tool_invalid");
      }
      const request = decodeToolInput(call.arguments);
      if (!request) return failed(call, "memory_contract_invalid");
      let identity: ReturnType<typeof executionIdentity>;
      try {
        identity = executionIdentity(context);
      } catch (error) {
        return failed(call, errorCode(error));
      }
      let receipt: HistoryReceipt;
      try {
        receipt = await beginReceipt(client, identity, request);
      } catch (error) {
        return failed(call, errorCode(error));
      }
      if (!receipt.created && receipt.state === "RUNNING") {
        return failed(call, "memory_history_outcome_unknown");
      }
      if (receipt.retentionState === "RETAINED" && receipt.state !== "RUNNING") {
        return parseStoredResult(receipt.providerResult) ??
          failed(call, "memory_history_result_invalid");
      }
      if (receipt.state !== "RUNNING") {
        return failed(call, "memory_history_receipt_scrubbed");
      }
      const startedAt = Date.now();
      let response: MemoryHistorySearchResponse;
      try {
        response = await input.service.search(identity.userId, request);
      } catch (error) {
        const result = failed(call, errorCode(error));
        return settleReceipt({
          client,
          durationMs: Date.now() - startedAt,
          identity,
          receiptId: receipt.id,
          result
        });
      }
      const result = complete(call, response);
      return settleReceipt({
        client,
        durationMs: Date.now() - startedAt,
        identity,
        receiptId: receipt.id,
        response,
        result
      });
    },
    tool: memoryHistorySearchTool
  });
}
