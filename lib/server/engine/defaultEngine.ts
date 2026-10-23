import type { PrismaClient } from "@prisma/client";
import { MCP_APPROVAL_TTL_MS } from "../mcp/writeApproval";
import { prisma } from "../prisma";
import { defaultToolObservations } from "../toolObservations/defaultService";
import type { StorageAdapter } from "../uploads/storage";
import type { NativeEngineDeps } from "./execution";
import { engineTestFaults } from "./faults";
import { createNativeRunStore } from "./runStore";
import { createToolCallStore } from "./toolCallStore";
import { createSavedToolResultReader } from "./toolResults";
import { createTranscriptRepository } from "./transcriptRepository";

/**
 * The call an approval continuation sends: the initiator's own Allow in this
 * chat, decided within the approval window and not yet used, with the
 * refused call it allows.
 */
export async function loadApprovedCall(
  client: Pick<PrismaClient, "mcpToolApproval">,
  input: Readonly<{ approvalId: string; chatId: string; userId: string }>,
  now = new Date()
): Promise<Readonly<{ providerCallId: string; toolName: string }> | null> {
  const row = await client.mcpToolApproval.findFirst({
    select: { toolCall: { select: { providerCallId: true, toolName: true } } },
    where: { chatId: input.chatId, consumedAt: null, decidedAt: { gt: new Date(now.getTime() - MCP_APPROVAL_TTL_MS) },
      decision: { in: ["allow_once", "allow_server"] }, id: input.approvalId, userId: input.userId }
  });
  return row?.toolCall ? { providerCallId: row.toolCall.providerCallId, toolName: row.toolCall.toolName } : null;
}

/** The engine's stores on the installation database and object storage. */
export function defaultNativeEngineDeps(storage: StorageAdapter, client: PrismaClient = prisma): NativeEngineDeps {
  let observations: ReturnType<typeof defaultToolObservations> | null = null;
  return {
    approvedCall: (input) => loadApprovedCall(client, input),
    faults: () => engineTestFaults(process.env),
    mcpBindingRows: (runId) => client.mcpRunBinding.findMany({
      select: { id: true, runtimeGenerationFingerprint: true, runtimeGenerationId: true }, where: { modelRunId: runId }
    }),
    observations: () => observations ??= defaultToolObservations(),
    runs: createNativeRunStore(client),
    savedResults: createSavedToolResultReader({ prisma: client, storage }),
    toolCalls: createToolCallStore(client),
    transcripts: createTranscriptRepository(client)
  };
}
