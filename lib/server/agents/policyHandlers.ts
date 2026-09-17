import { decodeAgentPolicy } from "@/lib/contracts/agentPolicy";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type { AgentPolicyRepository } from "./policyRepository";

export function createAgentPolicyHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  repository: AgentPolicyRepository;
}>) {
  const reply = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { "cache-control": "private, no-store" }
  });
  async function handle(request: Request, update: boolean) {
    const auth = await input.resolveAuth(request);
    if (!auth) return reply({ error: "unauthorized" }, 401);
    if (auth.user.status !== "active" || auth.user.role !== "admin") return reply({ error: "forbidden" }, 403);
    try {
      if (!update) return reply({ agent: await input.repository.read() });
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json" && !contentType?.endsWith("+json")) return reply({ error: "json_required" }, 415);
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) return bodyError;
      if (!value || typeof value !== "object" || Array.isArray(value)) return reply({ error: "agent_policy_input_invalid" }, 400);
      const { expectedVersion, ...values } = value as Record<string, unknown>;
      const policy = decodeAgentPolicy({ ...values, version: expectedVersion });
      if (!policy || "version" in values) return reply({ error: "agent_policy_input_invalid" }, 400);
      const { version, ...settings } = policy;
      const saved = await input.repository.update({ ...settings, expectedVersion: version, userId: auth.userId });
      return saved ? reply({ agent: saved }) : reply({ error: "agent_policy_stale" }, 409);
    } catch {
      console.error("agent_policy_action_failed");
      return reply({ error: "agent_policy_action_failed" }, 503);
    }
  }
  return { GET: (request: Request) => handle(request, false), PATCH: (request: Request) => handle(request, true) };
}
