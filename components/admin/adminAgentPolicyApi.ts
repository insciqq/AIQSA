import { decodeAgentPolicy, type AgentPolicyValues, type AgentPolicyWire } from "@/lib/contracts/agentPolicy";

type Result = { ok: true; policy: AgentPolicyWire } | { ok: false; error: string };

export async function requestAgentPolicy(input: Readonly<{
  signal?: AbortSignal;
  update?: AgentPolicyValues & { expectedVersion: number };
}>, fetcher: typeof fetch = fetch): Promise<Result> {
  try {
    const response = await fetcher("/api/admin/workspace/agent", {
      method: input.update ? "PATCH" : "GET", cache: "no-store", credentials: "same-origin", signal: input.signal,
      ...(input.update ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input.update) } : {})
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: typeof value?.error === "string" ? value.error : "agent_policy_action_failed" };
    const policy = decodeAgentPolicy(value?.agent);
    return policy ? { ok: true, policy } : { ok: false, error: "agent_policy_action_failed" };
  } catch { return { ok: false, error: "network_error" }; }
}

export function agentPolicyErrorMessage(code: string): string {
  if (code === "agent_policy_stale") return "Agent settings changed in another session. Your edits were kept. Review the saved values before saving again.";
  if (code === "unauthorized" || code === "forbidden") return "Your session can no longer manage Agent settings.";
  if (code === "agent_policy_input_invalid") return "Check the Agent limits and try again.";
  return "Agent settings could not be reached. Your edits were kept.";
}
