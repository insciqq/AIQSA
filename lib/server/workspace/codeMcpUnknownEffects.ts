import { Prisma, type PrismaClient } from "@prisma/client";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import type { McpApprovalCallKey } from "../mcp/writeApproval";
import type { WorkspaceCodeGatewayGrant } from "./codeMcpStore";

/** The existing content-free receipt binds the definition as well as the arguments before dispatch. */
export function codeMcpEffectDigest(key: McpApprovalCallKey): string {
  return hashCanonicalMcpValue({ version: "mcp-effect-v1", definitionHash: key.definitionHash, argumentsDigest: key.argumentsDigest });
}

export type CodeMcpUnknownEffectInput = Readonly<{ callId: string; grant: WorkspaceCodeGatewayGrant; key: McpApprovalCallKey }>;

/**
 * Serialized with other code claims. An earlier identical call still in flight is uncertain too;
 * it must not race a second dispatch. Branch ancestors (including copied source runs), never
 * sibling answers or other users' runs, carry unknown effects into the next turn.
 */
export async function bindCodeMcpEffect(db: Pick<PrismaClient, "$transaction">, input: CodeMcpUnknownEffectInput): Promise<Date | null> {
  const { grant, key } = input;
  const digest = codeMcpEffectDigest(key);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "modelRunId" FROM "WorkspaceCodeGrant" WHERE "modelRunId" = ${grant.runId} FOR UPDATE`;
    const receipt = await tx.workspaceCodeCall.updateMany({ where: { id: input.callId, modelRunId: grant.runId, state: "dispatching",
      serverId: key.serverId, toolName: key.toolName }, data: { argumentHash: digest } });
    if (receipt.count !== 1) throw new Error("code_mcp_receipt_closed");
    const [result] = await tx.$queryRaw<Array<{ scopeValid: boolean; unknownAfter: Date | null }>>(Prisma.sql`
      WITH RECURSIVE scope AS (
        SELECT r."id", r."chatId", r."userMessageId" FROM "ModelRun" r JOIN "Chat" c ON c."id" = r."chatId"
        WHERE r."id" = ${grant.runId} AND r."userId" = ${grant.userId} AND c."id" = ${grant.chatId}
          AND c."userId" = ${grant.userId} AND c."permanentDeletionAt" IS NULL
      ), branch AS (
        SELECT m."id", m."chatId", m."parentMessageId", m."branchSourceModelRunId", ARRAY[m."id"]::text[] AS visited
        FROM "Message" m JOIN scope r ON m."chatId" = r."chatId" AND m."id" = r."userMessageId"
        UNION ALL
        SELECT m."id", m."chatId", m."parentMessageId", m."branchSourceModelRunId", b.visited || m."id"
        FROM "Message" m JOIN branch b ON m."chatId" = b."chatId" AND m."id" = b."parentMessageId"
        WHERE NOT m."id" = ANY(b.visited)
      ), relevant AS (
        SELECT "id" FROM scope
        UNION
        SELECT r."id" FROM "ModelRun" r JOIN branch b
          ON r."assistantMessageId" = b."id" OR r."id" = b."branchSourceModelRunId"
        JOIN "Chat" c ON c."id" = r."chatId"
        WHERE r."userId" = ${grant.userId} AND c."userId" = ${grant.userId} AND c."permanentDeletionAt" IS NULL
      )
      SELECT EXISTS(SELECT 1 FROM scope) AS "scopeValid",
        (SELECT max(COALESCE(prior."settledAt", prior."createdAt")) FROM "WorkspaceCodeCall" prior
          JOIN relevant r ON r."id" = prior."modelRunId"
          JOIN "WorkspaceCodeCall" current ON current."id" = ${input.callId} AND current."modelRunId" = ${grant.runId}
          WHERE prior."serverId" = ${key.serverId} AND prior."toolName" = ${key.toolName}
            -- Old receipts have only the arguments digest: their unknown definition cannot authorize a retry.
            AND prior."argumentHash" IN (${digest}, ${key.argumentsDigest})
            AND prior."state" IN ('unknown', 'dispatching')
            AND (prior."modelRunId" <> current."modelRunId" OR prior."sequence" < current."sequence")
        ) AS "unknownAfter"
    `);
    if (!result?.scopeValid) throw new Error("code_mcp_scope_unavailable");
    return result.unknownAfter;
  });
}
