const messages = {
  agent_model_call_limit: "Agent stopped because the provider call limit for this turn was reached.",
  agent_mcp_call_limit: "The MCP call limit for this turn was reached. Finish using the results already available.",
  agent_mcp_outcome_unknown: "Agent stopped because an MCP tool call was interrupted and its outcome could not be confirmed. Check the connected service before repeating that action.",
  agent_token_limit: "Agent stopped because the token budget for this turn was reached.",
  agent_time_limit: "Agent stopped because the time limit for this turn was reached.",
  agent_generation_output_limit: "The model stopped because its output token limit was reached.",
  agent_provider_failed: "The admitted model request could not complete.",
  agent_search_failed: "The admitted search request could not complete.",
  agent_provider_interrupted: "The model request was interrupted.",
  agent_authority_expired: "Agent execution was interrupted because its workspace authorization expired.",
  agent_execution_interrupted: "Agent execution was interrupted. Its unfinished actions were not replayed."
} as const;

export type AgentFailureCode = keyof typeof messages;
export function agentFailureCode(value: unknown): AgentFailureCode | null {
  const code = value instanceof Error ? value.message : value;
  return typeof code === "string" && Object.hasOwn(messages, code) ? code as AgentFailureCode : null;
}
export function agentFailureMessage(code: AgentFailureCode): string { return messages[code]; }
export class AgentExecutionError extends Error {
  constructor(readonly code: AgentFailureCode) { super(code); this.name = "AgentExecutionError"; }
}
