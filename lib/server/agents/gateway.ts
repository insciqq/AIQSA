import { prisma } from "../prisma";
import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import type { NormalizedRunRequest } from "../providers/types";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { agentTokenHash, createAgentRunStore } from "./store";
import { createAgentModelGateway } from "./modelGateway";
import { createAgentSearchGateway } from "./searchGateway";
import { createAgentMcpGateway } from "./mcpGateway";
import { validNormalizedAgent, type NormalizedRunAgent } from "./config";
import { agentFailureCode } from "./failures";
import { withRunnerGatewayLease } from "../workspace/runnerGatewayLease";
import { runWithContext } from "../observability";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { usageAttributionsWithEstimatedCost } from "../runs/runFinalization";
import type { RunnerGatewayBearerHandler } from "../workspace/runnerGateway";

const refused = () => Response.json({ error: "agent_authorization_required" }, { status: 401 });

/**
 * The Agent's share of the runner gateway (`handleRunnerGatewayRequest`
 * checks the relay proof first). Works across app/worker processes. Requests
 * never extend the executor's lease. Null means the bearer is no Agent grant,
 * so the runner gateway may still serve it as a Workspace code grant.
 */
export const handleAgentGatewayRequest: RunnerGatewayBearerHandler = async (request, path, token) => {
  try {
    const tokenHash = agentTokenHash(token);
    const binding = await prisma.agentRunBinding.findUnique({ where: { tokenHash },
      include: { workspaceRun: { include: { modelRun: { select: { userId: true, normalizedRequest: true } } } } } });
    if (!binding) return null;
    const normalized = binding.workspaceRun.modelRun.normalizedRequest as unknown as NormalizedRunRequest;
    const configuration = binding.configuration as unknown as NormalizedRunAgent;
    if (!normalized?.agent || !validNormalizedAgent(configuration) ||
      hashCanonicalMcpValue(normalized.agent) !== hashCanonicalMcpValue(configuration)) throw new Error("denied");
    const userId = binding.workspaceRun.modelRun.userId;
    const store = createAgentRunStore(prisma, { runId: binding.modelRunId, userId, configuration, tokenHash });
    await store.assertActive();
    const onFailure = async (code: string) => {
      await store.fail(agentFailureCode(code) ?? "agent_execution_interrupted");
      await store.revoke(false);
    };
    // Persist accounting independently of the executor process. In particular,
    // a cancelled/crashed turn can still receive a provider's final receipt.
    const repository = createPrismaRunRepository(prisma);
    const onUsage = async () => {
      await repository.recordRunUsageEvents({ runId: binding.modelRunId, userId,
        chatId: normalized.chatId,
        usageAttributions: await usageAttributionsWithEstimatedCost(repository, await store.usage()) });
    };
    if (request.method === "POST" && (path === "v1/responses" || path === "v1/alpha/search")) {
      const runtime = await providerRuntimeResolver.resolve(binding.modelRunId, "answer");
      if (!runtime.agentResponses || runtime.agentResponses.snapshot.model.upstreamModelId !== normalized.modelId) throw new Error("denied");
      const transport = runtime.agentResponses;
      const createGateway = path === "v1/alpha/search" ? createAgentSearchGateway : createAgentModelGateway;
      return await runWithContext({ run_id: binding.modelRunId, user_id: userId }, () => withRunnerGatewayLease(request, store.assertLeaseActive, (signal) =>
        createGateway({ configuration, transport, store, signal, onFailure, onUsage })(request)));
    }
    if (request.method === "POST" && path === "mcp") {
      return await runWithContext({ user_id: userId }, () => withRunnerGatewayLease(request, store.assertLeaseActive, async (signal) => {
        const handler = await createAgentMcpGateway({ request: normalized, runId: binding.modelRunId, store, userId,
          incarnation: tokenHash, signal, onFailure, onUsage });
        return handler(request);
      }));
    }
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  } catch {
    return refused();
  }
};
