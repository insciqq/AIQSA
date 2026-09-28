import type { PrismaClient } from "@prisma/client";
import { decodeMemoryCommandFeedback, type MemoryCommandFeedback, type MemoryCommandListResponse } from "../../../contracts/memoryCommand";
import { memorySha256 } from "../persistence/lexical";

type CommandProjectionRow = Readonly<{
  id: string;
  commandOperation: string | null;
  commandStatus: string | null;
  state: string;
  updatedAt: Date;
}>;

const projectionSelect = {
  id: true, commandOperation: true, commandStatus: true, state: true, updatedAt: true
} as const;

function projectCommand(userId: string, job: CommandProjectionRow): MemoryCommandFeedback | null {
  if (!job.commandStatus || !job.commandOperation) return null;
  const status = job.commandStatus === "PENDING" || job.commandStatus === "RUNNING"
    ? job.state === "CLAIMED" ? "RUNNING"
      : job.state === "STALE" || job.state === "CANCELLED" ? "STALE"
      : job.state === "TERMINAL_FAILED" ? "FAILED"
      : job.state === "SUCCEEDED" ? "UNKNOWN"
      : "PENDING"
    : job.commandStatus;
  return decodeMemoryCommandFeedback({
    commandRef: `mc1.${memorySha256({ jobId: job.id, userId })}`,
    operation: job.commandOperation, status, updatedAt: job.updatedAt.toISOString()
  });
}

/** Chat access is rechecked at every poll. Status never reads source content,
 * targets or classifier checkpoints and never updates immutable run artifacts. */
export async function listChatMemoryCommands(
  client: Pick<PrismaClient, "chat" | "memoryJob">,
  input: Readonly<{ userId: string; chatId: string }>
): Promise<MemoryCommandListResponse | null> {
  const chat = await client.chat.findFirst({
    select: { id: true },
    where: { id: input.chatId, userId: input.userId, projectId: null,
      memoryMode: "NORMAL", permanentDeletionAt: null }
  });
  if (!chat) return null;
  const jobs = await client.memoryJob.findMany({
    orderBy: { commandSequence: "desc" }, take: 100,
    select: { ...projectionSelect, sourceMessageId: true },
    where: { userId: input.userId, chatId: input.chatId, kind: "MEMORY_COMMAND" }
  });
  const seen = new Set<string>();
  const commands: MemoryCommandListResponse["commands"] = [];
  for (const job of jobs) {
    if (!job.sourceMessageId || seen.has(job.sourceMessageId)) continue;
    seen.add(job.sourceMessageId);
    const feedback = projectCommand(input.userId, job);
    if (feedback) commands.push({ feedback, messageId: job.sourceMessageId });
  }
  return { commands };
}
