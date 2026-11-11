import type { ThreadArtifactSummary } from "../../contracts/chats";
import { decodeRunOutcomeResponse } from "../../contracts/runs";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { NATIVE_RUN_STALE_MS } from "../engine/recovery";
import { kickDefaultMcpRuntime } from "../mcp/defaultRuntime";
import { prisma } from "../prisma";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { createGetModelRunHandler, createSendMessageHandler, stopModelRun } from "../runs/handlers";
import { createPrismaRunFollowupOperations } from "../runs/prismaRepositoryFollowups";
import { createRunFollowupHandler } from "../runs/runFollowupHandler";
import type { ConnectorRunGateway } from "./runGateway";
import type { ConnectorTurn } from "./turn";

/**
 * A connector's run operations in this process, through the product's own
 * handlers exactly as the browser reaches them (and as scheduled tasks admit
 * their runs): a synthetic request as the connector's user, whose resolver
 * (`auth`) re-reads the account and the connector's access on every call. Its
 * sends are the connector's turns (`connectorTurn`), whose rules the server
 * applies whatever their bodies say (`lib/server/connectors/turn.ts`).
 */

/** A request to one of the product's routes, for its handler in this process. */
export function connectorInternalRequest(path: string, method: "GET" | "POST", body?: unknown): Request {
  return new Request(`http://localhost${path}`, body === undefined ? { method } : {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method
  });
}

export function createDefaultConnectorRunGateway(deps: Readonly<{
  connectorTurn: ConnectorTurn;
  /** The connector's user while the account is active and the connector serves them, re-read on every call. */
  auth(userId: string): RequestAuthResolver;
}>): ConnectorRunGateway {
  const sendDeps = createDefaultSendMessageDeps();
  const followups = createPrismaRunFollowupOperations(prisma);

  return Object.freeze({
    async chat(userId: string, chatId: string) {
      const chat = await sendDeps.repository.findOwnedChat(chatId, userId);
      if (!chat) return null;
      return {
        activeLeafMessageId: chat.activeLeafMessageId, assistantId: chat.assistantId ?? null, id: chat.id,
        memoryMode: chat.memoryMode ?? "NORMAL", model: { modelId: chat.defaultModelId, provider: chat.defaultProvider }, title: chat.title
      };
    },

    async send({ body, chatId, userId }) {
      // As a browser session does, the user's MCP runtime is woken for the run.
      kickDefaultMcpRuntime(userId);
      return createSendMessageHandler({ ...sendDeps, connectorTurn: deps.connectorTurn, resolveAuth: deps.auth(userId) })(
        connectorInternalRequest(`/api/chats/${encodeURIComponent(chatId)}/messages`, "POST", body), { params: { chatId } }
      );
    },

    async followup({ assistantMessageId, chatId, nonce, runId, text, userId }) {
      return createRunFollowupHandler({ followups, resolveAuth: deps.auth(userId) })(
        connectorInternalRequest(`/api/model-runs/${encodeURIComponent(runId)}/followups`, "POST", { assistantMessageId, chatId, nonce, text }),
        { params: { runId } }
      );
    },

    stop: ({ runId, userId }) => stopModelRun(sendDeps, {
      payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId, userId
    }),

    async runState({ runId, userId }) {
      try {
        const response = await createGetModelRunHandler({ ...sendDeps, resolveAuth: deps.auth(userId) })(
          connectorInternalRequest(`/api/model-runs/${encodeURIComponent(runId)}`, "GET"), { params: { runId } }
        );
        if (response.status === 401 || response.status === 404) return null;
        const outcome = response.ok ? decodeRunOutcomeResponse(await response.json()) : null;
        return { status: outcome?.status ?? "unknown" };
      } catch {
        // A run still being prepared cannot be projected yet.
        return { status: "preparing" };
      }
    },

    async answer({ runId, userId }) {
      const control = await sendDeps.repository.getRunControlForUser(runId, userId);
      if (!control?.assistantMessageId) return null;
      const update = await sendDeps.repository.getChatUpdateForRun({
        assistantMessageId: control.assistantMessageId, chatId: control.chatId, userId, userMessageId: control.assistantMessageId
      });
      const message = update?.messages.find((entry) => entry.id === control.assistantMessageId);
      if (!message) return null;
      const status = control.status === "complete" || control.status === "cancelled" || control.status === "error"
        ? control.status : "streaming";
      return {
        artifactSummary: (message.artifactSummary ?? null) as ThreadArtifactSummary | null,
        assistantMessageId: message.id,
        chatId: control.chatId,
        errorMessage: message.errorMessage ?? null,
        status,
        text: textFromContentBlocks(message.content as { blocks?: unknown[] })
      };
    },

    async activeRun({ chatId, userId }) {
      const run = await sendDeps.repository.findRecentActiveRunForChat({ chatId, since: new Date(Date.now() - NATIVE_RUN_STALE_MS), userId });
      return run ? { runId: run.id } : null;
    }
  } satisfies ConnectorRunGateway);
}
