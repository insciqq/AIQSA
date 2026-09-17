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
import { withAgentLease } from "./lease";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { usageAttributionsWithEstimatedCost } from "../runs/runFinalization";

/** Works across app/worker processes. Requests never extend the executor's lease. */
export async function handleAgentGatewayRequest(request: Request, path: string): Promise<Response> {
  const auth = request.headers.get("authorization");
  const token = auth?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/u)?.[1];
  if (!token || request.headers.has("origin")) return Response.json({ error: "agent_authorization_required" }, { status: 401 });
  try {
    const binding = await prisma.agentRunBinding.findUnique({ where: { tokenHash: agentTokenHash(token) },
      include: { workspaceRun: { include: { modelRun: { select: { userId: true, normalizedRequest: true } } } } } });
    if (!binding) throw new Error("denied");
    const normalized = binding.workspaceRun.modelRun.normalizedRequest as unknown as NormalizedRunRequest;
    const configuration = binding.configuration as unknown as NormalizedRunAgent;
    if (!normalized?.agent || !validNormalizedAgent(configuration) ||
      hashCanonicalMcpValue(normalized.agent) !== hashCanonicalMcpValue(configuration)) throw new Error("denied");
    const userId = binding.workspaceRun.modelRun.userId;
    const store = createAgentRunStore(prisma, { runId: binding.modelRunId, userId, configuration });
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
      return await withAgentLease(request, store.assertActive, (signal) =>
        createGateway({ configuration, transport, store, signal, onFailure, onUsage })(request));
    }
    if (request.method === "POST" && path === "mcp") {
      return await withAgentLease(request, store.assertActive, async (signal) => {
        const handler = await createAgentMcpGateway({ request: normalized, runId: binding.modelRunId, store, userId,
          signal, onFailure, onUsage });
        return handler(request);
      });
    }
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  } catch {
    return Response.json({ error: "agent_authorization_required" }, { status: 401 });
  }
}
